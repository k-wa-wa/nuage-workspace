/**
 * TSX / JSX の style={{ ... }} および Tailwind 任意値クラスの生カラーチェッカ
 * 例外は行末または単独直前行コメント「nuage-ui-ignore-color」でオプトアウトする。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const IGNORE_TOKEN = "nuage-ui-ignore-color";
const EXCLUDED_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "out", "coverage", "e2e", "mocks", "public",
  ".git", ".storybook", ".nuage-workspace-policies", "tests", "__tests__", "__mocks__",
  "playwright-report", "test-results", "storybook-static",
]);
const EXCLUDED_FILE_RE = /\.(?:test|spec|stories|config)\.[^/]+$|\.d\.ts$/i;
const RAW_COLOR_RE = /(?:^|[^a-zA-Z0-9_-])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?)\s*\()/gi;
const URL_HASH_RE = /url\s*\(\s*["']?#[^)]*\)/gi;
const TW_COLOR_RE = /(?:^|[\s"'`:!])((?:bg|text|border(?:-[trblxyse])?|fill|stroke|from|via|to|ring(?:-offset)?|outline|decoration|accent|caret|shadow|divide|placeholder|stop)-\[(?:color:)?(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})|(?:rgba?|hsla?)\([^\]\n]*\))\])/gi;
const JSX_PRE_IDENT = new Set(["return", "await", "yield", "throw", "case", "else", "typeof", "void", "delete", "in", "of"]);
const toPosix = (p) => p.split(path.sep).join("/");
const parseList = (raw) => (raw ? raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : []);

export function scanTsxColors(src, file) {
  const lineStarts = [0];
  for (let k = 0; k < src.length; k += 1) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const loc = (pos) => { const line = lineOf(pos); return { line, column: pos - lineStarts[line - 1] + 1 }; };
  const codeLines = new Set(), ignoreLines = new Set(), hits = [];
  const markCode = (a, b) => { for (let k = a; k < b; k += 1) if (!/\s/.test(src[k])) codeLines.add(lineOf(k)); };
  const recordComment = (a, b) => {
    const seg = src.slice(a, b);
    for (let idx = 0; (idx = seg.indexOf(IGNORE_TOKEN, idx)) !== -1; idx += IGNORE_TOKEN.length) ignoreLines.add(lineOf(a + idx));
  };
  const scanStr = (a, b, inStyle) => {
    const text = src.slice(a, b);
    for (const m of text.matchAll(TW_COLOR_RE)) hits.push({ ...loc(a + m.index + (m[0].length - m[1].length)), message: `Unexpected Tailwind arbitrary color class "${m[1]}".` });
    if (inStyle) {
      for (const m of text.replace(URL_HASH_RE, (s) => " ".repeat(s.length)).matchAll(RAW_COLOR_RE)) hits.push({ ...loc(a + m.index + (m[0].length - m[1].length)), message: `Unexpected raw color "${m[1].trim()}" in inline style.` });
    }
  };
  const stack = [{ type: "js", inStyle: false, canRegex: true, canJsx: true }];
  const top = () => stack[stack.length - 1], inStyle = () => stack.some((f) => f.inStyle);
  const scanTpl = (start) => {
    for (let j = start, cs = j; j < src.length; j += 1) {
      if (src[j] === "\\") { j += 1; continue; }
      if (src[j] === "`") { scanStr(cs, j, inStyle()); markCode(j, j + 1); return j + 1; }
      if (src[j] === "$" && src[j + 1] === "{") { scanStr(cs, j, inStyle()); markCode(j, j + 2); stack.push({ type: "tpl" }, { type: "js", inStyle: false, canRegex: true, canJsx: true }); return j + 2; }
    }
    scanStr(start, src.length, inStyle());
    return src.length;
  };

  for (let i = 0; i < src.length;) {
    const ctx = top(), ch = src[i];
    if (ctx.type === "jsx-text") {
      if (ch === "{") {
        const jsxComment = /^\s*\/\*/.test(src.slice(i + 1));
        if (!jsxComment) markCode(i, i + 1);
        stack.push({ type: "js", inStyle: false, canRegex: true, canJsx: true, jsxComment });
        i += 1;
      } else if (ch === "<" && src[i + 1] === "/") {
        const c = src.indexOf(">", i + 2);
        markCode(i, c === -1 ? src.length : c + 1); stack.pop(); i = c === -1 ? src.length : c + 1;
      } else if (ch === "<" && (src[i + 1] === ">" || /[A-Za-z_$]/.test(src[i + 1] || ""))) {
        markCode(i, i + 1); stack.push({ type: "jsx-tag" }); i += 1;
      } else { if (!/\s/.test(ch)) codeLines.add(lineOf(i)); i += 1; }
      continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i + 2), end = nl === -1 ? src.length : nl; recordComment(i, end); i = end; continue; }
    if (ch === "/" && src[i + 1] === "*") { const c = src.indexOf("*/", i + 2), end = c === -1 ? src.length : c + 2; recordComment(i, end); i = end; continue; }
    if (ch === "\"" || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === "\\" ? 2 : 1;
      markCode(i, Math.min(j + 1, src.length)); scanStr(i + 1, j, inStyle());
      if (ctx.type === "js") { ctx.canRegex = ctx.canJsx = ctx.expectStyle = false; }
      i = Math.min(j + 1, src.length); continue;
    }
    if (ch === "`") { markCode(i, i + 1); if (ctx.type === "js") ctx.canRegex = ctx.canJsx = ctx.expectStyle = false; i = scanTpl(i + 1); continue; }
    if (ctx.type === "jsx-tag") {
      if (ch === "/" && src[i + 1] === ">") { markCode(i, i + 2); stack.pop(); i += 2; }
      else if (ch === ">") { markCode(i, i + 1); if (/^\s*\(/.test(src.slice(i + 1))) stack.pop(); else ctx.type = "jsx-text"; i += 1; }
      else if (ch === "{") { markCode(i, i + 1); stack.push({ type: "js", inStyle: false, expectStyle: Boolean(ctx.pendingStyle), canRegex: true, canJsx: true }); ctx.pendingStyle = false; i += 1; }
      else {
        const sm = /^style\s*=\s*(?=\{)/.exec(src.slice(i));
        if (sm && (i === 0 || !/[A-Za-z0-9_$-]/.test(src[i - 1]))) { ctx.pendingStyle = true; markCode(i, i + sm[0].length); i += sm[0].length; }
        else { ctx.pendingStyle = false; markCode(i, i + 1); i += 1; }
      }
      continue;
    }
    if (ch === "/" && ctx.canRegex) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; else if (src[j] === "/" && !cls) { j += 1; break; }
        j += 1;
      }
      markCode(i, j); ctx.canRegex = ctx.canJsx = ctx.expectStyle = false; i = j; continue;
    }
    if (ch === "{") { markCode(i, i + 1); stack.push({ type: "js", inStyle: Boolean(ctx.expectStyle), canRegex: true, canJsx: true }); ctx.expectStyle = false; i += 1; continue; }
    if (ch === "}") {
      if (!(ctx.jsxComment && src.slice(0, i).trimEnd().endsWith("*/"))) markCode(i, i + 1);
      if (stack.length > 1) stack.pop();
      if (top().type === "tpl") { stack.pop(); i = scanTpl(i + 1); continue; }
      if (top().type === "js") top().canRegex = top().canJsx = false;
      i += 1; continue;
    }
    if (ch === "<" && ctx.canJsx && (src[i + 1] === ">" || (/^[A-Za-z_$]/.test(src[i + 1] || "") && !/^[A-Za-z_$][\w$]*\s*(?:,|extends\b)/.test(src.slice(i + 1, i + 40))))) {
      markCode(i, i + 1); stack.push({ type: "jsx-tag" }); ctx.canRegex = ctx.canJsx = ctx.expectStyle = false; i += 1; continue;
    }
    if (ch === "=" && src[i + 1] === ">") { markCode(i, i + 2); ctx.canRegex = ctx.canJsx = true; ctx.expectStyle = false; i += 2; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1; while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      markCode(i, j); ctx.canRegex = ctx.canJsx = JSX_PRE_IDENT.has(src.slice(i, j)); ctx.expectStyle = false; i = j; continue;
    }
    if (/[0-9]/.test(ch)) { let j = i + 1; while (j < src.length && /[0-9a-zA-ZxXoObBn._]/.test(src[j])) j += 1; markCode(i, j); ctx.canRegex = ctx.canJsx = ctx.expectStyle = false; i = j; continue; }
    markCode(i, i + 1); ctx.canRegex = ctx.canJsx = "([{:;,=?&|!+-*%^~".includes(ch); ctx.expectStyle = false; i += 1;
  }
  return hits.filter((h) => !ignoreLines.has(h.line) && !(ignoreLines.has(h.line - 1) && !codeLines.has(h.line - 1))).map((h) => ({ file, ...h }));
}

export function checkTsxColors(targetDir = ".", excludes = parseList(process.env.EXCLUDE)) {
  const root = path.resolve(targetDir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Target directory '${targetDir}' is not a directory.`);
  const normDot = (s) => s.replace(/(^|\/)\.(?!\.?(?:\/|$))/g, "$1_dot_");
  const pats = excludes.map((raw) => ({ p: toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, ""), glob: /[*?]/.test(raw) }));
  const isExcluded = (rel) => pats.some(({ p, glob }) => {
    if (!glob) return rel === p || rel.startsWith(`${p}/`);
    const m = (s, pat) => path.matchesGlob(s, pat) || path.matchesGlob(normDot(s), normDot(pat));
    return m(rel, p) || (!p.includes("/") && m(path.posix.basename(rel), p));
  });
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name), rel = toPosix(path.relative(root, full));
      if (e.isDirectory()) { if (!EXCLUDED_DIRS.has(e.name) && !isExcluded(rel)) walk(full); }
      else if (e.isFile() && /\.(tsx|jsx)$/i.test(e.name) && !EXCLUDED_FILE_RE.test(rel) && !isExcluded(rel)) files.push(rel);
    }
  })(root);
  return { files, violations: files.flatMap((rel) => scanTsxColors(fs.readFileSync(path.join(root, rel), "utf8"), rel)) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { files, violations } = checkTsxColors(process.argv[2] || process.env.TARGET_DIR || ".");
    for (const v of violations) console.log(`${v.file}:${v.line}:${v.column} [nuage-ui/no-raw-color] ${v.message}`);
    if (violations.length > 0) process.exit(2);
    console.log(`✅ TSX/JSX color check passed (${files.length} files).`);
  } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }
}
