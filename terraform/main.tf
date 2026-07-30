import {
  id = "nuage-workspace"
  to = github_repository.nuage_workspace
}

resource "github_repository" "nuage_workspace" {
  name        = "nuage-workspace"
  description = ""
}
