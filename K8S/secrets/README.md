# Blinkit Secrets — AKS

> **WARNING — these YAMLs contain real production credentials.** They must
> NEVER be committed to a public Git remote. Add `K8S/secrets/*.yaml` (except
> this README) to `.gitignore` if you haven't already, or move the values
> into Azure Key Vault and use the CSI driver.

The placeholder `*.example.yaml` templates that previously lived here have
been **deleted** because applying them by mistake clobbered the working
secrets and crash-looped every JVM pod (`UnknownHostException:
<pg-host>.postgres.database.azure.com`).

The current `*.yaml` files in this folder are the real, live secret
definitions and apply cleanly with `kubectl apply`.

---

## Platform-wide constants (shared across every JVM service)

| Key | Value |
|---|---|
| Postgres host | `blinkit-postgres.postgres.database.azure.com:5432` |
| Postgres user | `pgadmin` |
| Postgres password | `Cloud@123` |
| `sslmode` | `require` (Azure PG Flexible Server enforces it) |
| Per-service DB name | `blinkit_auth`, `blinkit_products`, `blinkit_cart`, `blinkit_orders`, `blinkit_payments` |
| `JWT_SECRET` | `blinkit-super-secure-jwt-secret-key-for-aks-deployment-2026-platform` |
| `JWT_EXPIRATION` | `86400000` (auth-service only) |

`JWT_SECRET` MUST be byte-identical across `auth-service` (signs),
`product-service`, `cart-service`, `order-service`, `payment-service` and
`api-gateway` (all validate). A mismatch silently rejects every login.

---

## 1. ACR pull secret (one-time, not in git)

```powershell
kubectl create secret docker-registry acr-secret `
  --namespace blinkit `
  --docker-server=blinkitaiacr.azurecr.io `
  --docker-username=<acr-username> `
  --docker-password=<acr-password-or-token>
```

> Better: `az aks update -g <rg> -n <aks> --attach-acr blinkitaiacr` wires
> ACR directly into the AKS managed identity and you can drop
> `imagePullSecrets` from every deployment.

---

## 2. Per-service secrets — apply order

```powershell
kubectl apply -f K8S/secrets/auth-secret.yaml
kubectl apply -f K8S/secrets/product-secret.yaml
kubectl apply -f K8S/secrets/cart-secret.yaml
kubectl apply -f K8S/secrets/order-secret.yaml
kubectl apply -f K8S/secrets/payment-secret.yaml
kubectl apply -f K8S/secrets/api-gateway-secret.yaml
kubectl apply -f K8S/secrets/ai-recommendation-secret.yaml
```

Or in one shot:

```powershell
kubectl apply -f K8S/secrets/
```

| Service | Secret name | Required keys |
|---|---|---|
| auth-service | `auth-secret` | `SPRING_DATASOURCE_URL`, `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD`, `JWT_SECRET`, `JWT_EXPIRATION` |
| product-service | `product-secret` | same DB keys + `JWT_SECRET` |
| cart-service | `cart-secret` | same DB keys + `JWT_SECRET` |
| order-service | `order-secret` | same DB keys + `JWT_SECRET` |
| payment-service | `payment-secret` | same DB keys + `JWT_SECRET` |
| api-gateway | `api-gateway-secret` | `JWT_SECRET` only (no DB) |
| ai-recommendation-service | `ai-recommendation-secret` | `INTERNAL_SERVICE_JWT` (optional, can be empty) |

---

## 3. After changing any secret — restart consumers

K8S secrets injected via `envFrom: secretRef` are read **once at pod start**.
Updating the secret does NOT restart pods — you must roll the deployments:

```powershell
kubectl rollout restart deploy/auth-service    -n blinkit
kubectl rollout restart deploy/product-service -n blinkit
kubectl rollout restart deploy/cart-service    -n blinkit
kubectl rollout restart deploy/order-service   -n blinkit
kubectl rollout restart deploy/payment-service -n blinkit
kubectl rollout restart deploy/api-gateway     -n blinkit
```
