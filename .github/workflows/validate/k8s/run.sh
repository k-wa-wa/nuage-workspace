#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

YAMLLINT_PATH="${YAMLLINT_PATH-k8s}"
PROD_OVERLAYS="${PROD_OVERLAYS-k8s/overlays/prod}"
PREVIEW_OVERLAYS="${PREVIEW_OVERLAYS-k8s/overlays/preview}"
ENABLE_HELM="${ENABLE_HELM:-false}"
OWN_IMAGE_PREFIXES="${OWN_IMAGE_PREFIXES-ghcr.io/k-wa-wa/}"
EXCLUDE_HELM_MANAGED="${EXCLUDE_HELM_MANAGED:-true}"
FAIL_ON_POLICY="${FAIL_ON_POLICY:-true}"
POLICY_DIR="${POLICY_DIR:-$SCRIPT_DIR}"

usage() {
  cat << 'EOF'
Usage: run.sh [OPTIONS]

Kubernetes マニフェストの共通検証（yamllint / kustomize / kubeconform / pluto / conftest）を実行する。
各オプションは環境変数でも指定できる（CLI 引数が優先される）。

Options:
  --yamllint-path <path>          yamllint の対象パス（空でスキップ。既定: k8s / YAMLLINT_PATH）
  --prod-overlays <overlays>      prod オーバーレイ一覧（カンマまたは改行区切り。既定: k8s/overlays/prod / PROD_OVERLAYS）
  --preview-overlays <overlays>   preview オーバーレイ一覧（カンマまたは改行区切り。既定: k8s/overlays/preview / PREVIEW_OVERLAYS）
  --enable-helm [true|false]      kustomize build に --enable-helm を付与する（既定: false / ENABLE_HELM）
  --own-image-prefixes <prefixes> 自前イメージプレフィックス一覧（カンマ区切り。既定: ghcr.io/k-wa-wa/ / OWN_IMAGE_PREFIXES）
  --exclude-helm-managed <bool>   Helm 管理リソースをワークロードポリシーから除外する（既定: true / EXCLUDE_HELM_MANAGED）
  --fail-on-policy <bool>         Conftest ポリシー違反時に失敗終了するか（既定: true / FAIL_ON_POLICY）
  --policy-dir <dir>              Rego ポリシーディレクトリのパス（既定: run.sh と同ディレクトリ / POLICY_DIR）
  -h, --help                      このヘルプを表示する
EOF
}

parse_cli_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --yamllint-path=*)
        YAMLLINT_PATH="${1#*=}"
        shift
        ;;
      --yamllint-path)
        [ "$#" -ge 2 ] || { echo "❌ --yamllint-path requires a value." >&2; exit 1; }
        YAMLLINT_PATH="$2"
        shift 2
        ;;
      --prod-overlays=*)
        PROD_OVERLAYS="${1#*=}"
        shift
        ;;
      --prod-overlays)
        [ "$#" -ge 2 ] || { echo "❌ --prod-overlays requires a value." >&2; exit 1; }
        PROD_OVERLAYS="$2"
        shift 2
        ;;
      --preview-overlays=*)
        PREVIEW_OVERLAYS="${1#*=}"
        shift
        ;;
      --preview-overlays)
        [ "$#" -ge 2 ] || { echo "❌ --preview-overlays requires a value." >&2; exit 1; }
        PREVIEW_OVERLAYS="$2"
        shift 2
        ;;
      --enable-helm=*)
        ENABLE_HELM="${1#*=}"
        shift
        ;;
      --enable-helm)
        if [ "$#" -ge 2 ] && { [ "$2" = "true" ] || [ "$2" = "false" ]; }; then
          ENABLE_HELM="$2"
          shift 2
        else
          ENABLE_HELM="true"
          shift
        fi
        ;;
      --own-image-prefixes=*)
        OWN_IMAGE_PREFIXES="${1#*=}"
        shift
        ;;
      --own-image-prefixes)
        [ "$#" -ge 2 ] || { echo "❌ --own-image-prefixes requires a value." >&2; exit 1; }
        OWN_IMAGE_PREFIXES="$2"
        shift 2
        ;;
      --exclude-helm-managed=*)
        EXCLUDE_HELM_MANAGED="${1#*=}"
        shift
        ;;
      --exclude-helm-managed)
        [ "$#" -ge 2 ] || { echo "❌ --exclude-helm-managed requires a value." >&2; exit 1; }
        EXCLUDE_HELM_MANAGED="$2"
        shift 2
        ;;
      --fail-on-policy=*)
        FAIL_ON_POLICY="${1#*=}"
        shift
        ;;
      --fail-on-policy)
        [ "$#" -ge 2 ] || { echo "❌ --fail-on-policy requires a value." >&2; exit 1; }
        FAIL_ON_POLICY="$2"
        shift 2
        ;;
      --policy-dir=*)
        POLICY_DIR="${1#*=}"
        shift
        ;;
      --policy-dir)
        [ "$#" -ge 2 ] || { echo "❌ --policy-dir requires a value." >&2; exit 1; }
        POLICY_DIR="$2"
        shift 2
        ;;
      *)
        echo "❌ Unknown option: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done
}

validate_bool() {
  local name="$1"
  local val="$2"
  if [ "$val" != "true" ] && [ "$val" != "false" ]; then
    echo "❌ Invalid boolean value for $name: '$val' (expected 'true' or 'false')." >&2
    exit 1
  fi
}

check_required_commands() {
  local required_cmds=(kustomize kubeconform pluto conftest jq)
  if [ -n "$YAMLLINT_PATH" ]; then
    required_cmds+=(yamllint)
  fi

  local missing_cmds=()
  local cmd
  for cmd in "${required_cmds[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing_cmds+=("$cmd")
    fi
  done

  if [ "${#missing_cmds[@]}" -gt 0 ]; then
    echo "❌ Missing required command(s): ${missing_cmds[*]}" >&2
    exit 1
  fi
}

write_summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    cat >> "$GITHUB_STEP_SUMMARY"
  else
    cat >/dev/null
  fi
}

parse_overlays() {
  printf '%s\n' "$1" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true
}

run_yamllint() {
  if [ -z "$YAMLLINT_PATH" ]; then
    return 0
  fi

  if [ ! -e "$YAMLLINT_PATH" ]; then
    echo "❌ yamllint target '$YAMLLINT_PATH' does not exist." >&2
    exit 1
  fi

  echo "=== Running yamllint ($YAMLLINT_PATH) ==="
  if [ -f ".yamllint" ] || [ -f ".yamllint.yml" ] || [ -f ".yamllint.yaml" ]; then
    yamllint "$YAMLLINT_PATH"
  else
    local default_cfg="${WORK_DIR}/default-yamllint.yaml"
    cat << 'EOF' > "$default_cfg"
extends: default
rules:
  line-length: disable
  document-start: disable
  empty-lines: disable
  trailing-spaces: disable
  comments:
    min-spaces-from-content: 1
EOF
    echo "No .yamllint found; using Nuage fallback configuration."
    yamllint -c "$default_cfg" "$YAMLLINT_PATH"
  fi
}

validate_overlay() {
  local env_name="$1"
  local overlay="$2"

  if [ ! -d "$overlay" ]; then
    echo "❌ Overlay directory '$overlay' (env=$env_name) does not exist." >&2
    exit 1
  fi

  VALIDATED_COUNT=$((VALIDATED_COUNT + 1))

  echo "========================================"
  echo "Validating $overlay (env=$env_name)"
  echo "========================================"

  local rendered="${WORK_DIR}/rendered-${VALIDATED_COUNT}-${env_name}.yaml"
  local kustomize_args=()
  if [ "$ENABLE_HELM" = "true" ]; then
    kustomize_args+=(--enable-helm)
  fi

  kustomize build "${kustomize_args[@]}" "$overlay" > "$rendered"

  echo "--- kubeconform ---"
  kubeconform -summary -strict -ignore-missing-schemas \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    "$rendered"

  echo "--- pluto ---"
  pluto detect "$rendered"

  echo "--- conftest ($env_name) ---"
  local data_json="${WORK_DIR}/policy-data.json"
  jq -n \
    --arg env "$env_name" \
    --arg prefixes "$OWN_IMAGE_PREFIXES" \
    --argjson exclude_helm "$EXCLUDE_HELM_MANAGED" \
    '{
      env: $env,
      own_image_prefixes: ($prefixes | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))),
      exclude_helm_managed: $exclude_helm
    }' > "$data_json"

  local conftest_out="${WORK_DIR}/conftest-${VALIDATED_COUNT}.out"
  local conftest_rc=0
  conftest test --no-color --combine --all-namespaces \
    -p "$POLICY_DIR" \
    -d "$data_json" \
    "$rendered" > "$conftest_out" 2>&1 || conftest_rc=$?

  cat "$conftest_out"

  {
    echo "#### \`${overlay}\` (\`env=${env_name}\`)"
    echo ""
    echo '```text'
    cat "$conftest_out"
    echo '```'
    echo ""
  } | write_summary

  if [ "$conftest_rc" -ne 0 ]; then
    POLICY_FAILED=1
  fi
}

parse_cli_args "$@"

validate_bool "ENABLE_HELM" "$ENABLE_HELM"
validate_bool "EXCLUDE_HELM_MANAGED" "$EXCLUDE_HELM_MANAGED"
validate_bool "FAIL_ON_POLICY" "$FAIL_ON_POLICY"

if [ ! -d "$POLICY_DIR" ]; then
  echo "❌ Policy directory '$POLICY_DIR' does not exist." >&2
  exit 1
fi

check_required_commands

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

run_yamllint

POLICY_FAILED=0
VALIDATED_COUNT=0

{
  echo "### Kubernetes Manifest Validation"
  echo ""
  echo "- \`fail-on-policy\`: \`${FAIL_ON_POLICY}\`"
  echo "- \`own-image-prefixes\`: \`${OWN_IMAGE_PREFIXES}\`"
  echo ""
} | write_summary

while IFS= read -r overlay; do
  validate_overlay "prod" "$overlay"
done < <(parse_overlays "$PROD_OVERLAYS")

while IFS= read -r overlay; do
  validate_overlay "preview" "$overlay"
done < <(parse_overlays "$PREVIEW_OVERLAYS")

if [ "$VALIDATED_COUNT" -eq 0 ]; then
  echo "❌ No Kustomize overlays were validated. Specify prod-overlays and/or preview-overlays." >&2
  exit 1
fi

if [ "$POLICY_FAILED" -ne 0 ]; then
  if [ "$FAIL_ON_POLICY" = "true" ]; then
    echo "❌ Conftest policy violations detected."
    exit 1
  else
    echo "⚠️ Conftest policy violations detected, but fail-on-policy=false so continuing with warnings."
    {
      echo "> [!WARNING]"
      echo "> ポリシー違反が検出されたが \`fail-on-policy: false\` のため警告のみで通過させた。"
    } | write_summary
  fi
fi
