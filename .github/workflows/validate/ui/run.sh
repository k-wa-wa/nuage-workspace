#!/usr/bin/env bash
set -euo pipefail

# Nuage UI 設計標準の共通検証ランナー
#
# 【なぜこのルールが必要か】
# 1. 生カラー直書き禁止（nuage-ui/no-raw-color）:
#    Nuage UI はダークテーマ専用であり、色・透過率をエントリ CSS のセマンティックトークンへ
#    一元化する。コンポーネント等への #hex / rgb() / rgba() / hsl() / hsla() 直書きを防ぐ。
#    正当な例外（PWA themeColor・manifest.ts・3D ライブラリ属性等）は行末または直前行コメント
#    「nuage-ui-ignore-color」でオプトアウトする。
# 2. :hover の @media (hover: hover) ラップ必須（nuage-ui/hover-media-query）:
#    タッチデバイスでタップ後に :hover が残留する問題を防ぐため、:hover セレクタは必ず
#    @media (hover: hover) 内に配置する。例外は「nuage-ui-ignore-hover」でオプトアウトする。
# 3. エントリ CSS の必須トークン・モバイル/アクセシビリティガードレール（nuage-ui/entry-css-guardrails）:
#    必須 21 変数、-webkit-tap-highlight-color: transparent、:focus:not(:focus-visible) 抑止 +
#    :focus-visible 定義、user-select: none + touch-action: manipulation、およびモバイル幅での
#    input / textarea / select の font-size >= 16px（iOS Safari 自動ズーム防止）を検証する。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET_DIR="${TARGET_DIR:-}"
ENTRY_CSS="${ENTRY_CSS:-}"
EXCLUDE="${EXCLUDE:-}"
FAIL_ON_POLICY="${FAIL_ON_POLICY:-true}"

POSITIONAL_TARGETS=()
CLI_EXCLUDES=()

usage() {
  cat << 'EOF'
Usage: run.sh [OPTIONS] [target-dir]

Nuage UI 設計標準の共通検証（生カラー禁止・:hover ガード・エントリ CSS 必須トークン/ガードレール）を実行する。
既定で *.test.*, *.spec.*, *.stories.*, *.config.*, *.d.ts, e2e/, mocks/, public/, .storybook/, node_modules/, .next/, dist/ 等を除外する。
各オプションは環境変数でも指定できる（CLI 引数が優先される）。

Options:
  --target-dir <dir>         検証対象ディレクトリ（位置引数でも指定可 / TARGET_DIR）
  --entry-css <path>         エントリ CSS のパス（指定時は必須トークン・ガードレールを検証 / ENTRY_CSS）
  --exclude <pattern>        追加除外パス/glob（カンマ・改行区切り、複数指定可 / EXCLUDE）
  --fail-on-policy <bool>    ポリシー違反時に失敗終了するか（既定: true / FAIL_ON_POLICY）
  -h, --help                 このヘルプを表示する
EOF
}

parse_cli_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      --target-dir=*)
        TARGET_DIR="${1#*=}"
        shift
        ;;
      --target-dir)
        [ "$#" -ge 2 ] || { echo "❌ --target-dir requires a value." >&2; exit 1; }
        TARGET_DIR="$2"
        shift 2
        ;;
      --entry-css=*)
        ENTRY_CSS="${1#*=}"
        shift
        ;;
      --entry-css)
        [ "$#" -ge 2 ] || { echo "❌ --entry-css requires a value." >&2; exit 1; }
        ENTRY_CSS="$2"
        shift 2
        ;;
      --exclude=*)
        CLI_EXCLUDES+=("${1#*=}")
        shift
        ;;
      --exclude)
        [ "$#" -ge 2 ] || { echo "❌ --exclude requires a value." >&2; exit 1; }
        CLI_EXCLUDES+=("$2")
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
  if ! command -v node >/dev/null 2>&1; then
    echo "❌ Missing required command(s): node" >&2
    exit 1
  fi
}

ensure_dependencies() {
  if [ -d "${SCRIPT_DIR}/node_modules/stylelint" ] && [ -d "${SCRIPT_DIR}/node_modules/typescript" ]; then
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "❌ Missing node_modules in '${SCRIPT_DIR}' and 'npm' is not available." >&2
    exit 1
  fi

  echo "Installing UI validation dependencies..."
  npm ci --prefix "$SCRIPT_DIR" --silent --no-audit --no-fund
}

parse_cli_args "$@"
validate_bool "FAIL_ON_POLICY" "$FAIL_ON_POLICY"

if [ "${#POSITIONAL_TARGETS[@]}" -gt 1 ]; then
  echo "❌ Only one target directory can be specified." >&2
  usage >&2
  exit 1
fi

if [ "${#POSITIONAL_TARGETS[@]}" -eq 1 ]; then
  TARGET_DIR="${POSITIONAL_TARGETS[0]}"
fi

if [ -z "$TARGET_DIR" ]; then
  echo "❌ No target directory specified." >&2
  usage >&2
  exit 1
fi

check_required_commands
ensure_dependencies

NODE_ARGS=(
  --target-dir "$TARGET_DIR"
  --fail-on-policy "$FAIL_ON_POLICY"
)

if [ -n "$ENTRY_CSS" ]; then
  NODE_ARGS+=(--entry-css "$ENTRY_CSS")
fi

if [ -n "$EXCLUDE" ]; then
  NODE_ARGS+=(--exclude "$EXCLUDE")
fi

for ex in "${CLI_EXCLUDES[@]}"; do
  NODE_ARGS+=(--exclude "$ex")
done

exec node "${SCRIPT_DIR}/lint.mjs" "${NODE_ARGS[@]}"
