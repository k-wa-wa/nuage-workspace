#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGETS="${TARGETS:-}"
PROD="${PROD:-false}"
PREVIEW="${PREVIEW:-false}"
YAMLLINT_PATH="${YAMLLINT_PATH:-}"
ENABLE_HELM="${ENABLE_HELM:-false}"
OWN_IMAGE_PREFIXES="${OWN_IMAGE_PREFIXES-ghcr.io/k-wa-wa/}"
EXCLUDE_HELM_MANAGED="${EXCLUDE_HELM_MANAGED:-true}"
FAIL_ON_POLICY="${FAIL_ON_POLICY:-true}"
POLICY_DIR="${POLICY_DIR:-$SCRIPT_DIR}"

POSITIONAL_TARGETS=()
RESOLVED_TARGETS=()
TARGET_INPUT_FILES=()
PRUNED_SUBTREES=()
RESOLVED_KIND=""

usage() {
  cat << 'EOF'
Usage: run.sh [OPTIONS] <target...>

Kubernetes マニフェストの共通検証（yamllint / kustomize / kubeconform / pluto / conftest）を実行する。
ターゲットには Kustomize ディレクトリ、kustomization.yaml(.yml) / Kustomization ファイル、単体 YAML ファイル、
非 Kustomize フォルダ、および glob パターンを自動判別して指定できる。
既定では標準チェック（common: yamllint + kubeconform + pluto + workload.rego）のみを実行する。
各オプションは環境変数でも指定できる（CLI 引数が優先される）。

Options:
  --prod                          標準チェックに加えて prod 用 HA チェック（ha.rego）を実行する（PROD=true）
  --preview                       標準チェックに加えて preview 用チェック（preview.rego）を実行する（PREVIEW=true）
  --targets <targets>             検証対象一覧（カンマまたは改行区切り。位置引数と併用可 / TARGETS）
  --yamllint-path <path>          yamllint の対象パス（空でスキップ。既定: "" / YAMLLINT_PATH）
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
      --prod=*)
        PROD="${1#*=}"
        shift
        ;;
      --prod)
        if [ "$#" -ge 2 ] && { [ "$2" = "true" ] || [ "$2" = "false" ]; }; then
          PROD="$2"
          shift 2
        else
          PROD="true"
          shift
        fi
        ;;
      --preview=*)
        PREVIEW="${1#*=}"
        shift
        ;;
      --preview)
        if [ "$#" -ge 2 ] && { [ "$2" = "true" ] || [ "$2" = "false" ]; }; then
          PREVIEW="$2"
          shift 2
        else
          PREVIEW="true"
          shift
        fi
        ;;
      --targets=*)
        TARGETS="${1#*=}"
        shift
        ;;
      --targets)
        [ "$#" -ge 2 ] || { echo "❌ --targets requires a value." >&2; exit 1; }
        TARGETS="$2"
        shift 2
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
      --)
        shift
        while [ "$#" -gt 0 ]; do
          POSITIONAL_TARGETS+=("$1")
          shift
        done
        ;;
      -*)
        echo "❌ Unknown option: $1" >&2
        usage >&2
        exit 1
        ;;
      *)
        POSITIONAL_TARGETS+=("$1")
        shift
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

parse_target_list() {
  printf '%s\n' "$1" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true
}

resolve_target_token() {
  local env_name="$1"
  local token="$2"
  RESOLVED_TARGETS=()

  if [ -e "$token" ]; then
    RESOLVED_TARGETS=("$token")
    return 0
  fi

  mapfile -t RESOLVED_TARGETS < <(compgen -G "$token" | LC_ALL=C sort || true)
  if [ "${#RESOLVED_TARGETS[@]}" -eq 0 ]; then
    echo "❌ Target '$token' (env=$env_name) does not exist and matched no files." >&2
    exit 1
  fi
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

is_kustomization_filename() {
  local name="$1"
  [ "$name" = "kustomization.yaml" ] || [ "$name" = "kustomization.yml" ] || [ "$name" = "Kustomization" ]
}

has_kustomization_in_dir() {
  local dir="$1"
  [ -f "${dir}/kustomization.yaml" ] || [ -f "${dir}/kustomization.yml" ] || [ -f "${dir}/Kustomization" ]
}

has_yaml_content() {
  local file="$1"
  grep -qvE '^[[:space:]]*(#.*)?$|^[[:space:]]*(---|\.\.\.)[[:space:]]*$' "$file"
}

run_kustomize_build() {
  local kustomize_dir="$1"
  local out_file="$2"
  local kustomize_args=()
  if [ "$ENABLE_HELM" = "true" ]; then
    kustomize_args+=(--enable-helm)
  fi
  kustomize build "${kustomize_args[@]}" "$kustomize_dir" > "$out_file"
}

collect_yaml_dir_files() {
  local env_name="$1"
  local dir="$2"
  TARGET_INPUT_FILES=()
  PRUNED_SUBTREES=()

  # 配下の独立した Kustomize サブディレクトリや Helm チャートディレクトリは生 YAML 群へ混入させない
  mapfile -t PRUNED_SUBTREES < <(
    find "$dir" \
      -type d ! -path "$dir" \( \
        -exec test -e '{}/kustomization.yaml' \; \
        -o -exec test -e '{}/kustomization.yml' \; \
        -o -exec test -e '{}/Kustomization' \; \
        -o -exec test -e '{}/Chart.yaml' \; \
      \) -prune -print \
      | LC_ALL=C sort
  )

  mapfile -t TARGET_INPUT_FILES < <(
    find "$dir" \
      \( -type d ! -path "$dir" \( \
        -exec test -e '{}/kustomization.yaml' \; \
        -o -exec test -e '{}/kustomization.yml' \; \
        -o -exec test -e '{}/Kustomization' \; \
        -o -exec test -e '{}/Chart.yaml' \; \
      \) -prune \) \
      -o -type f \( -name '*.yaml' -o -name '*.yml' \) \
      ! -name 'kustomization.yaml' ! -name 'kustomization.yml' ! -name 'Kustomization' -print \
      | LC_ALL=C sort
  )

  if [ "${#TARGET_INPUT_FILES[@]}" -eq 0 ]; then
    echo "❌ Directory '$dir' (env=$env_name) contains no YAML files (excluding kustomization and Helm chart subtrees)." >&2
    exit 1
  fi

  local has_nonempty=false
  local f
  for f in "${TARGET_INPUT_FILES[@]}"; do
    if has_yaml_content "$f"; then
      has_nonempty=true
      break
    fi
  done

  if [ "$has_nonempty" = "false" ]; then
    echo "❌ Directory '$dir' (env=$env_name) contains only empty YAML documents." >&2
    exit 1
  fi
}

prepare_target_inputs() {
  local env_name="$1"
  local target="$2"
  local kustomize_out="$3"
  TARGET_INPUT_FILES=()
  PRUNED_SUBTREES=()
  RESOLVED_KIND=""

  if [ ! -e "$target" ]; then
    echo "❌ Target '$target' (env=$env_name) does not exist." >&2
    exit 1
  fi

  if [ -f "$target" ]; then
    local base
    base="$(basename "$target")"
    if is_kustomization_filename "$base"; then
      run_kustomize_build "$(dirname "$target")" "$kustomize_out"
      TARGET_INPUT_FILES=("$kustomize_out")
      RESOLVED_KIND="kustomize"
    elif [[ "$base" == *.yaml || "$base" == *.yml ]]; then
      if ! has_yaml_content "$target"; then
        echo "❌ YAML file '$target' (env=$env_name) is empty." >&2
        exit 1
      fi
      TARGET_INPUT_FILES=("$target")
      RESOLVED_KIND="yaml-file"
    else
      echo "❌ Unsupported file '$target' (env=$env_name) (expected .yaml, .yml, or Kustomization)." >&2
      exit 1
    fi
  elif [ -d "$target" ]; then
    if has_kustomization_in_dir "$target"; then
      run_kustomize_build "$target" "$kustomize_out"
      TARGET_INPUT_FILES=("$kustomize_out")
      RESOLVED_KIND="kustomize"
    else
      collect_yaml_dir_files "$env_name" "$target"
      RESOLVED_KIND="yaml-dir"
    fi
  else
    echo "❌ Target '$target' (env=$env_name) is neither a regular file nor a directory." >&2
    exit 1
  fi
}

run_pluto_on_inputs() {
  if [ "${#TARGET_INPUT_FILES[@]}" -eq 1 ]; then
    pluto detect "${TARGET_INPUT_FILES[0]}"
    return 0
  fi

  local f
  local failed=0
  for f in "${TARGET_INPUT_FILES[@]}"; do
    echo "Checking $f"
    if ! pluto detect "$f"; then
      echo "❌ pluto detected deprecated API in '$f'." >&2
      failed=1
    fi
  done
  return "$failed"
}

validate_target() {
  local env_name="$1"
  local raw_target="$2"
  local target="${raw_target%/}"
  if [ -z "$target" ]; then
    target="$raw_target"
  fi

  VALIDATED_COUNT=$((VALIDATED_COUNT + 1))

  local kustomize_out="${WORK_DIR}/rendered-${VALIDATED_COUNT}-${env_name}.yaml"
  prepare_target_inputs "$env_name" "$target" "$kustomize_out"

  echo "========================================"
  echo "Validating $target (env=$env_name, type=$RESOLVED_KIND)"
  echo "========================================"

  if [ "${#PRUNED_SUBTREES[@]}" -gt 0 ]; then
    echo "ℹ️ Skipped nested Kustomize/Helm subtrees under '$target' (specify explicitly to validate):"
    printf '  - %s\n' "${PRUNED_SUBTREES[@]}"
  fi

  echo "--- kubeconform ---"
  kubeconform -summary -strict -ignore-missing-schemas \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    "${TARGET_INPUT_FILES[@]}"

  echo "--- pluto ---"
  run_pluto_on_inputs

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
    "${TARGET_INPUT_FILES[@]}" > "$conftest_out" 2>&1 || conftest_rc=$?

  cat "$conftest_out"

  {
    echo "#### \`${target}\` (\`env=${env_name}\`)"
    echo ""
    if [ "${#PRUNED_SUBTREES[@]}" -gt 0 ]; then
      echo "Skipped nested Kustomize/Helm subtrees (specify explicitly to validate):"
      local subtree
      for subtree in "${PRUNED_SUBTREES[@]}"; do
        echo "- \`${subtree}\`"
      done
      echo ""
    fi
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

validate_bool "PROD" "$PROD"
validate_bool "PREVIEW" "$PREVIEW"
validate_bool "ENABLE_HELM" "$ENABLE_HELM"
validate_bool "EXCLUDE_HELM_MANAGED" "$EXCLUDE_HELM_MANAGED"
validate_bool "FAIL_ON_POLICY" "$FAIL_ON_POLICY"

if [ "$PROD" = "true" ] && [ "$PREVIEW" = "true" ]; then
  echo "❌ --prod and --preview cannot be specified at the same time." >&2
  exit 1
fi

ENV_NAME="common"
if [ "$PROD" = "true" ]; then
  ENV_NAME="prod"
elif [ "$PREVIEW" = "true" ]; then
  ENV_NAME="preview"
fi

TARGET_TOKENS=("${POSITIONAL_TARGETS[@]}")
if [ -n "$TARGETS" ]; then
  mapfile -t EXTRA_TOKENS < <(parse_target_list "$TARGETS")
  if [ "${#EXTRA_TOKENS[@]}" -gt 0 ]; then
    TARGET_TOKENS+=("${EXTRA_TOKENS[@]}")
  fi
fi

if [ "${#TARGET_TOKENS[@]}" -eq 0 ]; then
  echo "❌ No targets specified." >&2
  usage >&2
  exit 1
fi

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
  echo "- \`env\`: \`${ENV_NAME}\`"
  echo "- \`fail-on-policy\`: \`${FAIL_ON_POLICY}\`"
  echo "- \`own-image-prefixes\`: \`${OWN_IMAGE_PREFIXES}\`"
  echo ""
} | write_summary

for token in "${TARGET_TOKENS[@]}"; do
  resolve_target_token "$ENV_NAME" "$token"
  for resolved in "${RESOLVED_TARGETS[@]}"; do
    validate_target "$ENV_NAME" "$resolved"
  done
done

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
