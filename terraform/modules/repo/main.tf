resource "github_repository" "repository" {
  name         = var.repository_config.name
  description  = var.repository_config.description
  has_issues   = true
  has_projects = true
  has_wiki     = true
}

resource "github_repository_collaborators" "repository_collaborators" {
  repository = github_repository.repository.name
  user {
    username = "bot-wa-wa"
  }
}

resource "github_repository_ruleset" "repository_ruleset" {
  name        = "protect-default-branch"
  repository  = github_repository.repository.name
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
