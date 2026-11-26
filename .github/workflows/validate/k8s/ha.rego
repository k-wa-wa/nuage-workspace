package main

import rego.v1

# prod 環境のみで適用する無停止・高可用性（HA）ポリシー。
#
# なぜこのルールが必要か:
# 1. 無停止デプロイと障害・メンテナンス耐性の担保:
#    prod 環境のステートレス Deployment が単一レプリカや単一ノードに偏っていると、ノード障害や
#    Kubernetes のアップグレード・ノードドレイン時にサービスが全断する。そのため以下を必須とする。
#    - replicas >= 2（または HPA の minReplicas >= 2）による冗長化
#    - topologySpreadConstraints または podAntiAffinity（topologyKey: kubernetes.io/hostname）によるノード分散
#    - minAvailable / maxUnavailable がドレインを許容する PodDisruptionBudget の存在
# 2. 対象外とオプトアウト:
#    ReadWriteOnce / ReadWriteOncePod PVC を参照するワークロードは複数 Pod 同時マウント不可のため自動除外する。
#    それ以外でやむを得ず単一構成にする場合は nuage.io/ignore-ha: "true" でオプトアウトする。

# ReadWriteOnce / ReadWriteOncePod PVC の判定
is_rwo_pvc(pvc) if {
	pvc.kind == "PersistentVolumeClaim"
	modes := object.get(object.get(pvc, "spec", {}), "accessModes", [])
	some mode in modes
	mode in {"ReadWriteOnce", "ReadWriteOncePod"}
}

same_namespace(a, b) if {
	ns_a := object.get(object.get(a, "metadata", {}), "namespace", "")
	ns_b := object.get(object.get(b, "metadata", {}), "namespace", "")
	ns_a == ns_b
} else if {
	ns_a := object.get(object.get(a, "metadata", {}), "namespace", "")
	ns_a == ""
} else if {
	ns_b := object.get(object.get(b, "metadata", {}), "namespace", "")
	ns_b == ""
}

uses_rwo_pvc(doc) if {
	spec := pod_spec(doc)
	vols := object.get(spec, "volumes", [])
	some vol in vols
	claim_name := vol.persistentVolumeClaim.claimName
	some pvc in docs
	is_rwo_pvc(pvc)
	pvc.metadata.name == claim_name
	same_namespace(doc, pvc)
}

# HA 検証対象 Deployment かどうか
ha_target_deployment(doc) if {
	target_env == "prod"
	doc.kind == "Deployment"
	not has_annotation(doc, "nuage.io/ignore-ha")
	not is_helm_excluded(doc)
	not uses_rwo_pvc(doc)
}

# HPA による最小レプリカ指定の確認
hpa_min_replicas(doc) := min_rep if {
	some hpa in docs
	hpa.kind == "HorizontalPodAutoscaler"
	same_namespace(doc, hpa)
	ref := object.get(object.get(hpa, "spec", {}), "scaleTargetRef", {})
	ref.kind == "Deployment"
	ref.name == doc.metadata.name
	min_rep := object.get(hpa.spec, "minReplicas", 1)
}

effective_replicas(doc) := hpa_min_replicas(doc) if {
	not doc.spec.replicas
	hpa_min_replicas(doc)
} else := object.get(object.get(doc, "spec", {}), "replicas", 1)

# 1. replicas >= 2
deny contains msg if {
	some doc in docs
	ha_target_deployment(doc)
	rep := effective_replicas(doc)
	rep < 2
	msg := sprintf("%s: prod 環境のステートレス Deployment は無停止運用のため replicas >= 2 が必須である (現在: %d)", [resource_id(doc), rep])
}

# 2. ノード分散設定 (topologySpreadConstraints または podAntiAffinity)
has_hostname_spread(doc) if {
	spec := pod_spec(doc)
	constraints := object.get(spec, "topologySpreadConstraints", [])
	some c in constraints
	c.topologyKey == "kubernetes.io/hostname"
}

has_hostname_spread(doc) if {
	spec := pod_spec(doc)
	anti := object.get(object.get(spec, "affinity", {}), "podAntiAffinity", {})
	some term in object.get(anti, "requiredDuringSchedulingIgnoredDuringExecution", [])
	term.topologyKey == "kubernetes.io/hostname"
}

has_hostname_spread(doc) if {
	spec := pod_spec(doc)
	anti := object.get(object.get(spec, "affinity", {}), "podAntiAffinity", {})
	some pref in object.get(anti, "preferredDuringSchedulingIgnoredDuringExecution", [])
	pref.podAffinityTerm.topologyKey == "kubernetes.io/hostname"
}

deny contains msg if {
	some doc in docs
	ha_target_deployment(doc)
	not has_hostname_spread(doc)
	msg := sprintf("%s: prod 環境のステートレス Deployment にはノード分散設定 (topologySpreadConstraints または podAntiAffinity の topologyKey: kubernetes.io/hostname) が必須である", [resource_id(doc)])
}

# 3. PodDisruptionBudget の存在と無停止許容設定
labels_match(selector_labels, pod_labels) if {
	count(selector_labels) > 0
	every k, v in selector_labels {
		pod_labels[k] == v
	}
}

valid_pdb_budget(pdb, replicas) if {
	min_avail := pdb.spec.minAvailable
	is_number(min_avail)
	min_avail >= 1
	min_avail < replicas
} else if {
	min_avail := pdb.spec.minAvailable
	is_string(min_avail)
	min_avail != "0%"
	min_avail != "100%"
} else if {
	max_unavail := pdb.spec.maxUnavailable
	is_number(max_unavail)
	max_unavail >= 1
	max_unavail < replicas
} else if {
	max_unavail := pdb.spec.maxUnavailable
	is_string(max_unavail)
	max_unavail != "0%"
	max_unavail != "100%"
}

has_matching_valid_pdb(doc) if {
	pod_labels := object.get(object.get(object.get(doc, "spec", {}), "template", {}), "metadata", {}).labels
	rep := effective_replicas(doc)
	some pdb in docs
	pdb.kind == "PodDisruptionBudget"
	same_namespace(doc, pdb)
	sel := object.get(object.get(object.get(pdb, "spec", {}), "selector", {}), "matchLabels", {})
	labels_match(sel, pod_labels)
	valid_pdb_budget(pdb, rep)
}

has_matching_any_pdb(doc) if {
	pod_labels := object.get(object.get(object.get(doc, "spec", {}), "template", {}), "metadata", {}).labels
	some pdb in docs
	pdb.kind == "PodDisruptionBudget"
	same_namespace(doc, pdb)
	sel := object.get(object.get(object.get(pdb, "spec", {}), "selector", {}), "matchLabels", {})
	labels_match(sel, pod_labels)
}

deny contains msg if {
	some doc in docs
	ha_target_deployment(doc)
	not has_matching_any_pdb(doc)
	msg := sprintf("%s: prod 環境のステートレス Deployment に対応する PodDisruptionBudget が存在しない", [resource_id(doc)])
}

deny contains msg if {
	some doc in docs
	ha_target_deployment(doc)
	has_matching_any_pdb(doc)
	not has_matching_valid_pdb(doc)
	msg := sprintf("%s: 対応する PodDisruptionBudget の設定が無停止・ドレイン許容条件 (minAvailable >= 1 かつ < replicas、または maxUnavailable >= 1 かつ < replicas 等) を満たしていない", [resource_id(doc)])
}
