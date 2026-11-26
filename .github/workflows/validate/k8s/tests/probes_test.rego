package main_test

import rego.v1

import data.main

# 異常系: readinessProbe / livenessProbe 欠落を検知する
test_missing_probes_denied if {
	bad := json.patch(valid_own_deployment, [
		{"op": "remove", "path": "/spec/template/spec/containers/0/readinessProbe"},
		{"op": "remove", "path": "/spec/template/spec/containers/0/livenessProbe"},
	])
	denies := main.deny with input as [bad, valid_pdb] with data.env as "prod"
	some m_read in denies
	contains(m_read, "readinessProbe")
	some m_live in denies
	contains(m_live, "livenessProbe")
}

# 例外系: nuage.io/ignore-probes: "true" で readinessProbe / livenessProbe チェックをスキップできる
test_ignore_probes_annotation_skips_checks if {
	ignored := json.patch(valid_own_deployment, [
		{"op": "add", "path": "/metadata/annotations/nuage.io~1ignore-probes", "value": "true"},
		{"op": "remove", "path": "/spec/template/spec/containers/0/readinessProbe"},
		{"op": "remove", "path": "/spec/template/spec/containers/0/livenessProbe"},
	])
	denies := main.deny with input as [ignored, valid_pdb] with data.env as "prod"
	count(denies) == 0
}
