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

echo "=== Smoke Test 1: Local mode PASS (GITHUB_STEP_SUMMARY unset) ==="
PASS_REPO="${TMP_ROOT}/pass-repo"
create_valid_repo "$PASS_REPO"
(
  cd "$PASS_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER"
)

echo "=== Smoke Test 2: CI mode PASS (GITHUB_STEP_SUMMARY set + CLI flags) ==="
SUMMARY_PASS="${TMP_ROOT}/summary-pass.md"
(
  cd "$PASS_REPO"
  GITHUB_STEP_SUMMARY="$SUMMARY_PASS" "$RUNNER" --yamllint-path "" --prod-overlays "k8s/overlays/prod" --preview-overlays ""
)
grep -q "### Kubernetes Manifest Validation" "$SUMMARY_PASS"
grep -qF "#### \`k8s/overlays/prod\` (\`env=prod\`)" "$SUMMARY_PASS"

echo "=== Smoke Test 3: Policy violation FAIL (fail-on-policy=true) ==="
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
if (cd "$FAIL_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --preview-overlays "" >"$FAIL_OUT" 2>&1); then
  echo "❌ Expected policy violation run to fail, but it succeeded." >&2
  exit 1
fi
grep -q "Conftest policy violations detected" "$FAIL_OUT"
grep -q "replicas >= 2" "$FAIL_OUT"

echo "=== Smoke Test 4: Policy violation warning PASS (fail-on-policy=false) ==="
SUMMARY_WARN="${TMP_ROOT}/summary-warn.md"
(
  cd "$FAIL_REPO"
  GITHUB_STEP_SUMMARY="$SUMMARY_WARN" "$RUNNER" --preview-overlays "" --fail-on-policy false
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
if (cd "$PASS_REPO" && PATH="$MIN_BIN" "${MIN_BIN}/bash" "$RUNNER" >"$MISSING_OUT" 2>&1); then
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
if (cd "$YAML_FAIL_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" >"$YAML_FAIL_OUT" 2>&1); then
  echo "❌ Expected yamllint failure to fail, but it succeeded." >&2
  exit 1
fi
grep -q "k8s/broken.yaml" "$YAML_FAIL_OUT"

echo "=== Smoke Test 7: kustomization.yaml direct file and directory positional targets ==="
(
  cd "$PASS_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --env prod k8s/overlays/prod/kustomization.yaml
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --env preview k8s/overlays/preview
)

echo "=== Smoke Test 8: Single YAML file + env=common vs env=prod + workload check ==="
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
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --env common raw/deploy.yaml
)

RAW_PROD_OUT="${TMP_ROOT}/raw-prod.out"
if (cd "$RAW_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --env prod raw/deploy.yaml >"$RAW_PROD_OUT" 2>&1); then
  echo "❌ Expected single YAML replicas=1 to fail under env=prod, but it succeeded." >&2
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
if (cd "$RAW_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --env common raw/bad-workload.yml >"$RAW_COMMON_FAIL_OUT" 2>&1); then
  echo "❌ Expected workload violation under env=common to fail, but it succeeded." >&2
  exit 1
fi
grep -q "resources.requests" "$RAW_COMMON_FAIL_OUT"
rm -f "${RAW_REPO}/raw/bad-workload.yml"

echo "=== Smoke Test 9: Non-Kustomize directory combination and empty directory error ==="
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
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --env common raw
)

EMPTY_DIR_OUT="${TMP_ROOT}/empty-dir.out"
if (cd "$RAW_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --env common empty-dir >"$EMPTY_DIR_OUT" 2>&1); then
  echo "❌ Expected empty directory to fail, but it succeeded." >&2
  exit 1
fi
grep -q "contains no YAML files" "$EMPTY_DIR_OUT"

echo "=== Smoke Test 10: Glob expansion and unmatched glob failure ==="
MULTI_REPO="${TMP_ROOT}/multi-repo"
mkdir -p "${MULTI_REPO}/apps/app-a/overlays/prod" "${MULTI_REPO}/apps/app-b/overlays/prod" "${MULTI_REPO}/apps"
cp "${PASS_REPO}/k8s/overlays/prod/"* "${MULTI_REPO}/apps/app-a/overlays/prod/"
cp "${PASS_REPO}/k8s/overlays/prod/"* "${MULTI_REPO}/apps/app-b/overlays/prod/"
cp "${RAW_REPO}/raw/cm.yaml" "${MULTI_REPO}/apps/root-cm.yaml"
(
  cd "$MULTI_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --prod-targets "apps/*/overlays/prod" --common-targets "apps/*.yaml"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --env prod "apps/*/overlays/prod"
)

UNMATCHED_OUT="${TMP_ROOT}/unmatched.out"
if (cd "$MULTI_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --env common "apps/nonexistent/*.yaml" >"$UNMATCHED_OUT" 2>&1); then
  echo "❌ Expected unmatched glob to fail, but it succeeded." >&2
  exit 1
fi
grep -q "does not exist and matched no files" "$UNMATCHED_OUT"

echo "=== Smoke Test 11: --mode auto / kustomize / yaml overrides ==="
MODE_REPO="${TMP_ROOT}/mode-repo"
mkdir -p "${MODE_REPO}/mixed"
cat << 'EOF' > "${MODE_REPO}/mixed/kustomization.yaml"
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - missing-file.yaml
EOF
cp "${RAW_REPO}/raw/cm.yaml" "${MODE_REPO}/mixed/cm.yaml"
# mode=yaml は kustomization.yaml を無視して cm.yaml を検証するため PASS する
(
  cd "$MODE_REPO"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --mode yaml --env common mixed
)
# mode=kustomize は kustomization.yaml の missing-file.yaml で失敗する
if (cd "$MODE_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --mode kustomize --env common mixed >/dev/null 2>&1); then
  echo "❌ Expected mode=kustomize with broken kustomization.yaml to fail, but it succeeded." >&2
  exit 1
fi
# mode=kustomize に単体 YAML を渡すと失敗する
if (cd "$MODE_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --mode kustomize --env common mixed/cm.yaml >/dev/null 2>&1); then
  echo "❌ Expected mode=kustomize on non-kustomization file to fail, but it succeeded." >&2
  exit 1
fi

echo "=== Smoke Test 12: Multi-env targets in single invocation + preview single YAML ==="
SUMMARY_MULTI="${TMP_ROOT}/summary-multi.md"
cat << 'EOF' > "${MULTI_REPO}/apps/preview-clusterrole.yaml"
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: bad-clusterrole
EOF
(
  cd "$MULTI_REPO"
  GITHUB_STEP_SUMMARY="$SUMMARY_MULTI" "$RUNNER" \
    --common-targets "apps/root-cm.yaml" \
    --prod-targets "apps/*/overlays/prod" \
    --preview-targets ""
)
grep -qF "#### \`apps/root-cm.yaml\` (\`env=common\`)" "$SUMMARY_MULTI"
grep -qF "#### \`apps/app-a/overlays/prod\` (\`env=prod\`)" "$SUMMARY_MULTI"
grep -qF "#### \`apps/app-b/overlays/prod\` (\`env=prod\`)" "$SUMMARY_MULTI"

PREVIEW_FAIL_OUT="${TMP_ROOT}/preview-fail.out"
if (cd "$MULTI_REPO" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --env preview apps/preview-clusterrole.yaml >"$PREVIEW_FAIL_OUT" 2>&1); then
  echo "❌ Expected ClusterRole in env=preview to fail, but it succeeded." >&2
  exit 1
fi
grep -q "ClusterRole" "$PREVIEW_FAIL_OUT"

echo "✅ All smoke tests passed."
