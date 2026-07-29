module "resource_group" {
  source = "./modules/resource-group"

  resource_group_name = var.resource_group_name
  location            = var.location
}

module "aks" {
  source = "./modules/aks"

  aks_cluster_name    = var.aks_cluster_name
  location            = module.resource_group.location
  resource_group_name = module.resource_group.resource_group_name

  node_count = var.node_count
  vm_size    = var.vm_size

  acr_name           = var.acr_name
  acr_resource_group = var.acr_resource_group
}