#!/usr/bin/env bash
set -euo pipefail

# Nuage UI 設計標準の共通検証ランナー
#
# 【なぜこのルールが必要か】
# 1. CSS の生カラー直書き禁止（color-no-hex / color-named / function-disallowed-list）:
#    ダークテーマ専用設計の一貫性を保つため、エントリ CSS を除く CSS ファイルでの
#    #hex / 名前付きカラー / rgb() / rgba() / hsl() / hsla() の直書きを禁止する。
# 2. CSS の :hover ガード必須（defensive-css/no-accidental-hover）:
#    タッチデバイスでタップ後に :hover が残留する不具合を防ぐため、:hover は
#    @media (hover: hover) 内に限定する。
#    CSS 内の正当な例外は /* stylelint-disable-next-line <rule> */ でオプトアウトする。
# 3. TSX / JSX の生カラー直書き禁止（nuage-ui/no-raw-color）:
#    style={{ ... }} インラインスタイルおよび Tailwind 任意値クラス（bg-[#...] 等）への
#    生カラー直書きを禁止する。正当な例外は行末または直前行コメント
#    「nuage-ui-ignore-color」でオプトアウトする。
#    ※ <style>{...}</style> や一般 JS 文字列、エントリ CSS 基盤等は docs/ui-design.md に基づきレビューで確認する。

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

Nuage UI 設計標準の共通検証（CSS の生カラー禁止・:hover ガード、TSX/JSX の style={{}}・Tailwind 任意値生カラー禁止）を実行する。
既定で *.test.*, *.spec.*, *.stories.*, *.config.*, *.d.ts, e2e/, mocks/, public/, .storybook/, node_modules/, .next/, dist/ 等を除外する。
動作要件: Node.js >= 22.5.0。各オプションは環境変数でも指定できる（CLI 引数が優先される）。

Options:
  --target-dir <dir>         検証対象ディレクトリ（位置引数でも指定可 / TARGET_DIR）
  --entry-css <path>         エントリ CSS のパス（指定時は同ファイルの色ルールのみ除外 / ENTRY_CSS）
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
  if ! node -e 'const path = require("node:path"); const [maj, min] = process.versions.node.split(".").map(Number); if (maj < 22 || (maj === 22 && min < 5) || typeof path.matchesGlob !== "function") process.exit(1);' 2>/dev/null; then
    echo "❌ Node.js >= 22.5.0 is required (current: $(node -v))." >&2
    exit 1
  fi
}

ensure_dependencies() {
  if [ -d "${SCRIPT_DIR}/node_modules/stylelint" ] && \
     [ -d "${SCRIPT_DIR}/node_modules/stylelint-plugin-defensive-css" ]; then
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
