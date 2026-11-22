package main

import rego.v1

# conftest --combine は {"path": ..., "contents": <doc>} 形式で渡すため、生のドキュメントを取り出す
unwrap_doc(item) := item.contents if {
	is_object(item)
	item.contents
	not item.kind
} else := item

# 入力は conftest --combine 時にマニフェスト配列となるが、単体ドキュメント入力にも対応する
docs := [unwrap_doc(item) | some item in input] if {
	is_array(input)
} else := [unwrap_doc(input)]

# 環境設定（"common" / "prod" / "preview"）
target_env := data.env if {
	data.env
} else := "prod"

# 自前イメージプレフィックス一覧
own_image_prefixes := data.own_image_prefixes if {
	data.own_image_prefixes
} else := ["ghcr.io/k-wa-wa/"]

# Helm 管理リソース除外フラグ
exclude_helm_managed := data.exclude_helm_managed if {
	is_boolean(data.exclude_helm_managed)
} else := true

# リソース識別用の表示名
resource_id(doc) := sprintf("%s/%s/%s", [ns, kind, name]) if {
	ns := doc.metadata.namespace
	ns != ""
	kind := object.get(doc, "kind", "Unknown")
	name := object.get(object.get(doc, "metadata", {}), "name", "<unnamed>")
} else := sprintf("%s/%s", [kind, name]) if {
	kind := object.get(doc, "kind", "Unknown")
	name := object.get(object.get(doc, "metadata", {}), "name", "<unnamed>")
}

# 指定アノテーションが "true" であるか判定する
has_annotation(doc, key) if {
	annotations := object.get(object.get(doc, "metadata", {}), "annotations", {})
	annotations[key] == "true"
}

# Helm チャートによって管理・生成されたリソースであるか判定する
is_helm_managed(doc) if {
	labels := object.get(object.get(doc, "metadata", {}), "labels", {})
	labels["helm.sh/chart"] != ""
} else if {
	labels := object.get(object.get(doc, "metadata", {}), "labels", {})
	labels["app.kubernetes.io/managed-by"] == "Helm"
}

# 自前イメージであるか判定する
is_own_image(image) if {
	some prefix in own_image_prefixes
	startswith(image, prefix)
}

# PodTemplateSpec を持つ標準ワークロードの PodSpec を抽出する
pod_spec(doc) := doc.spec.template.spec if {
	doc.kind in {"Deployment", "StatefulSet", "DaemonSet", "Job"}
	doc.spec.template.spec
} else := doc.spec.jobTemplate.spec.template.spec if {
	doc.kind == "CronJob"
	doc.spec.jobTemplate.spec.template.spec
} else := doc.spec if {
	doc.kind == "Pod"
	doc.spec
}

# 標準ワークロードの通常コンテナ一覧
workload_containers(doc) := containers if {
	spec := pod_spec(doc)
	containers := object.get(spec, "containers", [])
} else := []

# 標準ワークロードの initContainers 一覧
workload_init_containers(doc) := containers if {
	spec := pod_spec(doc)
	containers := object.get(spec, "initContainers", [])
} else := []

# Argo Workflows 系リソースのテンプレート配列を抽出する
argo_templates(doc) := templates if {
	doc.kind in {"WorkflowTemplate", "Workflow"}
	templates := object.get(object.get(doc, "spec", {}), "templates", [])
} else := templates if {
	doc.kind == "CronWorkflow"
	templates := object.get(object.get(object.get(doc, "spec", {}), "workflowSpec", {}), "templates", [])
} else := []

# Argo Workflows のコンテナ一覧（テンプレート名・コンテナ名付き）
argo_containers(doc) := [item |
	some tmpl in argo_templates(doc)
	tmpl.container
	item := {
		"name": object.get(tmpl, "name", "<template>"),
		"container": tmpl.container,
	}
]

# 全コンテナ（自前イメージ・リソースチェック等で利用）
all_main_containers(doc) := result if {
	std := [{"name": object.get(c, "name", "<unnamed>"), "container": c} | some c in workload_containers(doc)]
	argo := argo_containers(doc)
	result := array.concat(std, argo)
}

all_containers_including_init(doc) := result if {
	main := all_main_containers(doc)
	inits := [{"name": sprintf("init:%s", [object.get(c, "name", "<unnamed>")]), "container": c} | some c in workload_init_containers(doc)]
	argo_inits := [item |
		some tmpl in argo_templates(doc)
		some c in object.get(tmpl, "initContainers", [])
		item := {
			"name": sprintf("%s/init:%s", [object.get(tmpl, "name", "<template>"), object.get(c, "name", "<unnamed>")]),
			"container": c,
		}
	]
	result := array.concat(array.concat(main, inits), argo_inits)
}

# 自前イメージを1つ以上利用しているか判定する
uses_own_image(doc) if {
	some entry in all_containers_including_init(doc)
	img := object.get(entry.container, "image", "")
	is_own_image(img)
}

# Helm 由来かつ自前イメージを利用していない場合に品質ルール対象外とみなす
is_helm_excluded(doc) if {
	exclude_helm_managed
	is_helm_managed(doc)
	not uses_own_image(doc)
}
