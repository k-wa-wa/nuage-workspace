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
  id = "nuage-autopilot"
  to = module.nuage_autopilot.github_repository.repository
}
module "nuage_autopilot" {
  source = "./modules/repo"
  repository_config = {
    name        = "nuage-autopilot"
    description = "Issue駆動の完全自律開発エージェント"
  }
}
