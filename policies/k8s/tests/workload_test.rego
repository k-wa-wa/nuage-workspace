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

# 異常系: 自前イメージの imagePullPolicy: Always 欠落を検知する
test_missing_image_pull_policy_denied if {
	bad := json.patch(valid_own_deployment, [{
		"op": "remove",
		"path": "/spec/template/spec/containers/0/imagePullPolicy",
	}])
	denies := main.deny with input as [bad, valid_pdb] with data.env as "prod"
	some msg in denies
	contains(msg, "imagePullPolicy: Always")
}

# 異常系: カスタム own_image_prefixes にも追従する
test_custom_own_image_prefix_enforced if {
	bad := json.patch(valid_own_deployment, [{
		"op": "replace",
		"path": "/spec/template/spec/containers/1/image",
		"value": "registry.example.com/team/sidecar:latest",
	}])
	denies := main.deny with input as [bad, valid_pdb]
		with data.env as "prod"
		with data.own_image_prefixes as ["ghcr.io/k-wa-wa/", "registry.example.com/team/"]
	count(denies) >= 2
}

# 異常系: keel.sh/policy / keel.sh/trigger の不正値、monitorContainers 欠落・正規表現不一致・不正構文を検知する
test_keel_annotation_values_and_regex_validation if {
	bad_policy := json.patch(valid_own_deployment, [{
		"op": "replace",
		"path": "/metadata/annotations/keel.sh~1policy",
		"value": "never",
	}])
	denies_policy := main.deny with input as [bad_policy, valid_pdb] with data.env as "prod"
	some mp in denies_policy
	contains(mp, "keel.sh/policy: \"force\"")

	bad_trigger := json.patch(valid_own_deployment, [{
		"op": "replace",
		"path": "/metadata/annotations/keel.sh~1trigger",
		"value": "webhook",
	}])
	denies_trigger := main.deny with input as [bad_trigger, valid_pdb] with data.env as "prod"
	some mt in denies_trigger
	contains(mt, "keel.sh/trigger: \"poll\"")

	missing := json.patch(valid_own_deployment, [{
		"op": "remove",
		"path": "/metadata/annotations/keel.sh~1monitorContainers",
	}])
	denies_missing := main.deny with input as [missing, valid_pdb] with data.env as "prod"
	some m1 in denies_missing
	contains(m1, "keel.sh/monitorContainers")

	# Keel の仕様ではカンマ区切りではなく正規表現であるため "app,other" は一致しない
	comma_list := json.patch(valid_own_deployment, [{
		"op": "replace",
		"path": "/metadata/annotations/keel.sh~1monitorContainers",
		"value": "app,other",
	}])
	denies_comma := main.deny with input as [comma_list, valid_pdb] with data.env as "prod"
	some m2 in denies_comma
	contains(m2, "正規表現が自前イメージ利用コンテナ")

	# 正規表現構文エラーを検知する
	invalid_regex := json.patch(valid_own_deployment, [{
		"op": "replace",
		"path": "/metadata/annotations/keel.sh~1monitorContainers",
		"value": "[unclosed",
	}])
	denies_regex := main.deny with input as [invalid_regex, valid_pdb] with data.env as "prod"
	some m3 in denies_regex
	contains(m3, "有効な正規表現ではない")

	# 正しい正規表現パターン (^app$|worker) は許可される
	valid_regex := json.patch(valid_own_deployment, [{
		"op": "replace",
		"path": "/metadata/annotations/keel.sh~1monitorContainers",
		"value": "^app$|worker",
	}])
	denies_valid_regex := main.deny with input as [valid_regex, valid_pdb] with data.env as "prod"
	count(denies_valid_regex) == 0
}

# 異常系: initContainer で自前イメージを使う場合も imagePullPolicy: Always が必須
test_init_container_own_image_requires_pull_policy_always if {
	dep := json.patch(valid_own_deployment, [{
		"op": "add",
		"path": "/spec/template/spec/initContainers",
		"value": [{
			"name": "init-migrator",
			"image": "ghcr.io/k-wa-wa/migrator:latest",
			"resources": {
				"requests": {"cpu": "50m", "memory": "64Mi"},
				"limits": {"cpu": "100m", "memory": "128Mi"},
			},
		}],
	}])
	denies := main.deny with input as [dep, valid_pdb] with data.env as "prod"
	some msg in denies
	contains(msg, "init:init-migrator")
	contains(msg, "imagePullPolicy: Always")
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

# 正常系: WorkflowTemplate は Deployment ではないため Keel アノテーション不要
test_workflow_template_does_not_require_keel if {
	wf := {
		"apiVersion": "argoproj.io/v1alpha1",
		"kind": "WorkflowTemplate",
		"metadata": {"name": "etl", "namespace": "app-ns"},
		"spec": {
			"templates": [{
				"name": "extract",
				"container": {
					"image": "ghcr.io/k-wa-wa/etl:latest",
					"imagePullPolicy": "Always",
					"resources": {
						"requests": {"cpu": "100m", "memory": "128Mi"},
						"limits": {"cpu": "500m", "memory": "512Mi"},
					},
				},
			}],
		},
	}
	denies := main.deny with input as [wf] with data.env as "prod"
	count(denies) == 0
}

# 異常系: resources および probes 欠落を検知する
test_missing_resources_and_probes_denied if {
	bad := json.patch(valid_own_deployment, [
		{"op": "remove", "path": "/spec/template/spec/containers/0/resources"},
		{"op": "remove", "path": "/spec/template/spec/containers/0/readinessProbe"},
		{"op": "remove", "path": "/spec/template/spec/containers/0/livenessProbe"},
	])
	denies := main.deny with input as [bad, valid_pdb] with data.env as "prod"
	some m_req in denies
	contains(m_req, "resources.requests")
	some m_lim in denies
	contains(m_lim, "resources.limits")
	some m_read in denies
	contains(m_read, "readinessProbe")
	some m_live in denies
	contains(m_live, "livenessProbe")
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
