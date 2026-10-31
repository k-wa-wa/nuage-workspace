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

#####

import {
  id = "nuage-cluster"
  to = module.nuage_cluster.github_repository.repository
}
module "nuage_cluster" {
  source = "./modules/repo"
  repository_config = {
    name        = "nuage-cluster"
    description = "おうちクラスターのセットアップリポジトリ"
  }
}

#####

import {
  id = "nuage-monitoring-stack"
  to = module.nuage_monitoring_stack.github_repository.repository
}
module "nuage_monitoring_stack" {
  source = "./modules/repo"
  repository_config = {
    name        = "nuage-monitoring-stack"
    description = "おうちクラスターのモニタリング環境"
  }
}

#####

import {
  id = "pechka"
  to = module.pechka.github_repository.repository
}
module "pechka" {
  source = "./modules/repo"
  repository_config = {
    name        = "pechka"
    description = ""
  }
}

#####

import {
  id = "bare-web-proxy"
  to = module.bare_web_proxy.github_repository.repository
}
module "bare_web_proxy" {
  source = "./modules/repo"
  repository_config = {
    name        = "bare-web-proxy"
    description = "通信制限を救う超軽量なプロキシ"
  }
}

#####

import {
  id = "nuage-autopilot4"
  to = module.nuage_autopilot4.github_repository.repository
}
module "nuage_autopilot4" {
  source = "./modules/repo"
  repository_config = {
    name        = "nuage-autopilot4"
    description = "Issue駆動の完全自律開発エージェント"
  }
}

#####

import {
  id = "nuage-autopilot5"
  to = module.nuage_autopilot5.github_repository.repository
}
module "nuage_autopilot5" {
  source = "./modules/repo"
  repository_config = {
    name        = "nuage-autopilot5"
    description = ""
  }
}

#####

import {
  id = "nuage-usage-ledger"
  to = module.nuage_usage_ledger.github_repository.repository
}
module "nuage_usage_ledger" {
  source = "./modules/repo"
  repository_config = {
    name        = "nuage-usage-ledger"
    description = ""
  }
}

#####

import {
  id = "cicerone3270"
  to = module.cicerone3270.github_repository.repository
}
module "cicerone3270" {
  source = "./modules/repo"
  repository_config = {
    name        = "cicerone3270"
    description = ""
  }
}

#####

import {
  id = "nuage-dr"
  to = module.nuage_dr.github_repository.repository
}
module "nuage_dr" {
  source = "./modules/repo"
  repository_config = {
    name        = "nuage-dr"
    description = ""
  }
  bypass_mode            = "pull_request"
  required_status_checks = ["check", "build-pi-nas"]
}
