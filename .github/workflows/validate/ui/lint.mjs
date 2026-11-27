/**
 * Nuage UI 設計標準 統合チェックランナー（信頼できるポリシーディレクトリから実行）
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";
import { buildStylelintConfig } from "./stylelint.config.mjs";
import { collectUiFiles, parseList, scanTsxColors, toPosix } from "./check-tsx-colors.mjs";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function runUiLint({
  targetDir = process.env.TARGET_DIR || ".",
  repoRoot = process.env.REPO_ROOT || process.cwd(),
  entryCss = process.env.ENTRY_CSS || "",
  excludes = parseList(process.env.EXCLUDE),
} = {}) {
  const root = path.resolve(repoRoot || process.cwd(), targetDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Target directory '${targetDir}' does not exist.`);
  const config = buildStylelintConfig({ cwd: root, repoRoot, entryCss, excludes });
  const { cssFiles, tsxFiles } = collectUiFiles(root, excludes);
  const entryPath = config.overrides?.[0]?.files?.[0] ? path.resolve(root, entryCss) : null;
  const resolvedEntry = entryPath && fs.existsSync(entryPath) ? fs.realpathSync(entryPath) : (entryCss ? fs.realpathSync(path.isAbsolute(entryCss) ? entryCss : [path.resolve(root, entryCss), path.resolve(repoRoot || process.cwd(), entryCss)].find((c) => fs.existsSync(c))) : null);
  const allCss = [...new Set([...cssFiles.map((f) => fs.realpathSync(f)), ...(resolvedEntry ? [resolvedEntry] : [])])].sort();
  const toRel = (f) => toPosix(path.relative(root, f)) || path.basename(f);
  const violations = [];

  if (allCss.length > 0) {
    const res = await stylelint.lint({ files: allCss, config, cwd: UI_DIR, configBasedir: UI_DIR });
    for (const r of res.results) {
      if (r.parseErrors?.length) throw new Error(`${toRel(r.source)}: CSS parse error: ${r.parseErrors[0].text}`);
      if (r.invalidOptionWarnings?.length) throw new Error(`${r.invalidOptionWarnings[0].text}`);
      for (const w of r.warnings) {
        if (w.rule === "CssSyntaxError") throw new Error(`${toRel(r.source)}:${w.line}:${w.column} CssSyntaxError: ${w.text}`);
        violations.push({ file: toRel(r.source), line: w.line ?? 1, column: w.column ?? 1, rule: w.rule, message: w.text.replace(/\s*\([^)]+\)\s*$/, "") });
      }
    }
  }
  for (const f of tsxFiles) {
    for (const v of scanTsxColors(fs.readFileSync(f, "utf8"), toRel(f))) violations.push({ ...v, rule: "nuage-ui/no-raw-color" });
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return { checkedFiles: allCss.length + tsxFiles.length, violations };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const failOnPolicy = (process.env.FAIL_ON_POLICY ?? "true") !== "false";
    const { checkedFiles, violations } = await runUiLint();
    for (const v of violations) console.log(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
    if (violations.length > 0) {
      if (!failOnPolicy) { console.log(`::warning::UI design standard violations detected (${violations.length}, fail-on-policy=false).`); process.exit(0); }
      process.exit(2);
    }
    console.log(`✅ UI validation passed (${checkedFiles} files).`);
  } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }
}
