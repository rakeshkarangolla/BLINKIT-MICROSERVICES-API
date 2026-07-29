resource "azurerm_kubernetes_cluster" "aks" {
  name                = var.aks_cluster_name
  location            = var.location
  resource_group_name = var.resource_group_name
  dns_prefix          = "aksdemo"

  role_based_access_control_enabled = true
  oidc_issuer_enabled = true

  default_node_pool {
    name       = "nodepool1"
    node_count = var.node_count
    vm_size    = var.vm_size
  }

  identity {
    type = "SystemAssigned"
  }
}

# -------------------------------
# Existing ACR (Data Source)
# -------------------------------

data "azurerm_container_registry" "acr" {
  name                = var.acr_name
  resource_group_name = var.acr_resource_group
}

# -------------------------------
# Role Assignment (AKS → ACR)
# -------------------------------

resource "azurerm_role_assignment" "acr_pull" {
  principal_id         = azurerm_kubernetes_cluster.aks.kubelet_identity[0].object_id
  role_definition_name = "AcrPull"
  scope                = data.azurerm_container_registry.acr.id

  depends_on = [
    azurerm_kubernetes_cluster.aks
  ]
}