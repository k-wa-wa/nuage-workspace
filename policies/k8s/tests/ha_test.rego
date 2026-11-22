package main_test

import rego.v1

import data.main

ha_deployment_base := {
	"apiVersion": "apps/v1",
	"kind": "Deployment",
	"metadata": {
		"name": "web",
		"namespace": "prod-ns",
		"annotations": {
			"keel.sh/policy": "force",
			"keel.sh/trigger": "poll",
			"keel.sh/matchTag": "true",
			"keel.sh/monitorContainers": "web",
		},
	},
	"spec": {
		"replicas": 2,
		"template": {
			"metadata": {"labels": {"app": "web"}},
			"spec": {
				"containers": [{
					"name": "web",
					"image": "ghcr.io/k-wa-wa/web:latest",
					"imagePullPolicy": "Always",
					"resources": {
						"requests": {"cpu": "50m", "memory": "64Mi"},
						"limits": {"cpu": "200m", "memory": "128Mi"},
					},
					"readinessProbe": {"httpGet": {"path": "/health", "port": 8080}},
					"livenessProbe": {"httpGet": {"path": "/health", "port": 8080}},
				}],
			},
		},
	},
}

ha_pdb := {
	"apiVersion": "policy/v1",
	"kind": "PodDisruptionBudget",
	"metadata": {"name": "web-pdb", "namespace": "prod-ns"},
	"spec": {
		"maxUnavailable": 1,
		"selector": {"matchLabels": {"app": "web"}},
	},
}

# 正常系: podAntiAffinity (hostname) + replicas >= 2 + PDB(maxUnavailable: 1) は prod で通過する
test_prod_ha_with_anti_affinity_and_pdb_passes if {
	dep := json.patch(ha_deployment_base, [{
		"op": "add",
		"path": "/spec/template/spec/affinity",
		"value": {"podAntiAffinity": {"preferredDuringSchedulingIgnoredDuringExecution": [{
			"weight": 100,
			"podAffinityTerm": {
				"topologyKey": "kubernetes.io/hostname",
				"labelSelector": {"matchLabels": {"app": "web"}},
			},
		}]}},
	}])
	denies := main.deny with input as [dep, ha_pdb] with data.env as "prod"
	count(denies) == 0
}

# 異常系: prod で replicas: 1、分散設定なし、PDB なしをすべて検知する
test_prod_ha_violations_detected if {
	bad := json.patch(ha_deployment_base, [{
		"op": "replace",
		"path": "/spec/replicas",
		"value": 1,
	}])
	denies := main.deny with input as [bad] with data.env as "prod"
	some m1 in denies
	contains(m1, "replicas >= 2")
	some m2 in denies
	contains(m2, "ノード分散設定")
	some m3 in denies
	contains(m3, "PodDisruptionBudget")
}

# 異常系: PDB の maxUnavailable: 0 はドレイン不能のため検知する
test_prod_invalid_pdb_budget_detected if {
	dep := json.patch(ha_deployment_base, [{
		"op": "add",
		"path": "/spec/template/spec/topologySpreadConstraints",
		"value": [{"maxSkew": 1, "topologyKey": "kubernetes.io/hostname", "whenUnsatisfiable": "DoNotSchedule"}],
	}])
	bad_pdb := json.patch(ha_pdb, [{
		"op": "replace",
		"path": "/spec/maxUnavailable",
		"value": 0,
	}])
	denies := main.deny with input as [dep, bad_pdb] with data.env as "prod"
	some msg in denies
	contains(msg, "無停止・ドレイン許容条件")
}

# 例外系: ReadWriteOnce PVC を参照する Deployment は prod HA チェック対象外となる
test_rwo_pvc_deployment_excluded_from_ha if {
	dep := {
		"apiVersion": "apps/v1",
		"kind": "Deployment",
		"metadata": {
			"name": "pwa-backend",
			"namespace": "mon-ns",
			"annotations": {
				"keel.sh/policy": "force",
				"keel.sh/trigger": "poll",
				"keel.sh/matchTag": "true",
				"keel.sh/monitorContainers": "backend",
			},
		},
		"spec": {
			"replicas": 1,
			"template": {
				"metadata": {"labels": {"app": "pwa-backend"}},
				"spec": {
					"containers": [{
						"name": "backend",
						"image": "ghcr.io/k-wa-wa/pwa-backend:latest",
						"imagePullPolicy": "Always",
						"resources": {
							"requests": {"cpu": "50m", "memory": "64Mi"},
							"limits": {"cpu": "200m", "memory": "128Mi"},
						},
						"readinessProbe": {"httpGet": {"path": "/health", "port": 8080}},
						"livenessProbe": {"httpGet": {"path": "/health", "port": 8080}},
					}],
					"volumes": [{
						"name": "db",
						"persistentVolumeClaim": {"claimName": "pwa-db"},
					}],
				},
			},
		},
	}
	pvc := {
		"apiVersion": "v1",
		"kind": "PersistentVolumeClaim",
		"metadata": {"name": "pwa-db", "namespace": "mon-ns"},
		"spec": {"accessModes": ["ReadWriteOnce"]},
	}
	denies := main.deny with input as [dep, pvc] with data.env as "prod"
	count(denies) == 0
}

# 例外系: preview 環境では replicas: 1 / 分散なし / PDB なしでも HA 違反にならない
test_preview_skips_ha_checks if {
	ns := {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "app-preview"}}
	dep := json.patch(ha_deployment_base, [
		{"op": "remove", "path": "/metadata/namespace"},
		{"op": "replace", "path": "/spec/replicas", "value": 1},
	])
	denies := main.deny with input as [ns, dep] with data.env as "preview"
	count(denies) == 0
}
