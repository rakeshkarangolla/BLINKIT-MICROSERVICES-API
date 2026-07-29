# Blinkit on AKS — Manifest Index, Deploy Order, Validation, Blue/Green

This folder contains plain Kubernetes YAML for the entire Blinkit platform.
No Helm, no Kustomize, no GitOps — every manifest is `kubectl apply -f`-able.

---

## 1. Final folder structure

```
K8S/
├── namespace.yaml
├── configmaps/
│   └── platform-config.yaml          # shared service URLs + Redis aliases
├── secrets/
│   ├── README.md                     # how to wire real secrets / Key Vault
│   ├── auth-secret.example.yaml
│   ├── product-secret.example.yaml
│   ├── cart-secret.example.yaml
│   ├── order-secret.example.yaml
│   ├── payment-secret.example.yaml
│   ├── api-gateway-secret.example.yaml
│   └── ai-recommendation-secret.example.yaml
├── redis/
│   ├── redis-deployment.yaml
│   └── redis-service.yaml
├── aut-service/                      # (existing folder name kept as-is)
│   ├── auth-deployment.yaml
│   └── auth-service.yaml
├── product-service/
│   ├── product-deployment.yaml
│   └── product-service.yaml
├── cart-service/
│   ├── cart-deployment.yaml
│   └── cart-service.yaml
├── order-service/
│   ├── order-deployment.yaml
│   └── order-service.yaml
├── payment-service/
│   ├── payment-deployment.yaml
│   └── payment-service.yaml
├── api-gateway/
│   ├── api-gateway-deployment.yaml
│   └── api-gateway-service.yaml
├── ai-recommendation-service/
│   ├── ai-recommendation-deployment.yaml
│   └── ai-recommendation-service.yaml
├── frontend/
│   ├── frontend-deployment.yaml
│   └── frontend-service.yaml
└── ingress/
    └── ingress.yaml
```

---

## 2. What was fixed in this stabilisation pass

| # | Issue | Where it lived | Fix |
|---|---|---|---|
| 1 | `/actuator/health/liveness` returned 401 | `product-service/.../config/SecurityConfig.java` | `permitAll()` for `/actuator/**` (was `/actuator/health, /actuator/info`) |
| 2 | Kubelet-injected `REDIS_PORT=tcp://...` clobbered the integer fallback | every pod | `enableServiceLinks: false` on every pod + explicit `REDIS_*` env values |
| 3 | Liveness == readiness on existing services | every JVM deployment | Split to `/actuator/health/liveness` and `/actuator/health/readiness` (Spring Boot LivenessState/ReadinessState already enabled in app.yml) |
| 4 | No startup probe — slow JVM cold starts looked like crashes | every JVM deployment | Added `startupProbe` with up to ~5 min budget so liveness can stay tight afterwards |
| 5 | No rolling-update strategy | every deployment | `RollingUpdate` with `maxSurge=1, maxUnavailable=0` (zero-downtime rollouts) |
| 6 | Env scattered, hard to repoint | every deployment | Centralised non-secret env in `configmaps/platform-config.yaml` |
| 7 | `JAVA_OPTS` not set — JVM picked container memory wrong | every JVM deployment | `-XX:MaxRAMPercentage=75` so heap grows with the limit |

---

## 3. Order of deployment (cold cluster)

Run from the workspace root.

```powershell
# 0. Sanity — pointed at the right cluster?
kubectl config current-context
kubectl get nodes

# 1. Namespace
kubectl apply -f K8S/namespace.yaml

# 2. ACR pull secret (one-time — see K8S/secrets/README.md)
kubectl create secret docker-registry acr-secret `
  --namespace blinkit `
  --docker-server=blinkitaiacr.azurecr.io `
  --docker-username=<acr-username> `
  --docker-password=<acr-password>

# 3. ConfigMap + per-service Secrets
kubectl apply -f K8S/configmaps/
# Copy each *-secret.example.yaml -> *-secret.yaml, fill in real values, then:
kubectl apply -f K8S/secrets/auth-secret.yaml
kubectl apply -f K8S/secrets/product-secret.yaml
kubectl apply -f K8S/secrets/cart-secret.yaml
kubectl apply -f K8S/secrets/order-secret.yaml
kubectl apply -f K8S/secrets/payment-secret.yaml
kubectl apply -f K8S/secrets/api-gateway-secret.yaml
kubectl apply -f K8S/secrets/ai-recommendation-secret.yaml

# 4. Data layer (Redis only — Postgres is Azure-managed and already exists)
kubectl apply -f K8S/redis/

# 5. Backend services (order matters only for first-roll readiness)
kubectl apply -f K8S/aut-service/
kubectl apply -f K8S/product-service/
kubectl apply -f K8S/cart-service/
kubectl apply -f K8S/order-service/
kubectl apply -f K8S/payment-service/
kubectl apply -f K8S/ai-recommendation-service/

# 6. Edge
kubectl apply -f K8S/api-gateway/
kubectl apply -f K8S/frontend/

# 7. Ingress (assumes ingress-nginx is installed in the cluster)
kubectl apply -f K8S/ingress/
```

---

## 4. Verification commands

```powershell
# Pod status — all must be 1/1 Running
kubectl get pods -n blinkit -o wide

# Watch a slow starter (AI service) come up
kubectl get pods -n blinkit -l app=ai-recommendation-service -w

# Probe a single pod's readiness directly
kubectl exec -n blinkit deploy/product-service -- `
  wget -qO- http://localhost:8082/actuator/health/readiness

# Service-to-service DNS sanity check
kubectl exec -n blinkit deploy/cart-service -- `
  wget -qO- http://product-service:8082/actuator/health/readiness

# Redis reachable from a backend pod
kubectl exec -n blinkit deploy/product-service -- `
  sh -c 'apk add --no-cache redis 2>/dev/null; redis-cli -h redis ping'

# Tail logs while you exercise the app
kubectl logs -n blinkit -l app=api-gateway --tail=200 -f

# Public endpoint (Ingress controller external IP)
kubectl get ingress -n blinkit blinkit-ingress
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

If any pod is `0/1 Running` or `CrashLoopBackOff`:

```powershell
kubectl describe pod -n blinkit <pod-name>
kubectl logs -n blinkit <pod-name> --previous
```

---

## 5. Blue/green deployment with plain manifests

Pattern: deploy a parallel `*-green` Deployment with the same labels EXCEPT
a `version` label, then flip the Service selector once green is ready.

### One-time prep — add a version label to the live Service

Edit `K8S/product-service/product-service.yaml` and add `version: blue` to
the selector:

```yaml
spec:
  selector:
    app: product-service
    version: blue
```

Apply once. The existing Deployment also needs `version: blue` in its pod
template labels. After that, the Service points at the blue pods only.

### Roll a green release

```powershell
# 1. Copy the deployment manifest, rename to product-deployment-green.yaml,
#    change name -> product-service-green and version label -> green.
kubectl apply -f K8S/product-service/product-deployment-green.yaml

# 2. Wait for green to become Ready
kubectl rollout status deploy/product-service-green -n blinkit
kubectl get pods -n blinkit -l app=product-service,version=green

# 3. Smoke-test green directly via a temporary debug pod
kubectl run smoketest --rm -it --image=curlimages/curl -n blinkit -- `
  curl -sf http://product-service-green:8082/actuator/health/readiness

# 4. Cut traffic — patch the Service selector to version=green
kubectl patch svc product-service -n blinkit `
  -p '{"spec":{"selector":{"app":"product-service","version":"green"}}}'

# 5. Watch live traffic / errors for a few minutes
kubectl logs -n blinkit -l app=product-service,version=green --tail=200 -f

# 6a. If happy — scale down blue
kubectl scale deploy/product-service -n blinkit --replicas=0

# 6b. If unhappy — instant rollback (flip selector back)
kubectl patch svc product-service -n blinkit `
  -p '{"spec":{"selector":{"app":"product-service","version":"blue"}}}'
```

The same recipe works for any service. For the frontend, point the Ingress
at `frontend-green` instead of `frontend` to flip user traffic.

### Rolling-update / scale / pod replacement (without blue/green)

```powershell
# Trigger a rolling update by re-pulling the image (immutable :latest is fine
# because imagePullPolicy: Always)
kubectl rollout restart deploy/product-service -n blinkit
kubectl rollout status   deploy/product-service -n blinkit

# Scale up / down
kubectl scale deploy/product-service -n blinkit --replicas=3

# Force-replace a single pod (kubelet recreates it)
kubectl delete pod -n blinkit <pod-name>
```

---

## 6. Rollback commands

```powershell
# History
kubectl rollout history deploy/product-service -n blinkit

# Roll back to previous revision
kubectl rollout undo deploy/product-service -n blinkit

# Roll back to a specific revision
kubectl rollout undo deploy/product-service -n blinkit --to-revision=3

# Pause / resume a bad rollout mid-flight
kubectl rollout pause  deploy/product-service -n blinkit
kubectl rollout resume deploy/product-service -n blinkit
```

---

## 7. Final validation checklist

Before declaring "done":

- [ ] `kubectl get pods -n blinkit` shows every pod `1/1 Running`
- [ ] `kubectl get svc -n blinkit` shows ClusterIPs for every service
- [ ] `kubectl get ingress -n blinkit` shows an external `ADDRESS`
- [ ] `kubectl exec deploy/product-service -- wget -qO- http://localhost:8082/actuator/health/readiness` returns `{"status":"UP"...}`
- [ ] Same for auth, cart, order, payment, api-gateway, ai-recommendation, frontend
- [ ] `kubectl exec deploy/product-service -- sh -c 'apk add redis; redis-cli -h redis ping'` returns `PONG`
- [ ] `POST /api/auth/login` via the Ingress returns a JWT
- [ ] `GET /api/products` via the Ingress with that JWT returns a list
- [ ] Add-to-cart -> checkout -> payment flow completes end-to-end
- [ ] Frontend loads at the Ingress address and the SPA can call `/api/...`
- [ ] `kubectl rollout restart deploy/product-service` rolls without downtime
  (no 5xx during the restart from the gateway logs)

When all of those pass, the cluster is ready for Azure Pipelines automation.
