/**
 * TSX / JSX の style={{ ... }} および Tailwind 任意値クラスの生カラーチェッカ
 * 例外は行末または直前行コメント「nuage-ui-ignore-color」でオプトアウトする。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const IGNORE_TOKEN = "nuage-ui-ignore-color";
const EXCLUDED_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "out", "coverage", "e2e", "mocks", "public",
  ".git", ".storybook", ".nuage-workspace-policies", "tests", "__tests__", "__mocks__",
  "playwright-report", "test-results", "storybook-static",
]);
const EXCLUDED_FILE_RE = /\.(?:test|spec|stories|config)\.[^/]+$|\.d\.ts$/i;
const RAW_COLOR_RE = /(?:^|[^a-zA-Z0-9_-])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?)\s*\()/gi;
const TW_COLOR_RE = /(?:^|[\s"'`:!])((?:bg|text|border(?:-[trblxyse])?|fill|stroke|from|via|to|ring(?:-offset)?|outline|decoration|accent|caret|shadow|divide|placeholder|stop)-\[(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})|(?:rgba?|hsla?)\([^\]\n]*\))\])/gi;
const toPosix = (p) => p.split(path.sep).join("/");
const parseList = (raw) => (raw ? raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : []);

export function scanTsxColors(content, file) {
  const lines = content.split(/\r?\n/), violations = [];
  for (let i = 0, depth = 0; i < lines.length; i += 1) {
    const line = lines[i], spans = [];
    const ignored = line.includes(IGNORE_TOKEN) || (i > 0 && lines[i - 1].includes(IGNORE_TOKEN));
    let spanStart = depth > 0 ? 0 : -1, quote = null;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (depth > 0) {
        if (quote) { if (ch === "\\" && j + 1 < line.length) j += 1; else if (ch === quote) quote = null; }
        else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
        else if (ch === "{") depth += 1;
        else if (ch === "}" && --depth === 0) { spans.push([spanStart, j + 1]); spanStart = -1; }
      } else {
        const m = /^style\s*=\s*\{\{/.exec(line.slice(j));
        if (m) { j += m[0].length - 1; depth = 2; spanStart = j + 1; }
      }
    }
    if (depth > 0 && spanStart !== -1) spans.push([spanStart, line.length]);
    if (ignored) continue;
    for (const [s, e] of spans) for (const m of line.slice(s, e).matchAll(RAW_COLOR_RE)) violations.push({ file, line: i + 1, column: s + m.index + (m[0].length - m[1].length) + 1, message: `Unexpected raw color "${m[1].trim()}" in inline style.` });
    for (const m of line.matchAll(TW_COLOR_RE)) violations.push({ file, line: i + 1, column: m.index + (m[0].length - m[1].length) + 1, message: `Unexpected Tailwind arbitrary color class "${m[1]}".` });
  }
  return violations;
}

export function checkTsxColors(targetDir = ".", excludes = parseList(process.env.EXCLUDE)) {
  const root = path.resolve(targetDir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Target directory '${targetDir}' is not a directory.`);
  const pats = excludes.map((raw) => toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, ""));
  const isExcluded = (rel) => EXCLUDED_FILE_RE.test(rel) || pats.some((p) => (
    /[*?]/.test(p) ? path.matchesGlob(rel, p) || (!p.includes("/") && path.matchesGlob(path.posix.basename(rel), p)) : rel === p || rel.startsWith(`${p}/`) || (!p.includes("/") && rel.split("/").includes(p))
  ));
  const files = fs.globSync("**/*.{tsx,jsx}", { cwd: root, exclude: (n) => EXCLUDED_DIRS.has(path.posix.basename(n)) }).map(toPosix).filter((rel) => !isExcluded(rel)).sort();
  return { files, violations: files.flatMap((rel) => scanTsxColors(fs.readFileSync(path.join(root, rel), "utf8"), rel)) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const { files, violations } = checkTsxColors(process.argv[2] || process.env.TARGET_DIR || ".");
  for (const v of violations) console.log(`${v.file}:${v.line}:${v.column} [nuage-ui/no-raw-color] ${v.message}`);
  if (violations.length > 0) process.exit(1);
  console.log(`✅ TSX/JSX color check passed (${files.length} files).`);
}
