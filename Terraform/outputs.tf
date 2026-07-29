output "resource_group_name" {
  value = module.resource_group.resource_group_name
}

output "aks_cluster_name" {
  value = module.aks.aks_cluster_name
}

output "kubernetes_version" {
  value = module.aks.kubernetes_version
}

