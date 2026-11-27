/**
 * TSX / JSX の style={{ ... }} およびクラス構築文字列内の Tailwind 任意値生カラーチェッカ
 * 例外は行末または単独直前行コメント「nuage-ui-ignore-color」でオプトアウトする。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const IGNORE_RE = /(?<![A-Za-z0-9_-])nuage-ui-ignore-color(?![A-Za-z0-9_-])/;
export const EXCLUDED_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "out", "coverage", "e2e", "mocks", "public",
  ".git", ".storybook", ".nuage-workspace-policies", "tests", "__tests__", "__mocks__",
  "playwright-report", "test-results", "storybook-static",
]);
export const EXCLUDED_FILE_RE = /\.(?:test|spec|stories|config)\.[^/]+$|\.d\.ts$/i;
const RAW_COLOR_RE = /(?:^|[^a-zA-Z0-9_-])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?)\s*\()/gi;
const URL_HASH_RE = /url\s*\(\s*["']?#[^)]*\)/gi;
const TW_COLOR_RE = /(?:^|[\s"'`:!])((?:bg|text|border(?:-[trblxyse])?|fill|stroke|from|via|to|ring(?:-offset)?|outline|decoration|accent|caret|shadow|divide|placeholder|stop)-\[(?:color:)?(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})|(?:rgba?|hsla?)\([^\]\n]*\))\])/gi;
const JSX_PRE_IDENT = new Set(["return", "default", "await", "yield", "throw", "case", "else", "typeof", "void", "delete", "in", "of"]);
const STMT_KW = new Set(["const", "let", "var", "return", "default", "export", "function", "if", "else", "for", "while", "switch", "case", "throw", "try", "catch", "finally", "type", "interface"]);
const CLASS_HELPERS = new Set(["cn", "clsx", "cx", "twMerge", "twJoin", "cva"]);
const CLASS_IDENT_RE = /(?:^|[-_])class(?:Name|es|List)?$|[a-z0-9]Class(?:Name|es|List)?$/;
export const toPosix = (p) => p.split(path.sep).join("/");
export const parseList = (raw) => (raw ? raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : []);

export function scanTsxColors(src, file) {
  const lineStarts = [0];
  for (let k = 0; k < src.length; k += 1) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (pos) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const loc = (pos) => { const line = lineOf(pos); return { pos, line, column: pos - lineStarts[line - 1] + 1 }; };
  const codeLines = new Set(), commentIgnoreLines = new Set(), trailingIgnore = new Map(), hits = [];
  const markCode = (a, b) => { for (let k = a; k < b; k += 1) if (!/\s/.test(src[k])) codeLines.add(lineOf(k)); };
  const recordComment = (a, b) => {
    const nl = src.indexOf("\n", b), after = src.slice(b, nl === -1 ? src.length : nl);
    const isTrailing = /^\s*(?:\}\s*)*$/.test(after);
    for (let pos = a; pos < b;) {
      const eol = src.indexOf("\n", pos), end = eol === -1 || eol > b ? b : eol;
      if (IGNORE_RE.test(src.slice(pos, end))) {
        const l = lineOf(pos);
        commentIgnoreLines.add(l);
        if (isTrailing && l === lineOf(b)) trailingIgnore.set(l, Math.min(trailingIgnore.get(l) ?? Infinity, a));
      }
      pos = end + 1;
    }
  };
  const scanStr = (a, b, inStyle, inClass) => {
    const text = src.slice(a, b);
    if (inClass) for (const m of text.matchAll(TW_COLOR_RE)) hits.push({ ...loc(a + m.index + (m[0].length - m[1].length)), message: `Unexpected Tailwind arbitrary color class "${m[1]}".` });
    if (inStyle) for (const m of text.replace(URL_HASH_RE, (s) => " ".repeat(s.length)).matchAll(RAW_COLOR_RE)) hits.push({ ...loc(a + m.index + (m[0].length - m[1].length)), message: `Unexpected raw color "${m[1].trim()}" in inline style.` });
  };
  const nextNonWs = (from) => {
    for (let k = from; k < src.length;) {
      if (/\s/.test(src[k])) { k += 1; continue; }
      if (src[k] === "/" && src[k + 1] === "/") { const nl = src.indexOf("\n", k + 2); k = nl === -1 ? src.length : nl + 1; continue; }
      if (src[k] === "/" && src[k + 1] === "*") { const c = src.indexOf("*/", k + 2); k = c === -1 ? src.length : c + 2; continue; }
      return src[k];
    }
    return "";
  };
  const stack = [{ type: "js", canRegex: true, canJsx: true }];
  const top = () => stack[stack.length - 1];
  const hasStyle = () => stack.some((f) => f.inStyle), hasClass = () => stack.some((f) => f.inClass || f.assignClass);
  const scanTpl = (start) => {
    for (let j = start, cs = j; j < src.length; j += 1) {
      if (src[j] === "\\") { j += 1; continue; }
      if (src[j] === "`") { scanStr(cs, j, hasStyle(), hasClass()); markCode(j, j + 1); return j + 1; }
      if (src[j] === "$" && src[j + 1] === "{") { scanStr(cs, j, hasStyle(), hasClass()); markCode(j, j + 2); stack.push({ type: "tpl" }, { type: "js", canRegex: true, canJsx: true }); return j + 2; }
    }
    scanStr(start, src.length, hasStyle(), hasClass());
    return src.length;
  };

  for (let i = 0; i < src.length;) {
    const ctx = top(), ch = src[i];
    if (ctx.type === "jsx-text") {
      if (ch === "{") {
        const jsxComment = /^\s*\/\*/.test(src.slice(i + 1));
        if (!jsxComment) markCode(i, i + 1);
        stack.push({ type: "js", canRegex: true, canJsx: true, jsxComment }); i += 1;
      } else if (ch === "<" && src[i + 1] === "/") {
        const c = src.indexOf(">", i + 2);
        markCode(i, c === -1 ? src.length : c + 1); stack.pop(); i = c === -1 ? src.length : c + 1;
      } else if (ch === "<" && (src[i + 1] === ">" || /[A-Za-z_$]/.test(src[i + 1] || ""))) {
        markCode(i, i + 1); stack.push({ type: "jsx-tag", tagHeader: true }); i += 1;
      } else { if (!/\s/.test(ch)) codeLines.add(lineOf(i)); i += 1; }
      continue;
    }
    if (/\s/.test(ch)) {
      ctx.tagHeader = false;
      if (ch === "\n" && ctx.type === "js" && ctx.assignClass && ctx.exprComplete && !".?:+&|,)]}".includes(nextNonWs(i + 1) || ";")) ctx.assignClass = false;
      i += 1; continue;
    }
    if (ch === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i + 2), end = nl === -1 ? src.length : nl; recordComment(i, end); i = end; continue; }
    if (ch === "/" && src[i + 1] === "*") { const c = src.indexOf("*/", i + 2), end = c === -1 ? src.length : c + 2; recordComment(i, end); i = end; continue; }
    if (ch === "\"" || ch === "'") {
      let j = i + 1; while (j < src.length && src[j] !== ch) j += src[j] === "\\" ? 2 : 1;
      markCode(i, Math.min(j + 1, src.length));
      scanStr(i + 1, j, hasStyle(), hasClass() || Boolean(ctx.pendingClass));
      ctx.pendingClass = ctx.pendingStyle = ctx.expectStyle = ctx.pendingCallClass = ctx.canRegex = ctx.canJsx = false;
      ctx.exprComplete = true; i = Math.min(j + 1, src.length); continue;
    }
    if (ch === "`") {
      markCode(i, i + 1);
      ctx.pendingClass = ctx.pendingStyle = ctx.expectStyle = ctx.pendingCallClass = ctx.canRegex = ctx.canJsx = false;
      i = scanTpl(i + 1); top().exprComplete = true; continue;
    }
    if (ctx.type === "jsx-tag") {
      if (ctx.tagHeader && ch === "<") {
        let j = i + 1, d = 1;
        while (j < src.length && d > 0) {
          if (src[j] === "\"" || src[j] === "'") { const q = src[j++]; while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1; j += 1; }
          else if (src[j] === "/" && src[j + 1] === "/") { const nl = src.indexOf("\n", j + 2); j = nl === -1 ? src.length : nl + 1; }
          else if (src[j] === "/" && src[j + 1] === "*") { const c = src.indexOf("*/", j + 2); j = c === -1 ? src.length : c + 2; }
          else if (src[j] === "=" && src[j + 1] === ">") { j += 2; }
          else { if (src[j] === "<") d += 1; else if (src[j] === ">") d -= 1; j += 1; }
        }
        markCode(i, j); ctx.tagHeader = false; i = j; continue;
      }
      if (ctx.tagHeader && /[A-Za-z0-9_$.]/.test(ch)) { markCode(i, i + 1); i += 1; continue; }
      ctx.tagHeader = false;
      if (ch === "/" && src[i + 1] === ">") { markCode(i, i + 2); stack.pop(); if (top().type === "js") top().exprComplete = true; i += 2; }
      else if (ch === ">") { markCode(i, i + 1); ctx.type = "jsx-text"; i += 1; }
      else if (ch === "{") { markCode(i, i + 1); stack.push({ type: "js", inClass: Boolean(ctx.pendingClass), expectStyle: Boolean(ctx.pendingStyle), canRegex: true, canJsx: true }); ctx.pendingStyle = ctx.pendingClass = false; i += 1; }
      else if (/[A-Za-z_$-]/.test(ch)) {
        const m = /^[A-Za-z0-9_$-]+/.exec(src.slice(i))[0];
        markCode(i, i + m.length);
        const eq = /^\s*=/.test(src.slice(i + m.length));
        ctx.pendingStyle = eq && m === "style" && /^\s*=\s*\{/.test(src.slice(i + m.length));
        ctx.pendingClass = eq && CLASS_IDENT_RE.test(m);
        i += m.length;
      } else { if (ch !== "=") ctx.pendingStyle = ctx.pendingClass = false; markCode(i, i + 1); i += 1; }
      continue;
    }
    if (ch === "/" && ctx.canRegex) {
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== "\n") { if (src[j] === "\\") { j += 2; continue; } if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; else if (src[j] === "/" && !cls) { j += 1; break; } j += 1; }
      markCode(i, j); ctx.canRegex = ctx.canJsx = ctx.expectStyle = ctx.pendingCallClass = false; ctx.exprComplete = true; i = j; continue;
    }
    if (ch === "(" || ch === "[") {
      markCode(i, i + 1);
      stack.push({ type: "js", delim: ch === "(" ? ")" : "]", inClass: ch === "(" ? Boolean(ctx.pendingCallClass) : Boolean(ctx.assignClass), canRegex: true, canJsx: true });
      ctx.pendingCallClass = ctx.expectStyle = ctx.exprComplete = false; i += 1; continue;
    }
    if (ch === ")" || ch === "]") { markCode(i, i + 1); if (ctx.delim === ch && stack.length > 1) stack.pop(); top().canRegex = top().canJsx = false; top().exprComplete = true; i += 1; continue; }
    if (ch === "{") { markCode(i, i + 1); stack.push({ type: "js", inStyle: Boolean(ctx.expectStyle), inClass: Boolean(ctx.assignClass), canRegex: true, canJsx: true }); ctx.expectStyle = ctx.pendingCallClass = ctx.exprComplete = false; i += 1; continue; }
    if (ch === "}") {
      if (!(ctx.jsxComment && src.slice(0, i).trimEnd().endsWith("*/"))) markCode(i, i + 1);
      if (stack.length > 1) stack.pop();
      if (top().type === "tpl") { stack.pop(); i = scanTpl(i + 1); top().exprComplete = true; continue; }
      if (top().type === "js") { top().canRegex = top().canJsx = false; top().exprComplete = true; }
      i += 1; continue;
    }
    if (ch === "<" && ctx.canJsx && (src[i + 1] === ">" || (/^[A-Za-z_$]/.test(src[i + 1] || "") && !/^[A-Za-z_$][\w$]*\s*(?:,|extends\b)/.test(src.slice(i + 1, i + 40))))) {
      markCode(i, i + 1); stack.push({ type: "jsx-tag", tagHeader: true }); ctx.canRegex = ctx.canJsx = ctx.expectStyle = ctx.pendingCallClass = ctx.exprComplete = false; i += 1; continue;
    }
    if (ch === "=" && src[i + 1] === ">") { markCode(i, i + 2); ctx.canRegex = ctx.canJsx = true; ctx.expectStyle = ctx.pendingCallClass = ctx.exprComplete = false; i += 2; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      const ident = /^[A-Za-z0-9_$]+/.exec(src.slice(i))[0], rest = src.slice(i + ident.length);
      markCode(i, i + ident.length);
      if (STMT_KW.has(ident)) ctx.assignClass = false;
      ctx.pendingCallClass = CLASS_HELPERS.has(ident) && /^\s*\(/.test(rest);
      if (CLASS_IDENT_RE.test(ident) && /^\s*(?:=(?!=)|:(?!:))/.test(rest)) ctx.assignClass = true;
      ctx.canRegex = ctx.canJsx = JSX_PRE_IDENT.has(ident); ctx.exprComplete = !ctx.canJsx; ctx.expectStyle = false; i += ident.length; continue;
    }
    if (/[0-9]/.test(ch)) { const n = /^[0-9a-zA-ZxXoObBn._]+/.exec(src.slice(i))[0]; markCode(i, i + n.length); ctx.canRegex = ctx.canJsx = ctx.expectStyle = ctx.pendingCallClass = false; ctx.exprComplete = true; i += n.length; continue; }
    markCode(i, i + 1);
    if (ch === ";" || ch === ",") ctx.assignClass = false;
    ctx.canRegex = ctx.canJsx = "([{:;,=?&|!+-*%^~".includes(ch); ctx.expectStyle = ctx.pendingCallClass = ctx.exprComplete = false; i += 1;
  }
  return hits.filter((h) => !(h.pos < (trailingIgnore.get(h.line) ?? -1)) && !(commentIgnoreLines.has(h.line - 1) && !codeLines.has(h.line - 1))).map(({ pos: _, ...rest }) => ({ file, ...rest }));
}

export function collectUiFiles(root, excludes = []) {
  const normDot = (s) => s.replace(/(^|\/)\.(?!\.?(?:\/|$))/g, "$1_dot_");
  const pats = excludes.map((raw) => ({ p: toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, ""), glob: /[*?]/.test(raw) }));
  const isExcluded = (rel) => pats.some(({ p, glob }) => {
    if (!glob) return rel === p || rel.startsWith(`${p}/`);
    const m = (s, pat) => path.matchesGlob(s, pat) || path.matchesGlob(normDot(s), normDot(pat));
    return m(rel, p) || (!p.includes("/") && m(path.posix.basename(rel), p));
  });
  const cssFiles = [], tsxFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name), rel = toPosix(path.relative(root, full));
      if (e.isDirectory()) { if (!EXCLUDED_DIRS.has(e.name) && !isExcluded(rel)) walk(full); }
      else if (e.isFile() && !EXCLUDED_FILE_RE.test(rel) && !isExcluded(rel)) {
        const ext = path.extname(e.name).toLowerCase();
        if (ext === ".css") cssFiles.push(full);
        else if (ext === ".tsx" || ext === ".jsx") tsxFiles.push(full);
      }
    }
  })(root);
  return { cssFiles, tsxFiles };
}

export function checkTsxColors(targetDir = ".", excludes = parseList(process.env.EXCLUDE)) {
  const root = path.resolve(targetDir);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Target directory '${targetDir}' is not a directory.`);
  const { tsxFiles } = collectUiFiles(root, excludes);
  const files = tsxFiles.map((f) => toPosix(path.relative(root, f)));
  return { files, violations: tsxFiles.flatMap((f, idx) => scanTsxColors(fs.readFileSync(f, "utf8"), files[idx])) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { files, violations } = checkTsxColors(process.argv[2] || process.env.TARGET_DIR || ".");
    for (const v of violations) console.log(`${v.file}:${v.line}:${v.column} [nuage-ui/no-raw-color] ${v.message}`);
    if (violations.length > 0) process.exit(2);
    console.log(`✅ TSX/JSX color check passed (${files.length} files).`);
  } catch (err) { console.error(`❌ ${err.message}`); process.exit(1); }
}
