output "aks_cluster_name" {
  value = azurerm_kubernetes_cluster.aks.name
}

output "kubernetes_version" {
  value = azurerm_kubernetes_cluster.aks.kubernetes_version
}