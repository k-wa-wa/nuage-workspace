package main_test

import rego.v1

import data.main

valid_own_deployment := {
	"apiVersion": "apps/v1",
	"kind": "Deployment",
	"metadata": {
		"name": "app",
		"namespace": "app-ns",
		"annotations": {
			"keel.sh/policy": "force",
			"keel.sh/trigger": "poll",
			"keel.sh/matchTag": "true",
			"keel.sh/monitorContainers": "app",
		},
	},
	"spec": {
		"replicas": 2,
		"template": {
			"metadata": {"labels": {"app": "app"}},
			"spec": {
				"topologySpreadConstraints": [{
					"maxSkew": 1,
					"topologyKey": "kubernetes.io/hostname",
					"whenUnsatisfiable": "DoNotSchedule",
				}],
				"containers": [
					{
						"name": "app",
						"image": "ghcr.io/k-wa-wa/app:latest",
						"imagePullPolicy": "Always",
						"resources": {
							"requests": {"cpu": "50m", "memory": "64Mi"},
							"limits": {"cpu": "200m", "memory": "128Mi"},
						},
						"readinessProbe": {"httpGet": {"path": "/health", "port": 8080}},
						"livenessProbe": {"httpGet": {"path": "/health", "port": 8080}},
					},
					{
						"name": "sidecar",
						"image": "nginx:1.27-alpine",
						"resources": {
							"requests": {"cpu": "20m", "memory": "32Mi"},
							"limits": {"cpu": "100m", "memory": "64Mi"},
						},
						"readinessProbe": {"httpGet": {"path": "/", "port": 80}},
						"livenessProbe": {"httpGet": {"path": "/", "port": 80}},
					},
				],
			},
		},
	},
}

valid_pdb := {
	"apiVersion": "policy/v1",
	"kind": "PodDisruptionBudget",
	"metadata": {"name": "app-pdb", "namespace": "app-ns"},
	"spec": {
		"minAvailable": 1,
		"selector": {"matchLabels": {"app": "app"}},
	},
}

# 正常系: 要件をすべて満たす Deployment + PDB は deny/warn ともに 0 件
test_valid_own_deployment_passes if {
	denies := main.deny with input as [valid_own_deployment, valid_pdb] with data.env as "prod"
	warns := main.warn with input as [valid_own_deployment, valid_pdb] with data.env as "prod"
	count(denies) == 0
	count(warns) == 0
}

# 正常系: conftest --combine 形式のラップ入力でも正しく評価される
test_conftest_combine_wrapper_format if {
	wrapped := [
		{"path": "rendered.yaml", "contents": valid_own_deployment},
		{"path": "rendered.yaml", "contents": valid_pdb},
	]
	denies := main.deny with input as wrapped with data.env as "prod"
	count(denies) == 0
}

# 異常系: Helm ラベルが付いていても自前イメージを利用していれば除外しない
test_helm_managed_with_own_image_not_excluded if {
	helm_own := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "helm-own-app",
			"namespace": "app-ns",
			"labels": {"helm.sh/chart": "own-chart-1.0.0"},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "helm-own-app"}},
				"spec": {
					"containers": [{
						"name": "app",
						"image": "ghcr.io/k-wa-wa/own-app:latest",
					}],
				},
			},
		},
	}
	denies := main.deny with input as [helm_own] with data.env as "prod"
	count(denies) > 0
	some m_pull in denies
	contains(m_pull, "imagePullPolicy: Always")
	some m_probe in denies
	contains(m_probe, "readinessProbe")
}

# 例外系: nuage.io/ignore-* アノテーションで対象ルールを除外できる
test_opt_out_annotations_skip_checks if {
	ignored := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "legacy",
			"namespace": "app-ns",
			"annotations": {
				"nuage.io/ignore-keel": "true",
				"nuage.io/ignore-resources": "true",
				"nuage.io/ignore-probes": "true",
				"nuage.io/ignore-ha": "true",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "legacy"}},
				"spec": {
					"containers": [{
						"name": "legacy",
						"image": "ghcr.io/k-wa-wa/legacy:latest",
						"imagePullPolicy": "Always",
					}],
				},
			},
		},
	}
	denies := main.deny with input as [ignored] with data.env as "prod"
	count(denies) == 0
}

# 例外系: Helm 管理サードパーティワークロードはデフォルト除外される
test_helm_managed_third_party_excluded if {
	helm_dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "vm-grafana",
			"namespace": "monitoring",
			"labels": {"helm.sh/chart": "grafana-12.7.3"},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "grafana"}},
				"spec": {
					"containers": [{
						"name": "grafana-sc",
						"image": "quay.io/kiwigrid/k8s-sidecar:1.0.0",
					}],
				},
			},
		},
	}
	denies := main.deny with input as [helm_dep] with data.env as "prod"
	count(denies) == 0
}

# 環境別: common 環境では標準チェック（keel.rego / resources.rego / probes.rego）のみが動作し、ha.rego と preview.rego は発火しない
test_common_env_runs_only_standard_policies if {
	# 1. HA 要件や preview 要件を満たさなくても標準要件を満たせば PASS する
	cr := {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole", "metadata": {"name": "cluster-admin-ext"}}
	dep_no_ha := json.patch(valid_own_deployment, [
		{"op": "replace", "path": "/spec/replicas", "value": 1},
		{"op": "remove", "path": "/spec/template/spec/topologySpreadConstraints"},
	])
	denies_pass := main.deny with input as [cr, dep_no_ha] with data.env as "common"
	count(denies_pass) == 0

	# 2. 標準ルールの違反（imagePullPolicy / resources / probes 欠落）は common 環境でも検知される
	bad_dep := json.patch(dep_no_ha, [
		{"op": "remove", "path": "/spec/template/spec/containers/0/imagePullPolicy"},
		{"op": "remove", "path": "/spec/template/spec/containers/0/resources"},
		{"op": "remove", "path": "/spec/template/spec/containers/0/readinessProbe"},
	])
	denies_fail := main.deny with input as [bad_dep] with data.env as "common"
	some m_pull in denies_fail
	contains(m_pull, "imagePullPolicy: Always")
	some m_res in denies_fail
	contains(m_res, "resources.requests")
	some m_probe in denies_fail
	contains(m_probe, "readinessProbe")
}
