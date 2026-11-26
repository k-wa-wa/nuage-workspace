#!/usr/bin/env node
/**
 * Nuage UI 設計標準の共通 lint ランナー
 *
 * CSS は stylelint.config.mjs（生カラー直書き禁止・:hover ガード）で検証し、
 * TSX/JSX は style={{ ... }} インラインスタイルおよび Tailwind 任意値クラスの生カラーのみを
 * 軽量スキャン（nuage-ui/no-raw-color）で検出する。
 * 例外は CSS が「stylelint-disable-next-line <rule>」、TSX/JSX が行末/直前行「nuage-ui-ignore-color」。
 * <style>{...}</style>・JS 設定・エントリ CSS 基盤等は docs/ui-design.md に基づきレビューで確認する。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs as nodeParseArgs } from "node:util";
import stylelint from "stylelint";
import { buildStylelintConfig } from "./stylelint.config.mjs";

const IGNORE_COLOR_TOKEN = "nuage-ui-ignore-color";
const RULE_TSX_RAW_COLOR = "nuage-ui/no-raw-color";
const EXCLUDED_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "out", "coverage",
  "e2e", "mocks", "public", ".git", ".storybook", ".nuage-workspace-policies",
  "tests", "__tests__", "__mocks__", "playwright-report", "test-results", "storybook-static",
]);
const EXCLUDED_FILE_RE = /\.(?:test|spec|stories|config)\.[^/]+$|\.d\.ts$/i;
const RAW_COLOR_RE = /(?:^|[^a-zA-Z0-9_-])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?)\s*\()/gi;
const TW_COLOR_RE = /(?:^|[\s"'`:!])((?:bg|text|border(?:-[trblxyse])?|fill|stroke|from|via|to|ring(?:-offset)?|outline|decoration|accent|caret|shadow|divide|placeholder|stop)-\[(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})|(?:rgba?|hsla?)\([^\]\n]*\))\])/gi;

const toPosix = (p) => p.split(path.sep).join("/");
const parseList = (raw) => (raw ? raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : []);

function matchesExclude(relPath, excludes) {
  const base = path.posix.basename(relPath);
  return excludes.some(({ pattern, hasWildcard }) => {
    if (!hasWildcard) return relPath === pattern || relPath.startsWith(`${pattern}/`);
    const match = (s, p) => path.matchesGlob(s, p) || path.matchesGlob(s.replace(/(^|\/)\.(?!\.?(?:\/|$))/g, "$1_dot_"), p.replace(/(^|\/)\.(?!\.?(?:\/|$))/g, "$1_dot_"));
    return match(relPath, pattern) || (!pattern.includes("/") && match(base, pattern));
  });
}

function collectFiles(targetDir, rawExcludes) {
  const excludes = rawExcludes.map((raw) => {
    const pattern = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    return { pattern, hasWildcard: /[*?]/.test(pattern) };
  });
  const cssFiles = [], tsxFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name), rel = toPosix(path.relative(targetDir, full));
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name) && !matchesExclude(rel, excludes)) walk(full);
      } else if (e.isFile() && !EXCLUDED_FILE_RE.test(rel) && !matchesExclude(rel, excludes)) {
        const ext = path.extname(e.name).toLowerCase();
        if (ext === ".css") cssFiles.push(full);
        else if (ext === ".tsx" || ext === ".jsx") tsxFiles.push(full);
      }
    }
  })(targetDir);
  return { cssFiles, tsxFiles };
}

export function scanTsxColors(content, relFile) {
  const lines = content.split(/\r?\n/), violations = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const ignored = line.includes(IGNORE_COLOR_TOKEN) || (i > 0 && lines[i - 1].includes(IGNORE_COLOR_TOKEN));
    const spans = [];
    let spanStart = depth > 0 ? 0 : -1, quote = null;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (depth > 0) {
        if (quote) {
          if (ch === "\\" && j + 1 < line.length) j += 1;
          else if (ch === quote) quote = null;
        } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
        else if (ch === "{") depth += 1;
        else if (ch === "}" && --depth === 0) { spans.push([spanStart, j + 1]); spanStart = -1; }
      } else {
        const m = /^style\s*=\s*\{\{/.exec(line.slice(j));
        if (m) { j += m[0].length - 1; depth = 2; spanStart = j + 1; }
      }
    }
    if (depth > 0 && spanStart !== -1) spans.push([spanStart, line.length]);
    if (ignored) continue;
    for (const [s, e] of spans) {
      for (const m of line.slice(s, e).matchAll(RAW_COLOR_RE)) {
        violations.push({ file: relFile, line: i + 1, column: s + m.index + (m[0].length - m[1].length) + 1, rule: RULE_TSX_RAW_COLOR, message: `Unexpected raw color "${m[1].trim()}" in inline style.` });
      }
    }
    for (const m of line.matchAll(TW_COLOR_RE)) {
      violations.push({ file: relFile, line: i + 1, column: m.index + (m[0].length - m[1].length) + 1, rule: RULE_TSX_RAW_COLOR, message: `Unexpected Tailwind arbitrary color class "${m[1]}".` });
    }
  }
  return violations;
}

export async function runUiLint({ targetDir, entryCss = "", excludes = [] }) {
  const root = fs.realpathSync(path.resolve(targetDir));
  let entryPath = null;
  if (entryCss) {
    const candidates = path.isAbsolute(entryCss) ? [entryCss] : [path.resolve(root, entryCss), path.resolve(process.cwd(), entryCss)];
    const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) throw new Error(`Entry CSS file '${entryCss}' does not exist.`);
    entryPath = fs.realpathSync(found);
  }
  const { cssFiles, tsxFiles } = collectFiles(root, excludes);
  const allCss = [...new Set([...cssFiles.map((f) => fs.realpathSync(f)), ...(entryPath ? [entryPath] : [])])].sort();
  const toRel = (abs) => toPosix(path.relative(root, abs)) || path.basename(abs);
  const violations = [];

  if (allCss.length > 0) {
    const res = await stylelint.lint({
      files: allCss.map(toRel), cwd: root, configBasedir: root,
      config: buildStylelintConfig(entryPath ? toRel(entryPath) : ""),
    });
    for (const r of res.results) {
      for (const w of r.warnings) {
        violations.push({ file: toRel(r.source), line: w.line ?? 1, column: w.column ?? 1, rule: w.rule, message: w.text.replace(/\s*\([^)]+\)\s*$/, "") });
      }
    }
  }
  for (const f of tsxFiles) violations.push(...scanTsxColors(fs.readFileSync(f, "utf8"), toRel(f)));
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return { targetDir: root, entryCssPath: entryPath, checkedFilesCount: allCss.length + tsxFiles.length, violations };
}

async function main() {
  let values, positionals;
  try {
    ({ values, positionals } = nodeParseArgs({
      args: process.argv.slice(2), allowPositionals: true,
      options: { "target-dir": { type: "string" }, "entry-css": { type: "string" }, exclude: { type: "string", multiple: true }, "fail-on-policy": { type: "string" }, json: { type: "boolean" } },
    }));
  } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }

  if (positionals.length > 1 || (positionals.length === 1 && values["target-dir"])) { console.error("❌ Unexpected positional argument."); process.exit(1); }
  const targetDir = values["target-dir"] || positionals[0] || process.env.TARGET_DIR || "";
  const entryCss = values["entry-css"] ?? process.env.ENTRY_CSS ?? "";
  const excludes = [...parseList(process.env.EXCLUDE || ""), ...(values.exclude || []).flatMap(parseList)];
  const failStr = values["fail-on-policy"] ?? process.env.FAIL_ON_POLICY ?? "true";
  if (!targetDir || !fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) { console.error(`❌ Target directory '${targetDir}' does not exist or is not a directory.`); process.exit(1); }
  if (failStr !== "true" && failStr !== "false") { console.error(`❌ Invalid boolean value for FAIL_ON_POLICY: '${failStr}'.`); process.exit(1); }
  const failOnPolicy = failStr === "true";

  let result;
  try { result = await runUiLint({ targetDir, entryCss, excludes }); }
  catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }

  const entryLabel = result.entryCssPath ? toPosix(path.relative(result.targetDir, result.entryCssPath)) || entryCss : entryCss;
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ["### UI Design Standard Validation", "", `- \`target-dir\`: \`${targetDir}\``, `- \`entry-css\`: \`${entryLabel || "(none)"}\``, `- \`fail-on-policy\`: \`${failOnPolicy}\``, `- \`files-checked\`: \`${result.checkedFilesCount}\``, `- \`violations\`: \`${result.violations.length}\``, ""];
    if (result.violations.length === 0) lines.push("✅ すべての UI 設計標準チェックを通過した。");
    else {
      lines.push("```text", ...result.violations.map((v) => `${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`), "```");
      if (!failOnPolicy) lines.push("", "> [!WARNING]", "> UI ポリシー違反が検出されたが `fail-on-policy: false` のため警告のみで通過させた。");
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, "utf8");
  }

  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log("========================================");
    console.log(`UI Validation: ${targetDir}`);
    if (entryLabel) console.log(`Entry CSS    : ${entryLabel}`);
    console.log(`Files checked: ${result.checkedFilesCount}`);
    console.log("========================================");
    if (result.violations.length === 0) console.log("✅ 0 violations found.");
    else {
      for (const v of result.violations) console.log(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
      console.log(`\nFound ${result.violations.length} UI policy violation(s).`);
    }
  }
  if (result.violations.length > 0) {
    if (failOnPolicy) { console.error("❌ UI design standard violations detected."); process.exit(1); }
    console.log("⚠️ UI design standard violations detected, but fail-on-policy=false so continuing with warnings.");
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) main();
