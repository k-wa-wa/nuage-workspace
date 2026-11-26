package main_test

import rego.v1

import data.main

# 異常系: resources.requests (cpu, memory) および resources.limits (memory) 欠落を検知する
test_missing_resources_denied if {
	bad := json.patch(valid_own_deployment, [
		{"op": "remove", "path": "/spec/template/spec/containers/0/resources"},
	])
	denies := main.deny with input as [bad, valid_pdb] with data.env as "prod"
	some m_req in denies
	contains(m_req, "resources.requests")
	some m_lim in denies
	contains(m_lim, "resources.limits")
}

# 警告系: initContainers の resources 欠落は warn として可視化する
test_init_container_missing_resources_warns if {
	dep := json.patch(valid_own_deployment, [{
		"op": "add",
		"path": "/spec/template/spec/initContainers",
		"value": [{
			"name": "init-setup",
			"image": "busybox:1.36",
		}],
	}])
	denies := main.deny with input as [dep, valid_pdb] with data.env as "prod"
	warns := main.warn with input as [dep, valid_pdb] with data.env as "prod"
	count(denies) == 0
	some w_req in warns
	contains(w_req, "initContainer \"init-setup\" に resources.requests")
	some w_lim in warns
	contains(w_lim, "initContainer \"init-setup\" に resources.limits")
}

# 例外系: nuage.io/ignore-resources: "true" で resources 必須・warn チェックをスキップできる
test_ignore_resources_annotation_skips_checks if {
	ignored := json.patch(valid_own_deployment, [
		{"op": "add", "path": "/metadata/annotations/nuage.io~1ignore-resources", "value": "true"},
		{"op": "remove", "path": "/spec/template/spec/containers/0/resources"},
	])
	denies := main.deny with input as [ignored, valid_pdb] with data.env as "prod"
	warns := main.warn with input as [ignored, valid_pdb] with data.env as "prod"
	count(denies) == 0
	count(warns) == 0
}
