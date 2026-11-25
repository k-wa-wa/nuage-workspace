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

# 環境別: common 環境では workload.rego のみが動作し、ha.rego と preview.rego は発火しない
test_common_env_runs_only_workload_policies if {
	# 1. HA 要件や preview 要件を満たさなくても workload 要件を満たせば PASS する
	cr := {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole", "metadata": {"name": "cluster-admin-ext"}}
	dep_no_ha := json.patch(valid_own_deployment, [
		{"op": "replace", "path": "/spec/replicas", "value": 1},
		{"op": "remove", "path": "/spec/template/spec/topologySpreadConstraints"},
	])
	denies_pass := main.deny with input as [cr, dep_no_ha] with data.env as "common"
	count(denies_pass) == 0

	# 2. workload.rego の違反（resources / probes / imagePullPolicy 欠落）は common 環境でも検知される
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

# 異常系: 非自前イメージでも Keel 監視対象 (monitorContainers 一致) かつ imagePullPolicy != Always は deny となる
test_keel_monitored_third_party_image_requires_pull_policy_always if {
	dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "third-party-keel",
			"namespace": "app-ns",
			"annotations": {
				"keel.sh/policy": "force",
				"keel.sh/trigger": "poll",
				"keel.sh/matchTag": "true",
				"keel.sh/monitorContainers": "web",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "third-party-keel"}},
				"spec": {
					"containers": [{
						"name": "web",
						"image": "nginx:1.27.0",
						"resources": {
							"requests": {"cpu": "50m", "memory": "64Mi"},
							"limits": {"memory": "128Mi"},
						},
						"readinessProbe": {"httpGet": {"path": "/", "port": 80}},
						"livenessProbe": {"httpGet": {"path": "/", "port": 80}},
					}],
				},
			},
		},
	}
	denies_missing := main.deny with input as [dep] with data.env as "common"
	count(denies_missing) == 1
	some m1 in denies_missing
	contains(m1, "Keel 監視対象")
	contains(m1, "imagePullPolicy: Always")

	dep_if_not_present := json.patch(dep, [{
		"op": "add",
		"path": "/spec/template/spec/containers/0/imagePullPolicy",
		"value": "IfNotPresent",
	}])
	denies_ifnp := main.deny with input as [dep_if_not_present] with data.env as "common"
	count(denies_ifnp) == 1
	some m2 in denies_ifnp
	contains(m2, "IfNotPresent")

	dep_always := json.patch(dep, [{
		"op": "add",
		"path": "/spec/template/spec/containers/0/imagePullPolicy",
		"value": "Always",
	}])
	denies_always := main.deny with input as [dep_always] with data.env as "common"
	count(denies_always) == 0
}

# 境界系: Keel 対象ワークロードでも monitorContainers に一致しない非自前サイドカーは deny されず、:latest なら warn のみとなる
test_keel_unmonitored_sidecar_not_denied_but_latest_warns if {
	dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "bare-web-proxy",
			"namespace": "proxy-ns",
			"annotations": {
				"keel.sh/policy": "force",
				"keel.sh/trigger": "poll",
				"keel.sh/matchTag": "true",
				"keel.sh/monitorContainers": "proxy-app",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "bare-web-proxy"}},
				"spec": {
					"containers": [
						{
							"name": "proxy-app",
							"image": "ghcr.io/k-wa-wa/bare-web-proxy:latest",
							"imagePullPolicy": "Always",
							"resources": {
								"requests": {"cpu": "50m", "memory": "32Mi"},
								"limits": {"memory": "128Mi"},
							},
							"readinessProbe": {"httpGet": {"path": "/healthz", "port": 3000}},
							"livenessProbe": {"httpGet": {"path": "/healthz", "port": 3000}},
						},
						{
							"name": "headless-chrome",
							"image": "chromedp/headless-shell:latest",
							"imagePullPolicy": "IfNotPresent",
							"resources": {
								"requests": {"cpu": "200m", "memory": "256Mi"},
								"limits": {"memory": "1Gi"},
							},
							"readinessProbe": {"tcpSocket": {"port": 9222}},
							"livenessProbe": {"tcpSocket": {"port": 9222}},
						},
					],
				},
			},
		},
	}
	denies := main.deny with input as [dep] with data.env as "common"
	warns := main.warn with input as [dep] with data.env as "common"
	count(denies) == 0
	count(warns) == 1
	some w in warns
	contains(w, "headless-chrome")
	contains(w, "chromedp/headless-shell:latest")
}

# 異常系: keel.sh/monitorContainers 未指定時は全通常コンテナが Keel 監視対象となり非自前イメージも deny される（warn と重複しない）
test_keel_without_monitor_containers_enforces_always_on_all_containers if {
	dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "keel-all",
			"namespace": "app-ns",
			"annotations": {
				"keel.sh/trigger": "poll",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "keel-all"}},
				"spec": {
					"containers": [{
						"name": "worker",
						"image": "busybox:latest",
						"resources": {
							"requests": {"cpu": "10m", "memory": "16Mi"},
							"limits": {"memory": "32Mi"},
						},
						"readinessProbe": {"exec": {"command": ["true"]}},
						"livenessProbe": {"exec": {"command": ["true"]}},
					}],
				},
			},
		},
	}
	denies := main.deny with input as [dep] with data.env as "common"
	warns := main.warn with input as [dep] with data.env as "common"
	count(denies) == 1
	count(warns) == 0
	some m in denies
	contains(m, "Keel 監視対象")
}

# 例外系: nuage.io/ignore-image-pull-policy: "true" で Keel 監視対象および :latest チェックがともにスキップされる
test_ignore_image_pull_policy_skips_keel_and_latest if {
	dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "ignored-pull",
			"namespace": "app-ns",
			"annotations": {
				"keel.sh/policy": "force",
				"keel.sh/trigger": "poll",
				"nuage.io/ignore-image-pull-policy": "true",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "ignored-pull"}},
				"spec": {
					"containers": [{
						"name": "app",
						"image": "busybox:latest",
						"imagePullPolicy": "IfNotPresent",
						"resources": {
							"requests": {"cpu": "10m", "memory": "16Mi"},
							"limits": {"memory": "32Mi"},
						},
						"readinessProbe": {"exec": {"command": ["true"]}},
						"livenessProbe": {"exec": {"command": ["true"]}},
					}],
				},
			},
		},
	}
	denies := main.deny with input as [dep] with data.env as "common"
	warns := main.warn with input as [dep] with data.env as "common"
	count(denies) == 0
	count(warns) == 0
}

# 境界値: :latest / タグ省略の warn 判定（ポート付きレジストリ・digest 固定・固定タグの区別）
test_latest_and_untagged_image_warning_boundaries if {
	job := {
		"apiVersion": "batch/v1",
		"kind": "Job",
		"metadata": {"name": "tag-check", "namespace": "app-ns"},
		"spec": {
			"template": {
				"spec": {
					"restartPolicy": "Never",
					"containers": [
						{
							"name": "explicit-latest-unset",
							"image": "curlimages/curl:latest",
							"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						},
						{
							"name": "untagged-ifnp",
							"image": "busybox",
							"imagePullPolicy": "IfNotPresent",
							"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						},
						{
							"name": "port-untagged",
							"image": "localhost:5000/app",
							"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						},
						{
							"name": "latest-always",
							"image": "cloudflare/cloudflared:latest",
							"imagePullPolicy": "Always",
							"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						},
						{
							"name": "pinned-tag",
							"image": "nginx:1.27",
							"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						},
						{
							"name": "digest-with-latest",
							"image": "alpine:latest@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
							"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						},
						{
							"name": "digest-without-tag",
							"image": "ghcr.io/foo/bar@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
							"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						},
						{
							"name": "port-pinned-tag",
							"image": "localhost:5000/app:v1.0.0",
							"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						},
					],
				},
			},
		},
	}
	denies := main.deny with input as [job] with data.env as "common"
	warns := main.warn with input as [job] with data.env as "common"
	count(denies) == 0
	count(warns) == 3
	some w1 in warns
	contains(w1, "explicit-latest-unset")
	some w2 in warns
	contains(w2, "untagged-ifnp")
	some w3 in warns
	contains(w3, "port-untagged")
}

# WorkflowTemplate / Job の自前イメージは deny、非自前 :latest は warn となる（重複なし）
test_workflow_template_and_job_own_vs_third_party_latest if {
	wf := {
		"apiVersion": "argoproj.io/v1alpha1",
		"kind": "WorkflowTemplate",
		"metadata": {"name": "mixed-wf", "namespace": "app-ns"},
		"spec": {
			"templates": [
				{
					"name": "own-step",
					"container": {
						"image": "ghcr.io/k-wa-wa/etl:latest",
						"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
					},
				},
				{
					"name": "third-party-step",
					"container": {
						"image": "curlimages/curl:latest",
						"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
					},
				},
			],
		},
	}
	denies_wf := main.deny with input as [wf] with data.env as "common"
	warns_wf := main.warn with input as [wf] with data.env as "common"
	count(denies_wf) == 1
	count(warns_wf) == 1
	some dw in denies_wf
	contains(dw, "own-step")
	some ww in warns_wf
	contains(ww, "third-party-step")

	job := {
		"apiVersion": "batch/v1",
		"kind": "Job",
		"metadata": {"name": "mixed-job", "namespace": "app-ns"},
		"spec": {
			"template": {
				"spec": {
					"restartPolicy": "Never",
					"initContainers": [{
						"name": "load",
						"image": "ghcr.io/k-wa-wa/pechka/etl-load:latest",
						"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
					}],
					"containers": [{
						"name": "setup",
						"image": "curlimages/curl:latest",
						"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
					}],
				},
			},
		},
	}
	denies_job := main.deny with input as [job] with data.env as "common"
	warns_job := main.warn with input as [job] with data.env as "common"
	count(denies_job) == 1
	count(warns_job) == 1
	some dj in denies_job
	contains(dj, "init:load")
	some wj in warns_job
	contains(wj, "setup")
}

# 例外系: keel.sh/policy: "never" が設定されたワークロードは trigger: poll 併記でも Keel 監視対象から除外される
test_keel_policy_never_excluded if {
	dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "keel-never",
			"namespace": "app-ns",
			"annotations": {
				"keel.sh/policy": "never",
				"keel.sh/trigger": "poll",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "keel-never"}},
				"spec": {
					"containers": [{
						"name": "web",
						"image": "nginx:1.27.0",
						"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						"readinessProbe": {"httpGet": {"path": "/", "port": 80}},
						"livenessProbe": {"httpGet": {"path": "/", "port": 80}},
					}],
				},
			},
		},
	}
	denies := main.deny with input as [dep] with data.env as "common"
	warns := main.warn with input as [dep] with data.env as "common"
	count(denies) == 0
	count(warns) == 0

	dep_latest := json.patch(dep, [{
		"op": "replace",
		"path": "/spec/template/spec/containers/0/image",
		"value": "nginx:latest",
	}])
	denies_latest := main.deny with input as [dep_latest] with data.env as "common"
	warns_latest := main.warn with input as [dep_latest] with data.env as "common"
	count(denies_latest) == 0
	count(warns_latest) == 1
}

# 例外系: Helm 管理サードパーティワークロードは Keel / :latest 双方のチェックから除外される
test_helm_excluded_skips_keel_and_latest_checks if {
	helm_dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "helm-keel-third-party",
			"namespace": "monitoring",
			"labels": {"helm.sh/chart": "sample-1.0.0"},
			"annotations": {
				"keel.sh/policy": "force",
				"keel.sh/trigger": "poll",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "helm-keel-third-party"}},
				"spec": {
					"containers": [{
						"name": "sidecar",
						"image": "busybox:latest",
					}],
				},
			},
		},
	}
	denies := main.deny with input as [helm_dep] with data.env as "common"
	warns := main.warn with input as [helm_dep] with data.env as "common"
	count(denies) == 0
	count(warns) == 0
}

# 異常系・正常系: CronJob (jobTemplate) の Keel 監視対象コンテナで imagePullPolicy: Always が必須となる
test_cronjob_keel_monitored_requires_pull_policy_always if {
	cj := {
		"apiVersion": "batch/v1",
		"kind": "CronJob",
		"metadata": {
			"name": "keel-cron",
			"namespace": "app-ns",
			"annotations": {
				"keel.sh/policy": "force",
				"keel.sh/trigger": "poll",
				"keel.sh/matchTag": "true",
				"keel.sh/monitorContainers": "runner",
			},
		},
		"spec": {
			"schedule": "0 * * * *",
			"jobTemplate": {
				"spec": {
					"template": {
						"spec": {
							"restartPolicy": "OnFailure",
							"containers": [{
								"name": "runner",
								"image": "alpine:3.21",
								"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
							}],
						},
					},
				},
			},
		},
	}
	denies := main.deny with input as [cj] with data.env as "common"
	count(denies) == 1
	some m in denies
	contains(m, "Keel 監視対象")
	contains(m, "runner")

	cj_always := json.patch(cj, [{
		"op": "add",
		"path": "/spec/jobTemplate/spec/template/spec/containers/0/imagePullPolicy",
		"value": "Always",
	}])
	denies_ok := main.deny with input as [cj_always] with data.env as "common"
	count(denies_ok) == 0
}

# 異常系: 非自前イメージのみの Keel ワークロードや CronJob でも monitorContainers の不正正規表現は deny される
test_keel_invalid_monitor_containers_regex_denied_for_non_own_workloads if {
	dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "third-party-bad-regex",
			"namespace": "app-ns",
			"annotations": {
				"keel.sh/policy": "force",
				"keel.sh/trigger": "poll",
				"keel.sh/monitorContainers": "[unclosed",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "third-party-bad-regex"}},
				"spec": {
					"containers": [{
						"name": "web",
						"image": "nginx:1.27.0",
						"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
						"readinessProbe": {"httpGet": {"path": "/", "port": 80}},
						"livenessProbe": {"httpGet": {"path": "/", "port": 80}},
					}],
				},
			},
		},
	}
	denies_dep := main.deny with input as [dep] with data.env as "common"
	count(denies_dep) == 1
	some md in denies_dep
	contains(md, "有効な正規表現ではない")

	cj := {
		"apiVersion": "batch/v1",
		"kind": "CronJob",
		"metadata": {
			"name": "cron-bad-regex",
			"namespace": "app-ns",
			"annotations": {
				"keel.sh/trigger": "poll",
				"keel.sh/monitorContainers": "[unclosed",
			},
		},
		"spec": {
			"schedule": "0 * * * *",
			"jobTemplate": {
				"spec": {
					"template": {
						"spec": {
							"restartPolicy": "OnFailure",
							"containers": [{
								"name": "runner",
								"image": "alpine:3.21",
								"resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"memory": "32Mi"}},
							}],
						},
					},
				},
			},
		},
	}
	denies_cj := main.deny with input as [cj] with data.env as "common"
	count(denies_cj) == 1
	some mc in denies_cj
	contains(mc, "有効な正規表現ではない")
}

# 境界系: 自前イメージかつ Keel 監視対象のコンテナで imagePullPolicy 欠落時は deny が 1 件のみになり warn も重複しない
test_own_image_and_keel_monitored_single_deny_no_duplicate if {
	bad := json.patch(valid_own_deployment, [{
		"op": "remove",
		"path": "/spec/template/spec/containers/0/imagePullPolicy",
	}])
	denies := main.deny with input as [bad, valid_pdb] with data.env as "prod"
	warns := main.warn with input as [bad, valid_pdb] with data.env as "prod"
	count(denies) == 1
	count(warns) == 0
	some m in denies
	contains(m, "自前イメージ")
	not contains(m, "Keel 監視対象")
}
