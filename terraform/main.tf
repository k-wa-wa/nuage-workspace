import {
  id = "nuage-workspace"
  to = github_repository.nuage_workspace
}

resource "github_repository" "nuage_workspace" {
  name         = "nuage-workspace"
  description  = ""
  has_issues   = true
  has_projects = true
  has_wiki     = true
}

resource "github_repository_collaborator" "nuage_workspace_collaborator" {
  repository = github_repository.nuage_workspace.name
  username   = "bot-wa-wa"
}
