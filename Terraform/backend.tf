terraform {
  backend "azurerm" {
    resource_group_name  = "StatefileRG"
    storage_account_name = "blinkitaisfsa"
    container_name       = "statefile"
    key                  = "blinkit-aks.tfstate"
  }
}