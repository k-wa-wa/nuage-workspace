package main_test

import rego.v1

import data.main

preview_ns := {
	"apiVersion": "v1",
	"kind": "Namespace",
	"metadata": {"name": "app-preview"},
}

preview_ingress := {
	"apiVersion": "networking.k8s.io/v1",
	"kind": "Ingress",
	"metadata": {"name": "app-ingress"},
	"spec": {
		"ingressClassName": "cilium",
		"tls": [{
			"hosts": ["DUMMY"],
			"secretName": "app-tls-secret",
		}],
		"rules": [{
			"host": "DUMMY",
			"http": {"paths": [{
				"path": "/",
				"pathType": "Prefix",
				"backend": {"service": {"name": "app", "port": {"number": 80}}},
			}]},
		}],
	},
}

# 正常系: Namespace 1件 + プレースホルダ Ingress は preview で通過する
test_valid_preview_manifests_pass if {
	denies := main.deny with input as [preview_ns, preview_ingress] with data.env as "preview"
	count(denies) == 0
}

# 異常系: ClusterRole / CRD / VMRule / DaemonSet の混入を禁止する
test_forbidden_cluster_resources_in_preview_denied if {
	cr := {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole", "metadata": {"name": "bad-cr"}}
	crd := {"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition", "metadata": {"name": "bad-crd"}}
	vmrule := {"apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMRule", "metadata": {"name": "bad-rule"}}
	ds := {
		"apiVersion": "apps/v1",
		"kind": "DaemonSet",
		"metadata": {"name": "bad-ds", "annotations": {"nuage.io/ignore-resources": "true", "nuage.io/ignore-probes": "true"}},
		"spec": {"template": {"spec": {"containers": [{"name": "c", "image": "busybox"}]}}},
	}
	denies := main.deny with input as [preview_ns, cr, crd, vmrule, ds] with data.env as "preview"
	count(denies) == 4
}

# 異常系: Namespace リソースが 0 個または 2 個以上のとき検知する
test_preview_namespace_count_enforced if {
	denies_zero := main.deny with input as [preview_ingress] with data.env as "preview"
	some m0 in denies_zero
	contains(m0, "Namespace リソースが1つ必要")

	ns2 := {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "extra-ns"}}
	denies_two := main.deny with input as [preview_ns, ns2, preview_ingress] with data.env as "preview"
	some m2 in denies_two
	contains(m2, "2 個存在する")
}

# 異常系: preview Ingress の本番ドメイン直書き・TLS欠落を検知する
test_preview_ingress_prod_host_or_missing_tls_denied if {
	bad_ing := {
		"apiVersion": "networking.k8s.io/v1",
		"kind": "Ingress",
		"metadata": {"name": "app-ingress"},
		"spec": {
			"rules": [{"host": "app.wpcapp.net"}],
		},
	}
	denies := main.deny with input as [preview_ns, bad_ing] with data.env as "preview"
	some m_tls in denies
	contains(m_tls, "spec.tls[0]")
	some m_host in denies
	contains(m_host, "本番ホスト")
}

# 異常系: RoleBinding の subjects[].namespace が preview Namespace と不整合な場合を検知する
test_preview_rolebinding_subject_namespace_mismatch_denied if {
	rb := {
		"apiVersion": "rbac.authorization.k8s.io/v1",
		"kind": "RoleBinding",
		"metadata": {"name": "rb", "namespace": "app-prod"},
		"subjects": [{"kind": "ServiceAccount", "name": "sa", "namespace": "app-prod"}],
	}
	denies := main.deny with input as [preview_ns, rb] with data.env as "preview"
	warns := main.warn with input as [preview_ns, rb] with data.env as "preview"
	some md in denies
	contains(md, "RoleBinding の subject")
	some mw in warns
	contains(mw, "metadata.namespace")
}

# 例外系: prod 環境では ClusterRole や VMRule を禁止しない
test_prod_allows_cluster_resources if {
	cr := {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole", "metadata": {"name": "ok-cr"}}
	vmrule := {"apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMRule", "metadata": {"name": "ok-rule"}}
	denies := main.deny with input as [cr, vmrule] with data.env as "prod"
	count(denies) == 0
}
