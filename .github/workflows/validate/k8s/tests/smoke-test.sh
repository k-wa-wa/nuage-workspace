#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="${SCRIPT_DIR}/../run.sh"

if [ ! -x "$RUNNER" ]; then
  echo "❌ Runner script '$RUNNER' is missing or not executable." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

create_valid_repo() {
  local repo_dir="$1"
  mkdir -p "${repo_dir}/k8s/overlays/prod" "${repo_dir}/k8s/overlays/preview"

  cat << 'EOF' > "${repo_dir}/k8s/overlays/prod/kustomization.yaml"
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - pdb.yaml
EOF

  cat << 'EOF' > "${repo_dir}/k8s/overlays/prod/deployment.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
  annotations:
    keel.sh/policy: "force"
    keel.sh/trigger: "poll"
    keel.sh/matchTag: "true"
    keel.sh/monitorContainers: "app"
spec:
  replicas: 2
  selector:
    matchLabels:
      app: demo-app
  template:
    metadata:
      labels:
        app: demo-app
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: demo-app
      containers:
        - name: app
          image: ghcr.io/k-wa-wa/demo-app:v1.0.0
          imagePullPolicy: Always
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
EOF

  cat << 'EOF' > "${repo_dir}/k8s/overlays/prod/pdb.yaml"
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: demo-app-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: demo-app
EOF

  cat << 'EOF' > "${repo_dir}/k8s/overlays/preview/kustomization.yaml"
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - deployment.yaml
  - ingress.yaml
EOF

  cat << 'EOF' > "${repo_dir}/k8s/overlays/preview/namespace.yaml"
apiVersion: v1
kind: Namespace
metadata:
  name: demo-pr-1
EOF

  cat << 'EOF' > "${repo_dir}/k8s/overlays/preview/deployment.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
  annotations:
    keel.sh/policy: "force"
    keel.sh/trigger: "poll"
    keel.sh/matchTag: "true"
    keel.sh/monitorContainers: "app"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: demo-app
  template:
    metadata:
      labels:
        app: demo-app
    spec:
      containers:
        - name: app
          image: ghcr.io/k-wa-wa/demo-app:pr-1
          imagePullPolicy: Always
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
EOF

  cat << 'EOF' > "${repo_dir}/k8s/overlays/preview/ingress.yaml"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo-app
spec:
  tls:
    - hosts:
        - demo-pr-1.wpcapp.net
      secretName: demo-pr-1-tls
  rules:
    - host: demo-pr-1.wpcapp.net
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: demo-app
                port:
                  number: 80
EOF
}

echo "=== Smoke Test 1: Default (common) PASS and GITHUB_STEP_SUMMARY unset ==="
PASS_REPO="${TMP_ROOT}/pass-repo"
create_valid_repo "$PASS_REPO"
(
  cd "$PASS_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" k8s/overlays/prod
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod k8s/overlays/prod
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --preview k8s/overlays/preview
)

echo "=== Smoke Test 2: CI mode PASS (GITHUB_STEP_SUMMARY set + TARGETS / --prod) ==="
SUMMARY_PASS="${TMP_ROOT}/summary-pass.md"
(
  cd "$PASS_REPO"
  GITHUB_STEP_SUMMARY="$SUMMARY_PASS" TARGETS="k8s/overlays/prod" PROD="true" "$RUNNER"
)
grep -q "### Kubernetes Manifest Validation" "$SUMMARY_PASS"
grep -qF "\`env\`: \`prod\`" "$SUMMARY_PASS"
grep -qF "#### \`k8s/overlays/prod\` (\`env=prod\`)" "$SUMMARY_PASS"

echo "=== Smoke Test 3: Policy violation FAIL (--prod, fail-on-policy=true) ==="
FAIL_REPO="${TMP_ROOT}/fail-repo"
create_valid_repo "$FAIL_REPO"
cat << 'EOF' > "${FAIL_REPO}/k8s/overlays/prod/deployment.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: demo-app
  template:
    metadata:
      labels:
        app: demo-app
    spec:
      containers:
        - name: app
          image: ghcr.io/k-wa-wa/demo-app:v1.0.0
EOF

FAIL_OUT="${TMP_ROOT}/fail.out"
if (cd "$FAIL_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod k8s/overlays/prod >"$FAIL_OUT" 2>&1); then
  echo "❌ Expected policy violation run to fail, but it succeeded." >&2
  exit 1
fi
grep -q "Conftest policy violations detected" "$FAIL_OUT"
grep -q "replicas >= 2" "$FAIL_OUT"

echo "=== Smoke Test 4: Policy violation warning PASS (fail-on-policy=false) ==="
SUMMARY_WARN="${TMP_ROOT}/summary-warn.md"
(
  cd "$FAIL_REPO"
  GITHUB_STEP_SUMMARY="$SUMMARY_WARN" "$RUNNER" --prod --fail-on-policy false k8s/overlays/prod
)
grep -q "fail-on-policy: false" "$SUMMARY_WARN"

echo "=== Smoke Test 5: Missing command detection ==="
MIN_BIN="${TMP_ROOT}/min-bin"
mkdir -p "$MIN_BIN"
for base_cmd in bash dirname cat tr sed grep rm mktemp; do
  if command -v "$base_cmd" >/dev/null 2>&1; then
    ln -sf "$(command -v "$base_cmd")" "${MIN_BIN}/${base_cmd}"
  fi
done
MISSING_OUT="${TMP_ROOT}/missing.out"
if (cd "$PASS_REPO" && PATH="$MIN_BIN" "${MIN_BIN}/bash" "$RUNNER" k8s/overlays/prod >"$MISSING_OUT" 2>&1); then
  echo "❌ Expected missing command check to fail, but it succeeded." >&2
  exit 1
fi
grep -q "Missing required command(s):" "$MISSING_OUT"
grep -q "kustomize" "$MISSING_OUT"

echo "=== Smoke Test 6: yamllint failure ==="
YAML_FAIL_REPO="${TMP_ROOT}/yaml-fail-repo"
create_valid_repo "$YAML_FAIL_REPO"
printf 'invalid: [unclosed\n' > "${YAML_FAIL_REPO}/k8s/broken.yaml"
YAML_FAIL_OUT="${TMP_ROOT}/yaml-fail.out"
if (cd "$YAML_FAIL_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --yamllint-path k8s k8s/overlays/prod >"$YAML_FAIL_OUT" 2>&1); then
  echo "❌ Expected yamllint failure to fail, but it succeeded." >&2
  exit 1
fi
grep -q "k8s/broken.yaml" "$YAML_FAIL_OUT"

echo "=== Smoke Test 7: Argument validation (no targets, --prod + --preview conflict) ==="
NO_TARGET_OUT="${TMP_ROOT}/no-target.out"
if (cd "$PASS_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" >"$NO_TARGET_OUT" 2>&1); then
  echo "❌ Expected zero targets to fail, but it succeeded." >&2
  exit 1
fi
grep -q "Usage: run.sh" "$NO_TARGET_OUT"

CONFLICT_OUT="${TMP_ROOT}/conflict.out"
if (cd "$PASS_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod --preview k8s/overlays/prod >"$CONFLICT_OUT" 2>&1); then
  echo "❌ Expected --prod and --preview together to fail, but it succeeded." >&2
  exit 1
fi
grep -q "cannot be specified at the same time" "$CONFLICT_OUT"

if (cd "$PASS_REPO" && env -u GITHUB_STEP_SUMMARY PROD=true PREVIEW=true "$RUNNER" k8s/overlays/prod >/dev/null 2>&1); then
  echo "❌ Expected PROD=true and PREVIEW=true together to fail, but it succeeded." >&2
  exit 1
fi

echo "=== Smoke Test 8: kustomization.yaml direct file and directory positional targets ==="
(
  cd "$PASS_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod k8s/overlays/prod/kustomization.yaml
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --preview k8s/overlays/preview
)

echo "=== Smoke Test 9: Single YAML file + default (common) vs --prod + workload check ==="
RAW_REPO="${TMP_ROOT}/raw-repo"
mkdir -p "${RAW_REPO}/raw"
cat << 'EOF' > "${RAW_REPO}/raw/deploy.yaml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: single-app
  annotations:
    keel.sh/policy: "force"
    keel.sh/trigger: "poll"
    keel.sh/matchTag: "true"
    keel.sh/monitorContainers: "app"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: single-app
  template:
    metadata:
      labels:
        app: single-app
    spec:
      containers:
        - name: app
          image: ghcr.io/k-wa-wa/single-app:v1.0.0
          imagePullPolicy: Always
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
EOF

(
  cd "$RAW_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" raw/deploy.yaml
)

RAW_PROD_OUT="${TMP_ROOT}/raw-prod.out"
if (cd "$RAW_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod raw/deploy.yaml >"$RAW_PROD_OUT" 2>&1); then
  echo "❌ Expected single YAML replicas=1 to fail under --prod, but it succeeded." >&2
  exit 1
fi
grep -q "replicas >= 2" "$RAW_PROD_OUT"

cat << 'EOF' > "${RAW_REPO}/raw/bad-workload.yml"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bad-app
  template:
    metadata:
      labels:
        app: bad-app
    spec:
      containers:
        - name: app
          image: nginx:1.27
EOF
RAW_COMMON_FAIL_OUT="${TMP_ROOT}/raw-common-fail.out"
if (cd "$RAW_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" raw/bad-workload.yml >"$RAW_COMMON_FAIL_OUT" 2>&1); then
  echo "❌ Expected workload violation under default (common) to fail, but it succeeded." >&2
  exit 1
fi
grep -q "resources.requests" "$RAW_COMMON_FAIL_OUT"
rm -f "${RAW_REPO}/raw/bad-workload.yml"

echo "=== Smoke Test 10: Non-Kustomize directory combination and empty directory error ==="
mkdir -p "${RAW_REPO}/raw/sub" "${RAW_REPO}/empty-dir"
cat << 'EOF' > "${RAW_REPO}/raw/cm.yaml"
apiVersion: v1
kind: ConfigMap
metadata:
  name: raw-cm
data:
  key: value
EOF
cat << 'EOF' > "${RAW_REPO}/raw/sub/sa.yml"
apiVersion: v1
kind: ServiceAccount
metadata:
  name: raw-sa
EOF
(
  cd "$RAW_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" raw
)

EMPTY_DIR_OUT="${TMP_ROOT}/empty-dir.out"
if (cd "$RAW_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" empty-dir >"$EMPTY_DIR_OUT" 2>&1); then
  echo "❌ Expected empty directory to fail, but it succeeded." >&2
  exit 1
fi
grep -q "contains no YAML files" "$EMPTY_DIR_OUT"

echo "=== Smoke Test 11: Glob expansion, --targets list, and unmatched glob failure ==="
MULTI_REPO="${TMP_ROOT}/multi-repo"
mkdir -p "${MULTI_REPO}/apps/app-a/overlays/prod" "${MULTI_REPO}/apps/app-b/overlays/prod" "${MULTI_REPO}/apps"
cp "${PASS_REPO}/k8s/overlays/prod/"* "${MULTI_REPO}/apps/app-a/overlays/prod/"
cp "${PASS_REPO}/k8s/overlays/prod/"* "${MULTI_REPO}/apps/app-b/overlays/prod/"
cp "${RAW_REPO}/raw/cm.yaml" "${MULTI_REPO}/apps/root-cm.yaml"
SUMMARY_MULTI="${TMP_ROOT}/summary-multi.md"
(
  cd "$MULTI_REPO"
  GITHUB_STEP_SUMMARY="$SUMMARY_MULTI" "$RUNNER" --prod --targets $'apps/*/overlays/prod\napps/root-cm.yaml'
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod "apps/*/overlays/prod"
)
grep -qF "#### \`apps/app-a/overlays/prod\` (\`env=prod\`)" "$SUMMARY_MULTI"
grep -qF "#### \`apps/app-b/overlays/prod\` (\`env=prod\`)" "$SUMMARY_MULTI"
grep -qF "#### \`apps/root-cm.yaml\` (\`env=prod\`)" "$SUMMARY_MULTI"

UNMATCHED_OUT="${TMP_ROOT}/unmatched.out"
if (cd "$MULTI_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" "apps/nonexistent/*.yaml" >"$UNMATCHED_OUT" 2>&1); then
  echo "❌ Expected unmatched glob to fail, but it succeeded." >&2
  exit 1
fi
grep -q "does not exist and matched no files" "$UNMATCHED_OUT"

echo "=== Smoke Test 12: --preview single YAML check ==="
cat << 'EOF' > "${MULTI_REPO}/apps/preview-clusterrole.yaml"
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: bad-clusterrole
EOF
PREVIEW_FAIL_OUT="${TMP_ROOT}/preview-fail.out"
if (cd "$MULTI_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --preview apps/preview-clusterrole.yaml >"$PREVIEW_FAIL_OUT" 2>&1); then
  echo "❌ Expected ClusterRole in --preview to fail, but it succeeded." >&2
  exit 1
fi
grep -q "ClusterRole" "$PREVIEW_FAIL_OUT"

echo "=== Smoke Test 13: Kustomization (extensionless), nested prune, original file path, and pluto multi-file ==="
EXT_REPO="${TMP_ROOT}/ext-repo"
mkdir -p "${EXT_REPO}/kust-no-ext" "${EXT_REPO}/bundle/nested-kust" "${EXT_REPO}/bundle/nested-chart/templates"
cp "${PASS_REPO}/k8s/overlays/prod/deployment.yaml" "${EXT_REPO}/kust-no-ext/deployment.yaml"
cp "${PASS_REPO}/k8s/overlays/prod/pdb.yaml" "${EXT_REPO}/kust-no-ext/pdb.yaml"
cat << 'EOF' > "${EXT_REPO}/kust-no-ext/Kustomization"
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - pdb.yaml
EOF

# 拡張子なし Kustomization がディレクトリ指定でもファイル直接指定でも Kustomize ビルドされること
(
  cd "$EXT_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod kust-no-ext
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod kust-no-ext/Kustomization
)

# 非 Kustomize フォルダ内の Kustomize / Helm サブツリーは除外され、親直下の生 YAML のみが検証されること
cp "${RAW_REPO}/raw/cm.yaml" "${EXT_REPO}/bundle/root.yaml"
cat << 'EOF' > "${EXT_REPO}/bundle/nested-kust/kustomization.yaml"
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - broken.yaml
EOF
printf 'invalid_for_kubeconform: true\n' > "${EXT_REPO}/bundle/nested-kust/broken.yaml"
printf 'apiVersion: v2\nname: dummy\nversion: 0.1.0\n' > "${EXT_REPO}/bundle/nested-chart/Chart.yaml"
printf '{{ invalid helm template }}\n' > "${EXT_REPO}/bundle/nested-chart/templates/deploy.yaml"

BUNDLE_OUT="${TMP_ROOT}/bundle.out"
SUMMARY_BUNDLE="${TMP_ROOT}/summary-bundle.md"
(
  cd "$EXT_REPO"
  GITHUB_STEP_SUMMARY="$SUMMARY_BUNDLE" "$RUNNER" bundle >"$BUNDLE_OUT" 2>&1
)
grep -q "Skipped nested Kustomize/Helm subtrees" "$BUNDLE_OUT"
grep -q "bundle/nested-kust" "$BUNDLE_OUT"
grep -q "bundle/nested-chart" "$BUNDLE_OUT"
grep -q "Skipped nested Kustomize/Helm subtrees" "$SUMMARY_BUNDLE"
grep -qF "\`bundle/nested-kust\`" "$SUMMARY_BUNDLE"
grep -qF "\`bundle/nested-chart\`" "$SUMMARY_BUNDLE"

# kubeconform エラーに一時ファイル名ではなく元のファイル名が含まれること
cat << 'EOF' > "${EXT_REPO}/bundle/bad-schema.yaml"
apiVersion: v1
kind: ConfigMap
metadata:
  name: bad-cm
  unknownField: true
EOF
ORIG_PATH_OUT="${TMP_ROOT}/orig-path.out"
if (cd "$EXT_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" bundle >"$ORIG_PATH_OUT" 2>&1); then
  echo "❌ Expected invalid schema in bundle/bad-schema.yaml to fail, but it succeeded." >&2
  exit 1
fi
grep -q "bundle/bad-schema.yaml" "$ORIG_PATH_OUT"
if (cd "$EXT_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" bundle/bad-schema.yaml >"$ORIG_PATH_OUT" 2>&1); then
  echo "❌ Expected invalid schema in single file bundle/bad-schema.yaml to fail, but it succeeded." >&2
  exit 1
fi
grep -q "bundle/bad-schema.yaml" "$ORIG_PATH_OUT"
rm -f "${EXT_REPO}/bundle/bad-schema.yaml"

# pluto がディレクトリ内の 2 番目以降のファイルの非推奨 API も検知すること
cat << 'EOF' > "${EXT_REPO}/bundle/zz-deprecated.yaml"
apiVersion: extensions/v1beta1
kind: Ingress
metadata:
  name: old-ing
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /
            backend:
              serviceName: app
              servicePort: 80
EOF
PLUTO_DIR_OUT="${TMP_ROOT}/pluto-dir.out"
if (cd "$EXT_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" bundle >"$PLUTO_DIR_OUT" 2>&1); then
  echo "❌ Expected deprecated API in bundle/zz-deprecated.yaml to fail, but it succeeded." >&2
  exit 1
fi
grep -q "bundle/zz-deprecated.yaml" "$PLUTO_DIR_OUT"

echo "✅ All smoke tests passed."
