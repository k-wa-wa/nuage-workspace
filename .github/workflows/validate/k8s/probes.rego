package main

import rego.v1

# 常駐ワークロード（Deployment / StatefulSet / DaemonSet）のヘルスチェック設定を検証するルール。
#
# なぜこのルールが必要か:
# 1. readinessProbe / livenessProbe が必須である理由:
#    readinessProbe が無いと、起動直後の初期化未完了な Pod や一時的に過負荷な Pod にも Service から
#    トラフィックが振り分けられ、ローリングアップデート時などに通信断（502/503 等）が発生する。
#    また livenessProbe が無いと、プロセスがデッドロックやハングアップで応答不能に陥っても
#    kubelet が異常を検知して自動再起動できない。
# 2. オプトアウト方法:
#    HTTP/TCP/exec 等のヘルスチェック手段を持たない特殊な常駐ワークロードを除外する場合は、
#    理由コメントを添えて nuage.io/ignore-probes: "true" を付与する
#    （Job / CronJob / Pod / Helm 管理サードパーティリソースは対象外）。

# 常駐ワークロード (Deployment / StatefulSet / DaemonSet) に readinessProbe / livenessProbe が必須
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
