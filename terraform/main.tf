import {
  id = "nuage-workspace"
  to = module.nuage_workspace.github_repository.repository
}
module "nuage_workspace" {
  source = "./modules/repo"
  repository_config = {
    name        = "nuage-workspace"
    description = ""
  }
}
