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

resource "github_repository_collaborators" "nuage_workspace_collaborators" {
  repository = github_repository.nuage_workspace.name
  user {
    username = "bot-wa-wa"
  }
}

resource "github_repository_ruleset" "nuage_workspace_ruleset" {
  name        = "protect-default-branch"
  repository  = github_repository.nuage_workspace.name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  bypass_actors {
    actor_type  = "RepositoryRole"
    bypass_mode = "always"
    actor_id    = 5
  }

  rules {
    creation = true
    update   = true
    deletion = true

    pull_request {
    }

    non_fast_forward = true
  }
}
