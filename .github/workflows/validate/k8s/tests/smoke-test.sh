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

echo "✅ All smoke tests passed."
