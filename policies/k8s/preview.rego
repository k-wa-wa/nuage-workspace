package main

import rego.v1

# preview 環境のみで適用するポリシー

# 1. クラスタ全体や他環境に波及するリソースの誤混入禁止
forbidden_preview_kinds := {
	"ClusterRole",
	"ClusterRoleBinding",
	"CustomResourceDefinition",
	"PriorityClass",
	"MutatingWebhookConfiguration",
	"ValidatingWebhookConfiguration",
	"StorageClass",
	"PersistentVolume",
	"IngressClass",
	"ClusterIssuer",
	"DaemonSet",
	"VMRule",
	"VMAlert",
	"VMAlertmanager",
	"VMAgent",
	"VMServiceScrape",
	"VMPodScrape",
	"VMProbe",
	"VMNodeScrape",
	"VMStaticScrape",
	"VMScrapeConfig",
	"PrometheusRule",
	"ServiceMonitor",
	"PodMonitor",
}

cluster_scoped_kinds := {
	"Namespace",
	"ClusterRole",
	"ClusterRoleBinding",
	"CustomResourceDefinition",
	"PriorityClass",
	"MutatingWebhookConfiguration",
	"ValidatingWebhookConfiguration",
	"StorageClass",
	"PersistentVolume",
	"IngressClass",
	"ClusterIssuer",
	"Node",
}

deny contains msg if {
	target_env == "preview"
	some doc in docs
	doc.kind in forbidden_preview_kinds
	not has_annotation(doc, "nuage.io/allow-in-preview")
	msg := sprintf("%s: preview 環境にクラスタ全体または他環境へ波及するリソース (%s) を含めることは禁止されている", [resource_id(doc), doc.kind])
}

# 2. preview ApplicationSet 前提との整合性チェック
preview_namespaces := [doc |
	some doc in docs
	doc.kind == "Namespace"
]

deny contains msg if {
	target_env == "preview"
	count(preview_namespaces) == 0
	msg := "preview 環境には Argo CD ApplicationSet の置換・自動削除対象となる Namespace リソースが1つ必要である"
}

deny contains msg if {
	target_env == "preview"
	count(preview_namespaces) > 1
	names := [ns.metadata.name | some ns in preview_namespaces]
	msg := sprintf("preview 環境には Namespace リソースが1つのみ必要であるが %d 個存在する: %v", [count(preview_namespaces), names])
}

preview_namespace_name := preview_namespaces[0].metadata.name if {
	count(preview_namespaces) == 1
}

# RoleBinding の subjects[].namespace が preview Namespace と異なる場合は権限参照が壊れるため禁止
deny contains msg if {
	target_env == "preview"
	preview_namespace_name != ""
	some doc in docs
	doc.kind == "RoleBinding"
	some subj in object.get(doc, "subjects", [])
	subj_ns := object.get(subj, "namespace", "")
	subj_ns != ""
	subj_ns != preview_namespace_name
	msg := sprintf("%s: RoleBinding の subject (%s) の namespace が %q に固定されており、preview Namespace (%q) と不整合である", [
		resource_id(doc),
		object.get(subj, "name", "<unnamed>"),
		subj_ns,
		preview_namespace_name,
	])
}

# 名前空間スコープリソースに別 namespace が直書きされている場合は警告する
# (Argo CD の kustomize.namespace が上書きするが、手動 apply 時等の誤爆リスクがあるため)
warn contains msg if {
	target_env == "preview"
	preview_namespace_name != ""
	some doc in docs
	not doc.kind in cluster_scoped_kinds
	ns := object.get(object.get(doc, "metadata", {}), "namespace", "")
	ns != ""
	ns != preview_namespace_name
	msg := sprintf("%s: preview リソースの metadata.namespace が %q に固定されている (preview Namespace は %q)", [
		resource_id(doc),
		ns,
		preview_namespace_name,
	])
}

# 3. preview Ingress の ApplicationSet JSON Patch 前提構造と本番ドメイン直書きチェック
deny contains msg if {
	target_env == "preview"
	some doc in docs
	doc.kind == "Ingress"
	rules := object.get(object.get(doc, "spec", {}), "rules", [])
	count(rules) == 0
	msg := sprintf("%s: preview Ingress には ApplicationSet の置換対象となる spec.rules[0] が必須である", [resource_id(doc)])
}

deny contains msg if {
	target_env == "preview"
	some doc in docs
	doc.kind == "Ingress"
	rules := object.get(object.get(doc, "spec", {}), "rules", [])
	count(rules) > 0
	host := object.get(rules[0], "host", "")
	trim_space(host) == ""
	msg := sprintf("%s: preview Ingress には ApplicationSet の置換対象となる spec.rules[0].host が必須である", [resource_id(doc)])
}

deny contains msg if {
	target_env == "preview"
	some doc in docs
	doc.kind == "Ingress"
	tls := object.get(object.get(doc, "spec", {}), "tls", [])
	count(tls) == 0
	msg := sprintf("%s: preview Ingress には ApplicationSet の置換対象となる spec.tls[0] が必須である", [resource_id(doc)])
}

deny contains msg if {
	target_env == "preview"
	some doc in docs
	doc.kind == "Ingress"
	tls := object.get(object.get(doc, "spec", {}), "tls", [])
	count(tls) > 0
	hosts := object.get(tls[0], "hosts", [])
	count(hosts) == 0
	msg := sprintf("%s: preview Ingress には ApplicationSet の置換対象となる spec.tls[0].hosts[0] が必須である", [resource_id(doc)])
}

deny contains msg if {
	target_env == "preview"
	some doc in docs
	doc.kind == "Ingress"
	tls := object.get(object.get(doc, "spec", {}), "tls", [])
	count(tls) > 0
	secret := object.get(tls[0], "secretName", "")
	trim_space(secret) == ""
	msg := sprintf("%s: preview Ingress には ApplicationSet の置換対象となる spec.tls[0].secretName が必須である", [resource_id(doc)])
}

is_prod_like_host(host) if {
	endswith(host, ".wpcapp.net")
	not contains(host, "-pr-")
} else if {
	endswith(host, ".cluster.wpc")
}

deny contains msg if {
	target_env == "preview"
	some doc in docs
	doc.kind == "Ingress"
	some rule in object.get(object.get(doc, "spec", {}), "rules", [])
	host := object.get(rule, "host", "")
	is_prod_like_host(host)
	msg := sprintf("%s: preview Ingress に本番ホスト (%q) が直書きされている。DUMMY 等のプレースホルダを使用すること", [resource_id(doc), host])
}

deny contains msg if {
	target_env == "preview"
	some doc in docs
	doc.kind == "Ingress"
	some t in object.get(object.get(doc, "spec", {}), "tls", [])
	some host in object.get(t, "hosts", [])
	is_prod_like_host(host)
	msg := sprintf("%s: preview Ingress の TLS ホストに本番ホスト (%q) が直書きされている。DUMMY 等のプレースホルダを使用すること", [resource_id(doc), host])
}
