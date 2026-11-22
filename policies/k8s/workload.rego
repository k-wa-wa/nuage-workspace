package main

import rego.v1

# 1. 自前イメージを使う全コンテナに imagePullPolicy: Always が必須
deny contains msg if {
	some doc in docs
	not has_annotation(doc, "nuage.io/ignore-image-pull-policy")
	some entry in all_containers_including_init(doc)
	img := object.get(entry.container, "image", "")
	is_own_image(img)
	pull_policy := object.get(entry.container, "imagePullPolicy", "")
	pull_policy != "Always"
	msg := sprintf("%s: コンテナ %q は自前イメージ (%s) を使用しているため imagePullPolicy: Always が必須である (現在: %q)", [
		resource_id(doc),
		entry.name,
		img,
		pull_policy,
	])
}

# 2. 自前イメージを使う Deployment に keel.sh/* アノテーションが必須
own_image_container_names(doc) := [c.name |
	some c in workload_containers(doc)
	img := object.get(c, "image", "")
	is_own_image(img)
]

keel_target_deployment(doc) if {
	doc.kind == "Deployment"
	not has_annotation(doc, "nuage.io/ignore-keel")
	not is_helm_excluded(doc)
	count(own_image_container_names(doc)) > 0
}

deny contains msg if {
	some doc in docs
	keel_target_deployment(doc)
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	some key in ["keel.sh/policy", "keel.sh/trigger"]
	val := object.get(annotations, key, "")
	trim_space(val) == ""
	msg := sprintf("%s: 自前イメージを利用する Deployment には %s アノテーションが必須である", [resource_id(doc), key])
}

deny contains msg if {
	some doc in docs
	keel_target_deployment(doc)
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	match_tag := object.get(annotations, "keel.sh/matchTag", "")
	match_tag != "true"
	msg := sprintf("%s: 自前イメージを利用する Deployment には keel.sh/matchTag: \"true\" が必須である (現在: %q)", [resource_id(doc), match_tag])
}

deny contains msg if {
	some doc in docs
	keel_target_deployment(doc)
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	monitored_raw := object.get(annotations, "keel.sh/monitorContainers", "")
	trim_space(monitored_raw) == ""
	msg := sprintf("%s: 自前イメージを利用する Deployment には keel.sh/monitorContainers アノテーションが必須である (対象コンテナ: %v)", [
		resource_id(doc),
		own_image_container_names(doc),
	])
}

deny contains msg if {
	some doc in docs
	keel_target_deployment(doc)
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	monitored_raw := object.get(annotations, "keel.sh/monitorContainers", "")
	trim_space(monitored_raw) != ""
	monitored := {trim_space(item) | some item in split(monitored_raw, ",")}
	some cname in own_image_container_names(doc)
	not cname in monitored
	msg := sprintf("%s: keel.sh/monitorContainers (%q) に自前イメージ利用コンテナ %q が含まれていない", [
		resource_id(doc),
		monitored_raw,
		cname,
	])
}

# 3. 全コンテナに resources.requests と resources.limits が必須
has_valid_requests(res) if {
	reqs := object.get(res, "requests", {})
	object.get(reqs, "cpu", "") != ""
	object.get(reqs, "memory", "") != ""
}

has_valid_limits(res) if {
	lims := object.get(res, "limits", {})
	object.get(lims, "memory", "") != ""
}

deny contains msg if {
	some doc in docs
	not has_annotation(doc, "nuage.io/ignore-resources")
	not is_helm_excluded(doc)
	some entry in all_main_containers(doc)
	res := object.get(entry.container, "resources", {})
	not has_valid_requests(res)
	msg := sprintf("%s: コンテナ %q に resources.requests (cpu, memory) が設定されていない", [resource_id(doc), entry.name])
}

deny contains msg if {
	some doc in docs
	not has_annotation(doc, "nuage.io/ignore-resources")
	not is_helm_excluded(doc)
	some entry in all_main_containers(doc)
	res := object.get(entry.container, "resources", {})
	not has_valid_limits(res)
	msg := sprintf("%s: コンテナ %q に resources.limits (memory) が設定されていない", [resource_id(doc), entry.name])
}

# initContainers の resources 欠落は警告として可視化する
warn contains msg if {
	some doc in docs
	not has_annotation(doc, "nuage.io/ignore-resources")
	not is_helm_excluded(doc)
	some c in workload_init_containers(doc)
	res := object.get(c, "resources", {})
	not has_valid_requests(res)
	msg := sprintf("%s: initContainer %q に resources.requests (cpu, memory) の設定を推奨する", [resource_id(doc), object.get(c, "name", "<unnamed>")])
}

warn contains msg if {
	some doc in docs
	not has_annotation(doc, "nuage.io/ignore-resources")
	not is_helm_excluded(doc)
	some c in workload_init_containers(doc)
	res := object.get(c, "resources", {})
	not has_valid_limits(res)
	msg := sprintf("%s: initContainer %q に resources.limits (memory) の設定を推奨する", [resource_id(doc), object.get(c, "name", "<unnamed>")])
}

# 4. 常駐ワークロード (Deployment / StatefulSet / DaemonSet) に readinessProbe / livenessProbe が必須
probe_target_workload(doc) if {
	doc.kind in {"Deployment", "StatefulSet", "DaemonSet"}
	not has_annotation(doc, "nuage.io/ignore-probes")
	not is_helm_excluded(doc)
}

deny contains msg if {
	some doc in docs
	probe_target_workload(doc)
	some c in workload_containers(doc)
	not c.readinessProbe
	msg := sprintf("%s: コンテナ %q に readinessProbe が設定されていない", [resource_id(doc), object.get(c, "name", "<unnamed>")])
}

deny contains msg if {
	some doc in docs
	probe_target_workload(doc)
	some c in workload_containers(doc)
	not c.livenessProbe
	msg := sprintf("%s: コンテナ %q に livenessProbe が設定されていない", [resource_id(doc), object.get(c, "name", "<unnamed>")])
}
