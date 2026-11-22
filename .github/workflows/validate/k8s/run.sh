#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

YAMLLINT_PATH_EXPLICIT=false
PROD_OVERLAYS_EXPLICIT=false
PREVIEW_OVERLAYS_EXPLICIT=false
NEW_TARGETS_SPECIFIED=false

if [ "${YAMLLINT_PATH+set}" = "set" ]; then
  YAMLLINT_PATH_EXPLICIT=true
fi
if [ "${PROD_OVERLAYS+set}" = "set" ]; then
  PROD_OVERLAYS_EXPLICIT=true
fi
if [ "${PREVIEW_OVERLAYS+set}" = "set" ]; then
  PREVIEW_OVERLAYS_EXPLICIT=true
fi
if [ -n "${TARGETS:-}" ] || [ -n "${COMMON_TARGETS:-}" ] || [ "${PROD_TARGETS+set}" = "set" ] || [ "${PREVIEW_TARGETS+set}" = "set" ]; then
  NEW_TARGETS_SPECIFIED=true
fi

YAMLLINT_PATH="${YAMLLINT_PATH-}"
PROD_OVERLAYS="${PROD_OVERLAYS-}"
PREVIEW_OVERLAYS="${PREVIEW_OVERLAYS-}"
TARGETS="${TARGETS:-}"
COMMON_TARGETS="${COMMON_TARGETS:-}"
PROD_TARGETS="${PROD_TARGETS:-}"
PREVIEW_TARGETS="${PREVIEW_TARGETS:-}"
TARGET_ENV="${TARGET_ENV:-common}"
TARGET_MODE="${TARGET_MODE:-auto}"
ENABLE_HELM="${ENABLE_HELM:-false}"
OWN_IMAGE_PREFIXES="${OWN_IMAGE_PREFIXES-ghcr.io/k-wa-wa/}"
EXCLUDE_HELM_MANAGED="${EXCLUDE_HELM_MANAGED:-true}"
FAIL_ON_POLICY="${FAIL_ON_POLICY:-true}"
POLICY_DIR="${POLICY_DIR:-$SCRIPT_DIR}"

POSITIONAL_TARGETS=()

usage() {
  cat << 'EOF'
Usage: run.sh [OPTIONS] [target...]

Kubernetes マニフェストの共通検証（yamllint / kustomize / kubeconform / pluto / conftest）を実行する。
ターゲットには Kustomize ディレクトリ、kustomization.yaml(.yml) ファイル、単体 YAML ファイル、
非 Kustomize フォルダ、および glob パターンを指定できる。
各オプションは環境変数でも指定できる（CLI 引数が優先される）。

Options:
  --env <common|prod|preview>     位置引数・--targets に適用する環境（既定: common / TARGET_ENV）
  --mode <auto|kustomize|yaml>    ターゲット解釈モード（既定: auto / TARGET_MODE）
  --targets <targets>             検証対象一覧（カンマまたは改行区切り。--env の環境を適用 / TARGETS）
  --common-targets <targets>      common 環境として検証する対象一覧（カンマまたは改行区切り / COMMON_TARGETS）
  --prod-targets <targets>        prod 環境として検証する対象一覧（カンマまたは改行区切り / PROD_TARGETS）
  --preview-targets <targets>     preview 環境として検証する対象一覧（カンマまたは改行区切り / PREVIEW_TARGETS）
  --yamllint-path <path>          yamllint の対象パス（空でスキップ。従来モード既定: k8s / YAMLLINT_PATH）
  --prod-overlays <targets>       prod 対象一覧（後方互換。従来モード既定: k8s/overlays/prod / PROD_OVERLAYS）
  --preview-overlays <targets>    preview 対象一覧（後方互換。従来モード既定: k8s/overlays/preview / PREVIEW_OVERLAYS）
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
      --env=*)
        TARGET_ENV="${1#*=}"
        shift
        ;;
      --env)
        [ "$#" -ge 2 ] || { echo "❌ --env requires a value." >&2; exit 1; }
        TARGET_ENV="$2"
        shift 2
        ;;
      --mode=*)
        TARGET_MODE="${1#*=}"
        shift
        ;;
      --mode)
        [ "$#" -ge 2 ] || { echo "❌ --mode requires a value." >&2; exit 1; }
        TARGET_MODE="$2"
        shift 2
        ;;
      --targets=*)
        TARGETS="${1#*=}"
        NEW_TARGETS_SPECIFIED=true
        shift
        ;;
      --targets)
        [ "$#" -ge 2 ] || { echo "❌ --targets requires a value." >&2; exit 1; }
        TARGETS="$2"
        NEW_TARGETS_SPECIFIED=true
        shift 2
        ;;
      --common-targets=*)
        COMMON_TARGETS="${1#*=}"
        NEW_TARGETS_SPECIFIED=true
        shift
        ;;
      --common-targets)
        [ "$#" -ge 2 ] || { echo "❌ --common-targets requires a value." >&2; exit 1; }
        COMMON_TARGETS="$2"
        NEW_TARGETS_SPECIFIED=true
        shift 2
        ;;
      --prod-targets=*)
        PROD_TARGETS="${1#*=}"
        NEW_TARGETS_SPECIFIED=true
        shift
        ;;
      --prod-targets)
        [ "$#" -ge 2 ] || { echo "❌ --prod-targets requires a value." >&2; exit 1; }
        PROD_TARGETS="$2"
        NEW_TARGETS_SPECIFIED=true
        shift 2
        ;;
      --preview-targets=*)
        PREVIEW_TARGETS="${1#*=}"
        NEW_TARGETS_SPECIFIED=true
        shift
        ;;
      --preview-targets)
        [ "$#" -ge 2 ] || { echo "❌ --preview-targets requires a value." >&2; exit 1; }
        PREVIEW_TARGETS="$2"
        NEW_TARGETS_SPECIFIED=true
        shift 2
        ;;
      --yamllint-path=*)
        YAMLLINT_PATH="${1#*=}"
        YAMLLINT_PATH_EXPLICIT=true
        shift
        ;;
      --yamllint-path)
        [ "$#" -ge 2 ] || { echo "❌ --yamllint-path requires a value." >&2; exit 1; }
        YAMLLINT_PATH="$2"
        YAMLLINT_PATH_EXPLICIT=true
        shift 2
        ;;
      --prod-overlays=*)
        PROD_OVERLAYS="${1#*=}"
        PROD_OVERLAYS_EXPLICIT=true
        shift
        ;;
      --prod-overlays)
        [ "$#" -ge 2 ] || { echo "❌ --prod-overlays requires a value." >&2; exit 1; }
        PROD_OVERLAYS="$2"
        PROD_OVERLAYS_EXPLICIT=true
        shift 2
        ;;
      --preview-overlays=*)
        PREVIEW_OVERLAYS="${1#*=}"
        PREVIEW_OVERLAYS_EXPLICIT=true
        shift
        ;;
      --preview-overlays)
        [ "$#" -ge 2 ] || { echo "❌ --preview-overlays requires a value." >&2; exit 1; }
        PREVIEW_OVERLAYS="$2"
        PREVIEW_OVERLAYS_EXPLICIT=true
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
          NEW_TARGETS_SPECIFIED=true
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
        NEW_TARGETS_SPECIFIED=true
        shift
        ;;
    esac
  done
}

apply_defaults() {
  if [ "$NEW_TARGETS_SPECIFIED" = "true" ]; then
    if [ "$PROD_OVERLAYS_EXPLICIT" = "false" ]; then
      PROD_OVERLAYS=""
    fi
    if [ "$PREVIEW_OVERLAYS_EXPLICIT" = "false" ]; then
      PREVIEW_OVERLAYS=""
    fi
    if [ "$YAMLLINT_PATH_EXPLICIT" = "false" ]; then
      YAMLLINT_PATH=""
    fi
  else
    if [ "$PROD_OVERLAYS_EXPLICIT" = "false" ]; then
      PROD_OVERLAYS="k8s/overlays/prod"
    fi
    if [ "$PREVIEW_OVERLAYS_EXPLICIT" = "false" ]; then
      PREVIEW_OVERLAYS="k8s/overlays/preview"
    fi
    if [ "$YAMLLINT_PATH_EXPLICIT" = "false" ]; then
      YAMLLINT_PATH="k8s"
    fi
  fi
}

validate_bool() {
  local name="$1"
  local val="$2"
  if [ "$val" != "true" ] && [ "$val" != "false" ]; then
    echo "❌ Invalid boolean value for $name: '$val' (expected 'true' or 'false')." >&2
    exit 1
  fi
}

validate_env() {
  local val="$1"
  case "$val" in
    common|prod|preview) ;;
    *)
      echo "❌ Invalid value for --env: '$val' (expected 'common', 'prod', or 'preview')." >&2
      exit 1
      ;;
  esac
}

validate_mode() {
  local val="$1"
  case "$val" in
    auto|kustomize|yaml) ;;
    *)
      echo "❌ Invalid value for --mode: '$val' (expected 'auto', 'kustomize', or 'yaml')." >&2
      exit 1
      ;;
  esac
}

check_required_commands() {
  local required_cmds=(kubeconform pluto conftest jq)
  if [ "$TARGET_MODE" != "yaml" ]; then
    required_cmds+=(kustomize)
  fi
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
  [ "$name" = "kustomization.yaml" ] || [ "$name" = "kustomization.yml" ]
}

has_kustomization_in_dir() {
  local dir="$1"
  [ -f "${dir}/kustomization.yaml" ] || [ -f "${dir}/kustomization.yml" ]
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

combine_yaml_dir() {
  local env_name="$1"
  local dir="$2"
  local out_file="$3"

  local yaml_files=()
  mapfile -t yaml_files < <(
    find "$dir" -type f \( -name '*.yaml' -o -name '*.yml' \) \
      ! -name 'kustomization.yaml' ! -name 'kustomization.yml' | LC_ALL=C sort
  )

  if [ "${#yaml_files[@]}" -eq 0 ]; then
    echo "❌ Directory '$dir' (env=$env_name) contains no YAML files (excluding kustomization.yaml/.yml)." >&2
    exit 1
  fi

  : > "$out_file"
  local idx=0
  local f
  for f in "${yaml_files[@]}"; do
    if [ "$idx" -gt 0 ]; then
      printf '\n---\n' >> "$out_file"
    fi
    cat "$f" >> "$out_file"
    idx=$((idx + 1))
  done

  if ! has_yaml_content "$out_file"; then
    echo "❌ Directory '$dir' (env=$env_name) contains only empty YAML documents." >&2
    exit 1
  fi
}

render_target() {
  local env_name="$1"
  local target="$2"
  local out_file="$3"

  if [ ! -e "$target" ]; then
    echo "❌ Target '$target' (env=$env_name) does not exist." >&2
    exit 1
  fi

  local resolved_kind=""

  case "$TARGET_MODE" in
    kustomize)
      if [ -f "$target" ]; then
        if ! is_kustomization_filename "$(basename "$target")"; then
          echo "❌ Target '$target' (env=$env_name) is not a kustomization.yaml/.yml file (mode=kustomize)." >&2
          exit 1
        fi
        run_kustomize_build "$(dirname "$target")" "$out_file"
        resolved_kind="kustomize"
      elif [ -d "$target" ]; then
        if ! has_kustomization_in_dir "$target"; then
          echo "❌ Directory '$target' (env=$env_name) does not contain kustomization.yaml/.yml (mode=kustomize)." >&2
          exit 1
        fi
        run_kustomize_build "$target" "$out_file"
        resolved_kind="kustomize"
      else
        echo "❌ Target '$target' (env=$env_name) is neither a regular file nor a directory." >&2
        exit 1
      fi
      ;;
    yaml)
      if [ -f "$target" ]; then
        cp "$target" "$out_file"
        if ! has_yaml_content "$out_file"; then
          echo "❌ YAML file '$target' (env=$env_name) is empty." >&2
          exit 1
        fi
        resolved_kind="yaml-file"
      elif [ -d "$target" ]; then
        combine_yaml_dir "$env_name" "$target" "$out_file"
        resolved_kind="yaml-dir"
      else
        echo "❌ Target '$target' (env=$env_name) is neither a regular file nor a directory." >&2
        exit 1
      fi
      ;;
    auto)
      if [ -f "$target" ]; then
        local base
        base="$(basename "$target")"
        if is_kustomization_filename "$base"; then
          run_kustomize_build "$(dirname "$target")" "$out_file"
          resolved_kind="kustomize"
        elif [[ "$base" == *.yaml || "$base" == *.yml ]]; then
          cp "$target" "$out_file"
          if ! has_yaml_content "$out_file"; then
            echo "❌ YAML file '$target' (env=$env_name) is empty." >&2
            exit 1
          fi
          resolved_kind="yaml-file"
        else
          echo "❌ Unsupported file '$target' (env=$env_name) in mode=auto (expected .yaml or .yml)." >&2
          exit 1
        fi
      elif [ -d "$target" ]; then
        if has_kustomization_in_dir "$target"; then
          run_kustomize_build "$target" "$out_file"
          resolved_kind="kustomize"
        else
          combine_yaml_dir "$env_name" "$target" "$out_file"
          resolved_kind="yaml-dir"
        fi
      else
        echo "❌ Target '$target' (env=$env_name) is neither a regular file nor a directory." >&2
        exit 1
      fi
      ;;
  esac

  RESOLVED_KIND="$resolved_kind"
}

validate_target() {
  local env_name="$1"
  local raw_target="$2"
  local target="${raw_target%/}"
  if [ -z "$target" ]; then
    target="$raw_target"
  fi

  VALIDATED_COUNT=$((VALIDATED_COUNT + 1))

  local rendered="${WORK_DIR}/rendered-${VALIDATED_COUNT}-${env_name}.yaml"
  RESOLVED_KIND=""
  render_target "$env_name" "$target" "$rendered"

  echo "========================================"
  echo "Validating $target (env=$env_name, mode=$RESOLVED_KIND)"
  echo "========================================"

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
    echo "#### \`${target}\` (\`env=${env_name}\`)"
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

validate_target_list() {
  local env_name="$1"
  local raw_list="$2"
  local tokens=()
  local token resolved

  mapfile -t tokens < <(parse_target_list "$raw_list")
  for token in "${tokens[@]}"; do
    resolve_target_token "$env_name" "$token"
    for resolved in "${RESOLVED_TARGETS[@]}"; do
      validate_target "$env_name" "$resolved"
    done
  done
}

parse_cli_args "$@"
apply_defaults

validate_env "$TARGET_ENV"
validate_mode "$TARGET_MODE"
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

if [ "${#POSITIONAL_TARGETS[@]}" -gt 0 ]; then
  for token in "${POSITIONAL_TARGETS[@]}"; do
    resolve_target_token "$TARGET_ENV" "$token"
    for resolved in "${RESOLVED_TARGETS[@]}"; do
      validate_target "$TARGET_ENV" "$resolved"
    done
  done
fi

validate_target_list "$TARGET_ENV" "$TARGETS"
validate_target_list "common" "$COMMON_TARGETS"
validate_target_list "prod" "$PROD_TARGETS"
validate_target_list "prod" "$PROD_OVERLAYS"
validate_target_list "preview" "$PREVIEW_TARGETS"
validate_target_list "preview" "$PREVIEW_OVERLAYS"

if [ "$VALIDATED_COUNT" -eq 0 ]; then
  echo "❌ No targets were validated. Specify targets via positional args, --targets, --common-targets, --prod-targets/--prod-overlays, or --preview-targets/--preview-overlays." >&2
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
