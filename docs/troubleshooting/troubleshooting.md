# TROOUBLESHOOTING THE PROBLEMS

---

## 1. Terraform State File Persisting After Destroy

**Symptom:** After running `terraform destroy` through the CI/CD pipeline, the state file was still present in the Azure Blob Storage container used as the Terraform backend.

**Root Cause:**
This is expected behavior. `terraform destroy` removes the actual cloud resources and updates the contents of the state file to reflect that nothing exists anymore — it does not delete the state file blob itself.

**Fix / Correct Procedure:**

1. Re-initialize and verify the state is actually empty before re-applying:
   ```bash
   terraform init
   terraform state list # should return nothing if destroy fully completed
   ```

2. If empty, simply re-run the pipeline / apply normally:
   ```bash
   terraform plan
   terraform apply
   ```

3. If leftover resources are still listed in state (partial destroy), either re-run `terraform destroy` again, or remove state entries manually:
   ```bash
   terraform state rm <resource_address>
   ```

4. If the backend blob is locked from a previous failed run:
   ```bash
   terraform force-unlock <LOCK_ID>
   ```
   or from gui break the lease or unlock

---

## 2. AKS Kubeconfig Conflict

**Error:**
```
different object named clusterUser_blinkit-cap-rg_blinkit-cap-aks already exists in users in your kubeconfig
```

**Root Cause:**
When I created the AKS cluster for the first time, `az aks get-credentials` merged a user/context/cluster entry into the local kubeconfig. After i destroyed and recreated the aks cluster, Azure issued new certificates/tokens for a user entry with the exact same name. The Azure CLI refuses to silently overwrite the old (now invalid) entry, causing the conflict.

**Fix:**
The fix would as we already have the old config file now we have to forcefully overwrite in it when fetching credentials:

```bash
az aks get-credentials \
--resource-group blinkit-cap-rg \
--name blinkit-cap-aks \
--overwrite-existing
```

---

## 3. Pipeline Error: File Path Does Not Exist

**Root Cause:**
The path used an absolute path (leading slash), pointing to the filesystem root instead of the pipeline's checked-out source directory. Absolute paths like this do not resolve to the repository contents on the build agent.

**Fix:**
Here, I made a mistake by adding only the the parent and child module rather than the complete path like from root module
lets say  , technically my file is at root module blinkit-clone-project inside to this there is a parent module azurek8s inside this I have that file named ai-recommendation
the path should be /blinkit-clone-project/azurek8s/ai-recommendation not like azurek8s/ai-recommendation if you give like agent wont find the exact resource, this also comes under the pipeline variable.

---

## 4. YAML Strict Decoding Error: unknown field "metadata.spec"

**Error:**
```
Deployment in version "v1" cannot be handled as a Deployment: strict decoding error: unknown field "metadata.
```

**Root Cause:**
`spec:` was indented one level too deep, nesting it under `metadata:` instead of being a sibling of it. Kubernetes' strict schema validation has no field called `metadata.spec`, so the object was rejected.

**Fix:**
Align `spec:` at the same indentation level as the root `metadata:` block (both at column 0):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
name: auth-service
spec: # sibling of metadata, not nested inside it
replicas: 3
```

---

## 5. ACR Pull Permission Missing (AcrPull Role)

**Root Cause:**
The AKS cluster's managed identity did not have permission to pull images from the Azure Container Registry (ACR). This is a very common gap after recreating a cluster if the registry attachment step is not part of the automated Terraform/pipeline flow.

**Fix:** (chosen approach — IAM role assignment, cluster-wide, no per-pod secret needed):
*through GUI, Granted the AcrPull role to the AKS kubelet managed identity, scoped to the ACR, via Azure Portal IAM.
*Equivalent CLI/Terraform forms:
We can give the permission in the two ways one is through CLI by writing a yaml resource in the terraform script
`/terraform/modules/aks/main.tf`
By doing this eventhough your cluster created or recreated it does not matter whenenver pipeline runs this script automatically the role will get created.
Hence, it establishes connection between the acr and aks for image pull 

**Terraform equivalent (idempotent, survives destroy/recreate):**

```hcl
resource "azurerm_role_assignment" "acr_pull" {
principal_id = azurerm_kubernetes_cluster.aks.kubelet_identity[0].object_id
role_definition_name = "AcrPull"
scope = data.azurerm_container_registry.acr.id
}
```

**Note:** this requires the AKS cluster to use a managed identity (`identity { type = "SystemAssigned" }`) rather than a legacy service-principal-based cluster, since `kubelet_identity` is only populated for managed-identity clusters.

---

## 6. auth-deployment.yaml Structural Errors

After fixing the `metadata`/`spec` indentation, a full manifest review surfaced two further structural bugs in the same file.

**Bug A — missing template: block:**
The pod template was missing entirely; `spec:` (the pod spec) was incorrectly nested directly under `selector:`. A Deployment requires:

```yaml
spec:
replicas: ...
selector:
matchLabels: ...
template: # was missing
metadata:
labels: ...
spec: # pod spec belongs here, not under selector
containers: ...
```

**Bug B — malformed ports list:**

```yaml
# Wrong - creates two separate list items:
ports:
- name: http
- containerPort: 8081
```

```yaml
# Correct - one object with both keys:
ports:
- name: http
containerPort: 8081
```

**Fix:**
Rebuilt the manifest with the `template:` block correctly wrapping the pod spec, matching labels against `selector.matchLabels`, and corrected the ports list to a single mapping object. Verified with:

```bash
kubectl apply -f auth-deployment.yaml --dry-run=client --validate=true
```

---

## 7. front-end-green-deployment Not Found

```
service/frontend created
Error from server (NotFound): deployments.apps "front-end-green-deployment" not found
```

**Root Cause:**
The YAML file was named `front-end-green-deployment.yaml`, but Kubernetes does not use file names to identify objects — only `metadata.name` inside the file matters. That field was set to `front-end-green`, so the actual object created in the cluster was named `front-end-green`, not `front-end-green-deployment`. A later pipeline step referencing the longer name found nothing.

**Fix:**
Kept `metadata.name: front-end-green` as the source of truth and corrected the pipeline reference to match it:

```bash
kubectl rollout status deployment/front-end-green -n blinkit --timeout=300s
```

---

## 8. imagepull back off

**Error:** `imagepullbackoff` is the state 

**Root cause:** after looking at that state, I ran command called `kubectl describe pod <order-service>`, then I find out that it is regarding the acr pull permission. 

**Fix:** As I discussed earlier, once I enabled the permission through acr iam managed identity, then I rollout and restart that  deployment that's it now the state is running and health

In fact, this is the most top rated and comman problem every engineer deals in day-to-day its purely based on these reasons

1. **Wrong image name or tag** — typo in the image name, or the tag doesn't exist (e.g., `myapp:v2` when only `myapp:v1` was pushed) 
2. **Private registry without credentials** — pulling from ACR/ECR/Docker Hub private repo without an `imagePullSecrets` configured, or the secret is expired/invalid 
3. **AKS kubelet identity lacks ACR pull permission** — (ties into what we discussed earlier) if using managed identity, the kubelet identity needs `AcrPull` role assignment on the ACR 
4. **Registry is down or unreachable** — network/firewall issues, private endpoint misconfiguration, or DNS resolution failing to reach the registry 
5. **Rate limiting** — especially common with Docker Hub's pull rate limits on anonymous/free accounts 
6. **Image doesn't exist / was deleted** — someone deleted the tag or repo from the registry 
7. **Architecture mismatch** — e.g., pulling an ARM64 image on an AMD64 node pool (or vice versa) without multi-arch manifest support 

---

## 9. crashloopbackoff:

**Error:** acr secret is missing

```
Warning FailedToRetrieveImagePullSecret Unable to retrieve some image pull secrets (acr-secret); attempting
Normal BackOff Back-off pulling image "bli2000.azurecr.io/order-service:latest"
```

**Rootcause:** 
The Deployment YAML referenced `imagePullSecrets: - name: acr-secret`, but no Kubernetes Secret named `acr-secret` existed in the `blinkit` namespace.

**Fix:**
->Firstly, I checked with `kubectl logs<podname>  --previous` which shows the crashed pod logs. 
->We can incorporate acre-secret in two ways

**For temporary fix** I applied through CLI

```bash
az acr credential show --name bli2000
kubectl create secret docker-registry acr-secret \
--namespace=blinkit \
--docker-server=bli2000.azurecr.io \
--docker-username=<username> \
--docker-password=<password> \
--docker-email=<any-email>
```

then the container restarted and pulling images

**The another possible way would be,**

```hcl
resource "kubernetes_secret" "acr_secret" {
metadata {
name = "acr-secret"
namespace = "blinkit"
}
type = "kubernetes.io/dockerconfigjson"
data = {
".dockerconfigjson" = jsonencode({
auths = {
"bli2000.azurecr.io" = {
username = var.acr_username
password = var.acr_password
auth = base64encode("${var.acr_username}:${var.acr_password}")
}
}
}
}
```

So that if any clone my script they wont face these issues.

---

## 10. Pod Stuck in Pending - Insufficient CPU

**Error:** `Oom(out of memory) killed`

```
Warning FailedScheduling 0/2 nodes are available: 2 Insufficient cpu.
no new claims to deallocate, preemption: 0/2 nodes are available: 2 No preemption victims found for incoming
```

**fix:**
Here I am checking the total nodes,

```bash
aks nodepool list --resource-group blinkit-cap-rg --cluster-name blinkit-cap-aks -o table
```

I found out I have 2 working nodes only, now I wanna scale them 

```bash
az aks nodepool scale \
--resource-group blinkit-cap-rg \
--cluster-name blinkit-cap-aks \
--name <exact-nodepool-name> \
--node-count 3
```

**The long term fix** for this problem would be enabling the  cluster auto scaling

```bash
az aks nodepool update \
--resource-group blinkit-cap-rg \
--cluster-name blinkit-cap-aks \
--name <nodepool-name> \
--enable-cluster-autoscaler \
--min-count 2 --max-count 5
```

**In addition to this concept,**
We have another concept also called **HPA(horizontal pod autoscaler)** these both are like interlinked node autoscaler and HPA

**How?**

1. Traffic hits Load Balancer → traffic reaches your pods
2. Pods experience increased CPU/memory/request load
3. **HPA** (Horizontal Pod Autoscaler) notices this — because you defined a threshold (e.g., "scale up if CPU > 70%")
4. HPA increases replica count (e.g., from 3 → 10 pods) — but capped by your `maxReplicas` setting
5. Kubernetes scheduler tries to place these new pods on existing nodes
6. If nodes are full — either:
   a) Out of CPU/memory capacity, OR
   b) Hit the `max_pods` per node limit (e.g., 20-30 pods/node)
   → new pods can't be scheduled → they sit in "Pending" state
7. **Cluster Autoscaler** notices Pending pods → adds a new node — capped by your `max_count` (node pool limit)
8. Once new node is ready, Pending pods get scheduled onto it
9. Now you have enough pods + enough nodes to handle the traffic

---

## 11. Wrong Database Hostname in ConfigMap:

**Error:** 
```
Caused by: java.net.UnknownHostException: blinkit-server2000.postgres.database.azure.com
```

**Rootcause:** Application logs for cart-service showed a Spring Boot / Flyway / HikariCP startup failure caused by an unresolvable database hostname. 

**Fix:**

```bash
Kubectl logs <pod name>
Kubectl logs <podname> --previous
```

Then I saw in the logs it is regarding the Database issue

First, A direct DNS test from inside the cluster confirmed the real server name resolved correctly:

```bash
kubectl run -it --rm debug --image=busybox --restart=Never -n blinkit -- \
nslookup server2000.postgres.database.azure.com
# resolved successfully to 52.139.39.206
```

It says that the routing and the dns is good.

Secondly, I have checked the configuration files, inside the `/secret/auth-secret` where postgresql database details live then I found there is a naming mismatch with one letter so that's making the noise for having the crashloopbackoff and all.

---

## 12. PostgreSQL Server Was Stopped

**Error:** After correcting the hostname, the error changed from `UnknownHostException` to `SocketTimeoutException: Connect timed out` — indicating the hostname now resolved correctly, but nothing was responding on the database port.

**Diagnosis:** `kubectl logs < podname>`

I went into postgresql db through gui and checked the firewall permissions for the aks but everything looks good but for the safety and temporay I did allow all services as with `0.0.0.0` as start and endip 

->checked the state of db then I found that it is stopped 

**Fix:** as I found out db is resting then I restarted the db and checked status now it is running or active that's it everything came to normal.

---

## 13. No end points were available

**Error:** Service selector became:
```yaml
version: ""
```

**symptoms:** when Azure DevOps pipeline was performing a blue-green deployment. The pipeline had to determine which environment (blue or green) was currently active and then deploy to the opposite environment.

However, when the deployment stage ran, the Kubernetes Service selector became:

```yaml
selector:
  app: frontend
  version: ""
```

instead of:

```yaml
selector:
  app: frontend
  version: blue
```

**Root cause:** As I saw the issue, then I went I checked the end points in k8s cluster I cant see any end point
Because the in the value of version no variable is passing.

-> The problem was not Kubernetes.
The actual problem was inside the Azure DevOps pipeline.

In one job  I wrote:

```bash
echo "Current = $CURRENT"
echo "Next = $NEXT"
echo "##vso[task.setvariable variable=targetEnv;isOutput=true]$NEXT"
```

This correctly created an output variable.

But in the next stage I was trying something like:

```bash
$(targetEnv)
```

Azure DevOps does not automatically pass output variables across jobs or stages that's why I was getting empty in the version

**FIX:**
Once you wrote this one `echo "##vso[task.setvariable variable=targetEnv;isOutput=true]$NEXT"`
Then in the next stage or job, you should write

```yaml
variables: targetEnv: $[ stageDependencies.DetectCurrentEnvironment.outputs[ 'Detect.current.targetEnv' ] ]
```

->now it will give you blue or green in the version.And, the endpoints will come back to work.

**Prevention**
One of the biggest lessons from this issue  I have learned is to validate pipeline variables before using them.
For example:

```bash
echo "Current Environment: $CURRENT"
echo "Next Environment: $NEXT"
echo "Target Environment: $(targetEnv)"
```

If any of these prints an empty value, we will get to know  the problem is in the pipeline rather than Kubernetes.

---

## 14: Kubernetes Service Selector Mismatch

**Problem**
Service was not routing traffic.

**Command:**

```bash
kubectl get endpoints frontend
```

**Output:**

```
frontend <none> no end points
```

**Root Cause**
Service selector:

```yaml
app: front-end
```

Pod labels:

```yaml
app: frontend
```

The labels did not match.

**Solution**
Updated Service selector:

```yaml
selector:
app: frontend
```

**Prevention**
Always verify:

```bash
kubectl get pods --show-labels
```

and compare with

```bash
kubectl describe svc frontend
```

**Key Learning**
Kubernetes Services do not know about Deployments. They only know labels.
