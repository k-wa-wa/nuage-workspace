package main

import rego.v1

# 1. 自前イメージおよび Keel 監視対象コンテナに imagePullPolicy: Always が必須
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

keel_enabled(policy, _) if {
	policy != ""
}

keel_enabled(_, trigger) if {
	trigger == "poll"
}

keel_monitored_workload(doc) if {
	doc.kind in {"Deployment", "StatefulSet", "DaemonSet", "CronJob"}
	not has_annotation(doc, "nuage.io/ignore-image-pull-policy")
	not is_helm_excluded(doc)
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	policy := trim_space(object.get(annotations, "keel.sh/policy", ""))
	trigger := trim_space(object.get(annotations, "keel.sh/trigger", ""))
	policy != "never"
	keel_enabled(policy, trigger)
}

keel_monitored_container(doc, c) if {
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	pattern := trim_space(object.get(annotations, "keel.sh/monitorContainers", ""))
	pattern != ""
	regex.is_valid(pattern)
	cname := object.get(c, "name", "")
	regex.match(pattern, cname)
} else if {
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	pattern := trim_space(object.get(annotations, "keel.sh/monitorContainers", ""))
	pattern == ""
}

is_keel_monitored_entry(doc, entry) if {
	keel_monitored_workload(doc)
	some c in workload_containers(doc)
	keel_monitored_container(doc, c)
	entry.name == object.get(c, "name", "<unnamed>")
}

deny contains msg if {
	some doc in docs
	keel_monitored_workload(doc)
	some c in workload_containers(doc)
	keel_monitored_container(doc, c)
	img := object.get(c, "image", "")
	not is_own_image(img)
	pull_policy := object.get(c, "imagePullPolicy", "")
	pull_policy != "Always"
	msg := sprintf("%s: コンテナ %q は Keel 監視対象 (%s) のため imagePullPolicy: Always が必須である (現在: %q)", [
		resource_id(doc),
		object.get(c, "name", "<unnamed>"),
		img,
		pull_policy,
	])
}

# 1b. :latest タグまたはタグ省略（暗黙 :latest）で imagePullPolicy != Always の場合は警告する
is_latest_or_untagged(img) if {
	img != ""
	not contains(img, "@")
	parts := split(img, "/")
	last := parts[count(parts) - 1]
	last != ""
	is_latest_or_untagged_segment(last)
}

is_latest_or_untagged_segment(seg) if {
	not contains(seg, ":")
}

is_latest_or_untagged_segment(seg) if {
	endswith(seg, ":latest")
}

warn contains msg if {
	some doc in docs
	not has_annotation(doc, "nuage.io/ignore-image-pull-policy")
	not is_helm_excluded(doc)
	some entry in all_containers_including_init(doc)
	img := object.get(entry.container, "image", "")
	not is_own_image(img)
	not is_keel_monitored_entry(doc, entry)
	is_latest_or_untagged(img)
	pull_policy := object.get(entry.container, "imagePullPolicy", "")
	pull_policy != "Always"
	msg := sprintf("%s: コンテナ %q は :latest またはタグ省略イメージ (%s) を使用しているため imagePullPolicy: Always の明示、または固定タグ + nuage.io/ignore-image-pull-policy の検討を推奨する (現在: %q)", [
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
	policy := object.get(annotations, "keel.sh/policy", "")
	policy != "force"
	msg := sprintf("%s: 自前イメージを利用する Deployment には keel.sh/policy: \"force\" が必須である (現在: %q)", [resource_id(doc), policy])
}

deny contains msg if {
	some doc in docs
	keel_target_deployment(doc)
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	trigger := object.get(annotations, "keel.sh/trigger", "")
	trigger != "poll"
	msg := sprintf("%s: 自前イメージを利用する Deployment には keel.sh/trigger: \"poll\" が必須である (現在: %q)", [resource_id(doc), trigger])
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
	pattern := trim_space(monitored_raw)
	pattern != ""
	not regex.is_valid(pattern)
	msg := sprintf("%s: keel.sh/monitorContainers (%q) は有効な正規表現ではない", [
		resource_id(doc),
		monitored_raw,
	])
}

deny contains msg if {
	some doc in docs
	keel_target_deployment(doc)
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	monitored_raw := object.get(annotations, "keel.sh/monitorContainers", "")
	pattern := trim_space(monitored_raw)
	pattern != ""
	regex.is_valid(pattern)
	some cname in own_image_container_names(doc)
	not regex.match(pattern, cname)
	msg := sprintf("%s: keel.sh/monitorContainers (%q) の正規表現が自前イメージ利用コンテナ %q に一致しない", [
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
