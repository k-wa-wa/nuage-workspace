locals {
  env_token = get_env("GITHUB_TOKEN", "")
  token     = local.env_token != "" ? local.env_token : run_cmd("--terragrunt-quiet", "gh", "auth", "token")
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "6.13.0"
    }
  }
}

provider "github" {
  owner = "k-wa-wa"
  token = "${local.token}"
}
EOF
}

remote_state {
  backend = "local"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    path = "./terraform.tfstate"
  }
}
