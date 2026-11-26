package main

import rego.v1

# Keel による自動デプロイ（preview 環境の :pr-<N> 上書き・:latest 追従）およびイメージ取得ポリシーを検証するルール。
#
# なぜこのルールが必要か:
# 1. 背景と障害事例:
#    pechka PR #69 の preview 環境検証において、Keel（policy: force / trigger: poll / matchTag: "true"）で
#    自動更新する Deployment で imagePullPolicy を省略していたため、イメージ更新後もノード上の
#    古いキャッシュが再利用され続け、最新ビルドが反映されないサイレント障害が発生した。
#    また、matchTag: "true" + force 運用では同一タグに新しい digest が push された際に Keel が
#    Pod を再作成するが、imagePullPolicy が IfNotPresent だとキャッシュ済みイメージのまま起動する。
# 2. Kustomize / Argo CD によるイメージタグ差し替えの罠:
#    ベース定義で :latest を使い imagePullPolicy を省略すると、単体では Kubernetes の既定値により
#    Always として動作する。しかし Argo CD ApplicationSet の kustomize.images や overlay で
#    タグを :pr-<N> や :v1.2.3 等へ差し替えた瞬間、非 :latest タグの既定値（IfNotPresent）へ
#    切り替わり、プレビュー環境で古いイメージが残留する。したがって YAML 上への Always 明示が必須である。
# 3. :latest / タグ省略チェックを deny ではなく warn とした理由:
#    サードパーティ製イメージの :latest やタグ省略は、既存リポジトリの CI（fail-on-policy: true）を
#    直ちに破壊せず段階的に未設定箇所を可視化するため warn とする（@sha256: digest 固定は対象外）。
#    一方、事故影響が大きい自前イメージおよび Keel 監視対象コンテナは deny で確実にブロックする。
# 4. keel.sh/monitorContainers の RE2 正規表現仕様:
#    Keel の monitorContainers はカンマ区切りではなく Go（RE2）正規表現で評価されるため、
#    複数指定は "app,sidecar" ではなく "^(app|sidecar)$" のように記述する必要がある。
#    サードパーティ製サイドカー（例: headless-chrome）が同居する場合は監視対象コンテナ名のみに
#    一致させ、意図しないコンテナが Keel 監視対象に入ることを防ぐ。
# 5. オプトアウト方法と混在ワークロードでの注意点:
#    - nuage.io/ignore-image-pull-policy: "true": imagePullPolicy および :latest 警告チェックを除外する。
#    - nuage.io/ignore-keel: "true": 自前イメージ利用 Deployment の keel.sh/* アノテーション必須チェックを除外する。
#    ※ nuage.io/ignore-image-pull-policy はコンテナ単位ではなくリソース（ワークロード）単位で効くため、
#    自前イメージや Keel 監視対象コンテナと同居するワークロードには絶対に使用してはならない
#    （対象コンテナの必須チェックまで無効化されるため）。混在ワークロード内のサードパーティ製サイドカーで
#    :latest 警告を解消したい場合は、オプトアウトではなく固定タグ（または @sha256: digest）への固定、
#    もしくは imagePullPolicy: Always の明示で対処する。

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

keel_regex_target(doc) if {
	keel_target_deployment(doc)
}

keel_regex_target(doc) if {
	keel_monitored_workload(doc)
}

deny contains msg if {
	some doc in docs
	keel_regex_target(doc)
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
