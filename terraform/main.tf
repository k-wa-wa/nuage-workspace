import {
  id = "nuage-workspace"
  to = github_repository.nuage_workspace
}

resource "github_repository" "nuage_workspace" {
  name        = "nuage-workspace"
  description = ""
}

resource "github_repository_collaborator" "nuage_workspace_collaborator" {
  repository = github_repository.nuage_workspace.name
  username   = "bot-wa-wa"
}
