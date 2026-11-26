package main

import rego.v1

# コンテナのリソース要求・上限（requests / limits）の設定を検証するルール。
#
# なぜこのルールが必要か:
# 1. requests（cpu, memory）と limits（memory）が必須である理由:
#    requests が未設定だと kube-scheduler がノードの空き容量を正確に見積もれず、ノード過負荷や
#    スケジューリング不安定を引き起こす。また memory limits が未設定だと、1 コンテナのメモリリークや
#    スパイクがノード全体の OOM を誘発し、同居する正常なワークロードまで巻き込んで停止させる。
# 2. initContainers を deny ではなく warn とする理由:
#    initContainers は起動時のみ動作する短命コンテナであり、既存マニフェストとの互換性を保ちつつ
#    リソース未設定箇所を段階的に可視化・是正できるよう警告として扱う。
# 3. オプトアウト方法:
#    特殊な事情で設定を除外する場合は nuage.io/ignore-resources: "true" を付与する
#    （Helm 管理のサードパーティリソースは既定で除外される）。

# 全コンテナに resources.requests と resources.limits が必須
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
