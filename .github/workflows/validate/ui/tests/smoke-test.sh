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

create_valid_frontend() {
  local dir="$1"
  mkdir -p "${dir}/src/components"
  cat << 'EOF' > "${dir}/src/index.css"
:root {
  --bg: #191816;
  --fg: #e8e4dc;
  --accent-subtle: rgba(96, 165, 250, 0.08);
}

@media (hover: hover) {
  button:hover {
    opacity: 0.9;
  }
}
EOF

  cat << 'EOF' > "${dir}/src/components/Button.tsx"
export function Button() {
  return (
    <button style={{ color: "var(--fg)", backgroundColor: "var(--bg)" }}>
      Click
    </button>
  );
}
EOF
}

echo "=== Smoke Test 1: Valid frontend PASS (GITHUB_STEP_SUMMARY unset & set) ==="
PASS_DIR="${TMP_ROOT}/pass-frontend"
create_valid_frontend "$PASS_DIR"
(
  cd "$PASS_DIR"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --entry-css src/index.css .
)

SUMMARY_PASS="${TMP_ROOT}/summary-pass.md"
(
  cd "$PASS_DIR"
  GITHUB_STEP_SUMMARY="$SUMMARY_PASS" TARGET_DIR="." ENTRY_CSS="src/index.css" "$RUNNER"
)
grep -q "### UI Design Standard Validation" "$SUMMARY_PASS"
grep -qF "\`violations\`: \`0\`" "$SUMMARY_PASS"

echo "=== Smoke Test 2: Policy violation FAIL (fail-on-policy=true) ==="
FAIL_DIR="${TMP_ROOT}/fail-frontend"
create_valid_frontend "$FAIL_DIR"
cat << 'EOF' > "${FAIL_DIR}/src/components/bad.css"
.bad {
  color: #ffffff;
}
.bad:hover {
  opacity: 0.5;
}
EOF
cat << 'EOF' > "${FAIL_DIR}/src/components/Bad.tsx"
export function Bad() {
  return <div className="bg-[#191816]" style={{ color: "#ffffff" }} />;
}
EOF

FAIL_OUT="${TMP_ROOT}/fail.out"
if (cd "$FAIL_DIR" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --entry-css src/index.css . >"$FAIL_OUT" 2>&1); then
  echo "❌ Expected policy violation run to fail, but it succeeded." >&2
  exit 1
fi
grep -q "color-no-hex" "$FAIL_OUT"
grep -q "defensive-css/no-accidental-hover" "$FAIL_OUT"
grep -q "nuage-ui/no-raw-color" "$FAIL_OUT"

echo "=== Smoke Test 3: Policy violation warning PASS (fail-on-policy=false) ==="
SUMMARY_WARN="${TMP_ROOT}/summary-warn.md"
(
  cd "$FAIL_DIR"
  GITHUB_STEP_SUMMARY="$SUMMARY_WARN" "$RUNNER" --entry-css src/index.css --fail-on-policy false .
)
grep -q "fail-on-policy: false" "$SUMMARY_WARN"

echo "=== Smoke Test 4: --exclude CLI and EXCLUDE env var ==="
(
  cd "$FAIL_DIR"
  env -u GITHUB_STEP_SUMMARY "$RUNNER" --entry-css src/index.css --exclude "src/components/Bad.tsx,src/components/bad.css" .
  env -u GITHUB_STEP_SUMMARY EXCLUDE="src/components/Bad.tsx,src/components/bad.css" "$RUNNER" --entry-css src/index.css .
)

echo "=== Smoke Test 5: Missing node command detection ==="
MIN_BIN="${TMP_ROOT}/min-bin"
mkdir -p "$MIN_BIN"
for base_cmd in bash dirname cat rm mktemp; do
  if command -v "$base_cmd" >/dev/null 2>&1; then
    ln -sf "$(command -v "$base_cmd")" "${MIN_BIN}/${base_cmd}"
  fi
done
MISSING_OUT="${TMP_ROOT}/missing.out"
if (cd "$PASS_DIR" && PATH="$MIN_BIN" "${MIN_BIN}/bash" "$RUNNER" . >"$MISSING_OUT" 2>&1); then
  echo "❌ Expected missing node check to fail, but it succeeded." >&2
  exit 1
fi
grep -q "Missing required command(s): node" "$MISSING_OUT"

echo "=== Smoke Test 6: Argument validation ==="
NO_TARGET_OUT="${TMP_ROOT}/no-target.out"
if (cd "$PASS_DIR" && env -u GITHUB_STEP_SUMMARY "$RUNNER" >"$NO_TARGET_OUT" 2>&1); then
  echo "❌ Expected zero target-dir to fail, but it succeeded." >&2
  exit 1
fi
grep -q "Usage: run.sh" "$NO_TARGET_OUT"

BAD_ENTRY_OUT="${TMP_ROOT}/bad-entry.out"
if (cd "$PASS_DIR" && env -u GITHUB_STEP_SUMMARY "$RUNNER" --entry-css src/nonexistent.css . >"$BAD_ENTRY_OUT" 2>&1); then
  echo "❌ Expected missing entry-css file to fail, but it succeeded." >&2
  exit 1
fi
grep -q "does not exist" "$BAD_ENTRY_OUT"

echo "✅ All UI validation unit & smoke tests passed."
