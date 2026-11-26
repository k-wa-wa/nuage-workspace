#!/usr/bin/env node
/**
 * Nuage UI 設計標準の共通 lint エントリポイント
 *
 * 【検証する 3 つのルールと背景】
 * 1. 生カラー直書き禁止（color-no-hex / function-disallowed-list / nuage-ui/no-raw-color）:
 *    ダークテーマ専用設計を一貫して保つため、エントリ CSS の :root / @theme 外での
 *    #hex / rgb() / rgba() / hsl() / hsla() 直書きを禁止する（rgba(var(...), ...) 等は許可。
 *    例外は nuage-ui-ignore-color または stylelint-disable-next-line）。
 * 2. :hover の @media (hover: hover) ラップ必須（defensive-css/no-accidental-hover）:
 *    タッチデバイスでの :hover 残留を防ぐため、:hover セレクタを @media (hover: hover) 内に限定する
 *    （例外は nuage-ui-ignore-hover または stylelint-disable-next-line）。
 * 3. エントリ CSS の必須トークン・モバイル/アクセシビリティガードレール（nuage-ui/entry-css-guardrails）:
 *    必須 21 トークン、-webkit-tap-highlight-color: transparent、:focus:not(:focus-visible) 抑止 +
 *    :focus-visible 定義、user-select: none + touch-action: manipulation、およびモバイル幅での
 *    input / textarea / select に対する font-size >= 16px（iOS Safari 自動ズーム防止）を検証する。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  isMediaCondition,
  isMediaConditionListWithAnd,
  isMediaConditionListWithOr,
  isMediaFeature,
  isMediaFeaturePlain,
  isMediaFeatureRange,
  isMediaInParens,
  isMediaNot,
  isMediaQueryInvalid,
  isMediaQueryWithType,
  isMediaQueryWithoutType,
  parse as parseMediaQueryList,
} from "@csstools/media-query-list-parser";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import stylelint from "stylelint";
import stylelintConfig from "./stylelint.config.mjs";
import {
  IGNORE_COLOR_TOKEN,
  IGNORE_HOVER_TOKEN,
  addCommentLines,
  analyzeScriptFile,
  collectCssCommentLines,
  hasIgnoreComment,
} from "./tsx-scanner.mjs";

const RULE_ENTRY_CSS_GUARDRAILS = "nuage-ui/entry-css-guardrails";

const REQUIRED_CSS_VARS = [
  "--bg", "--fg", "--card", "--line", "--muted",
  "--accent", "--warn", "--success", "--blocked",
  "--font-sans", "--font-mono",
  "--radius-sm", "--radius-md", "--radius-lg", "--radius-full",
  "--ease-spring", "--ease-snappy", "--duration-press", "--duration-release",
  "--scale-button-active", "--scale-icon-active",
];

const DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "out", "coverage",
  "e2e", "mocks", "public", ".git", ".storybook",
  "tests", "__tests__", "__mocks__", "playwright-report", "test-results", "storybook-static",
]);

const DEFAULT_EXCLUDED_FILE_REGEX = /\.(?:test|spec|stories|config)\.[^/]+$|\.d\.ts$/i;
const VALID_HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})$/;

const STYLELINT_IGNORE_TOKEN = {
  "color-no-hex": IGNORE_COLOR_TOKEN,
  "function-disallowed-list": IGNORE_COLOR_TOKEN,
  "defensive-css/no-accidental-hover": IGNORE_HOVER_TOKEN,
};

const TOKEN_COLOR_FN_ALIAS = {
  rgb: "vgb",
  rgba: "vgba",
  hsl: "vsl",
  hsla: "vsla",
};

const toPosix = (p) => p.split(path.sep).join("/");

const parseListValue = (raw) =>
  raw ? raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : [];

function normalizeExcludes(patterns) {
  return patterns.map((raw) => {
    const pattern = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    return { pattern, hasWildcard: /[*?]/.test(pattern) };
  });
}

function matchesGlobWithDots(targetPath, pattern) {
  if (path.matchesGlob(targetPath, pattern)) return true;
  // path.matchesGlob はドット始まりセグメントを * / ** でスキップするため、衝突しない動的プレフィックスで両辺を揃えて照合する
  let prefix = "__ndot_";
  while (targetPath.includes(prefix) || pattern.includes(prefix)) {
    prefix += "_";
  }
  const maskDots = (s) => s.replace(/(^|\/)\.(?!\.?(?:\/|$))/g, `$1${prefix}`);
  const maskedPath = maskDots(targetPath);
  const maskedPattern = maskDots(pattern);
  if (maskedPath === targetPath && maskedPattern === pattern) return false;
  return path.matchesGlob(maskedPath, maskedPattern);
}

function matchesUserExclude(relPath, excludes) {
  const baseName = path.posix.basename(relPath);
  return excludes.some(({ pattern, hasWildcard }) => {
    if (!hasWildcard) {
      return relPath === pattern || relPath.startsWith(`${pattern}/`);
    }
    return (
      matchesGlobWithDots(relPath, pattern) ||
      (!pattern.includes("/") && matchesGlobWithDots(baseName, pattern))
    );
  });
}

function collectTargetFiles(targetDir, rawExcludes) {
  const excludes = normalizeExcludes(rawExcludes);
  const cssFiles = [];
  const scriptFiles = [];

  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dirPath, entry.name);
      const relPath = toPosix(path.relative(targetDir, fullPath));

      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name) || matchesUserExclude(relPath, excludes)) {
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (DEFAULT_EXCLUDED_FILE_REGEX.test(relPath) || matchesUserExclude(relPath, excludes)) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".css") {
        cssFiles.push(fullPath);
      } else if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
        scriptFiles.push(fullPath);
      }
    }
  }

  walk(targetDir);
  return { cssFiles, scriptFiles };
}

function resolveEntryCssPath(targetDir, rawEntryCss) {
  if (!rawEntryCss) return null;
  const candidates = path.isAbsolute(rawEntryCss)
    ? [rawEntryCss]
    : [path.resolve(targetDir, rawEntryCss), path.resolve(process.cwd(), rawEntryCss)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.realpathSync(candidate);
    }
  }
  return { missing: rawEntryCss };
}

function isDirectInsideRootOrTheme(decl) {
  // :root 内の @media / @supports 等のアトルールは通過し、直近の囲みルールが :root（または @theme）かを見る
  let cur = decl.parent;
  while (cur) {
    if (cur.type === "atrule") {
      if (cur.name.toLowerCase() === "theme") return true;
      cur = cur.parent;
      continue;
    }
    if (cur.type === "rule") {
      if (!cur.selector.split(",").some((s) => s.trim() === ":root")) {
        return false;
      }
      for (let anc = cur.parent; anc; anc = anc.parent) {
        if (anc.type === "rule") return false;
      }
      return true;
    }
    return false;
  }
  return false;
}

function transformDeclValueForStylelint(rawVal) {
  const edits = [];
  valueParser(rawVal).walk((node) => {
    if (node.type === "comment") {
      const commentText = rawVal.slice(node.sourceIndex, node.sourceEndIndex);
      if (!/stylelint-(?:disable|enable)/i.test(commentText)) {
        edits.push({
          start: node.sourceIndex,
          end: node.sourceEndIndex,
          text: commentText.replace(/[^\n]/g, " "),
        });
      }
      return;
    }
    if (node.type !== "function") return;
    const fn = node.value.toLowerCase();
    if (fn === "url") {
      edits.push({
        start: node.sourceIndex,
        end: node.sourceEndIndex,
        text: rawVal.slice(node.sourceIndex, node.sourceEndIndex).replace(/[^\n]/g, " "),
      });
      return false;
    }
    if (fn in TOKEN_COLOR_FN_ALIAS) {
      const firstArg = node.nodes.find((n) => n.type !== "space" && n.type !== "comment");
      if (firstArg && firstArg.type === "function" && firstArg.value.toLowerCase() === "var") {
        edits.push({
          start: node.sourceIndex,
          end: node.sourceIndex + node.value.length,
          text: TOKEN_COLOR_FN_ALIAS[fn],
        });
      }
    }
  });

  if (edits.length === 0) return rawVal;
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += rawVal.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + rawVal.slice(cursor);
}

function mediaNodeGuaranteesHoverHover(node) {
  if (!node) return false;
  if (isMediaCondition(node) || isMediaInParens(node)) {
    return mediaNodeGuaranteesHoverHover(node.media);
  }
  if (isMediaConditionListWithAnd(node)) {
    return [node.leading, ...(node.list ?? []).map((item) => item.media)].some(mediaNodeGuaranteesHoverHover);
  }
  if (isMediaConditionListWithOr(node)) {
    return [node.leading, ...(node.list ?? []).map((item) => item.media)].every(mediaNodeGuaranteesHoverHover);
  }
  if (isMediaNot(node)) {
    return false;
  }
  if (isMediaFeature(node) && isMediaFeaturePlain(node.feature)) {
    const name = node.feature.name.getName().toLowerCase();
    const val = node.feature.value.toString().replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
    return name === "hover" && val === "hover";
  }
  return false;
}

function isStrictHoverHoverMediaQuery(params) {
  try {
    const queries = parseMediaQueryList(params);
    if (queries.length === 0) return false;
    return queries.every((q) => {
      if (isMediaQueryInvalid(q)) return false;
      if (isMediaQueryWithType(q)) {
        const isNegated = (q.modifier ?? []).some((t) => t[4]?.value?.toLowerCase() === "not");
        return !isNegated && mediaNodeGuaranteesHoverHover(q.media);
      }
      if (isMediaQueryWithoutType(q)) {
        return mediaNodeGuaranteesHoverHover(q.media);
      }
      return false;
    });
  } catch {
    return false;
  }
}

function maskMediaHoverParams(params) {
  if (isStrictHoverHoverMediaQuery(params)) {
    return params.replace(/\(\s*hover\s*:\s*hover\s*\)/gi, (m) => m.toLowerCase());
  }
  return params.replace(/hover/gi, (word) => `${word[0]}0${word.slice(2)}`);
}

function containsHoverPseudo(container) {
  for (const node of container.nodes ?? []) {
    if (node.type === "pseudo" && node.value.toLowerCase() === ":hover") return true;
    if (node.nodes && containsHoverPseudo(node)) return true;
  }
  return false;
}

function maskNonPseudoHoverTokens(node) {
  if (node.raws?.value && /hover/i.test(node.raws.value)) {
    node.raws.value = node.raws.value.replace(/:hover/gi, (m) => `${m[0]}h0ver`);
  } else if (node.value && /hover/i.test(node.value)) {
    node.value = node.value.replace(/:hover/gi, (m) => `${m[0]}h0ver`);
  }
}

function normalizeHoverSelector(selector) {
  if (!/hover/i.test(selector)) return { selector, hasHoverPseudo: false };
  try {
    const ast = selectorParser().astSync(selector);
    let hasHoverPseudo = false;

    function walkSel(container) {
      for (const node of container.nodes ?? []) {
        if (node.type === "attribute" || node.type === "class" || node.type === "id") {
          maskNonPseudoHoverTokens(node);
          continue;
        }
        if (node.type === "pseudo" && node.value.toLowerCase() === ":hover") {
          node.value = ":hover";
          hasHoverPseudo = true;
        }
        if (node.nodes) walkSel(node);
      }
    }
    walkSel(ast);

    if (!hasHoverPseudo) {
      return { selector: selector.replace(/:hover/gi, (m) => `${m[0]}h0ver`), hasHoverPseudo: false };
    }

    // defensive-css/no-accidental-hover が /:not\(([^)]*:hover[^)]*)\)/ でルール全体をスキップするのを防ぐ
    if (/:not\([^)]*:hover/i.test(ast.toString())) {
      function maskNotWithHover(container) {
        for (const node of container.nodes ?? []) {
          if (node.type === "pseudo" && node.value.toLowerCase() === ":not" && containsHoverPseudo(node)) {
            node.value = ":n0t";
          }
          if (node.nodes) maskNotWithHover(node);
        }
      }
      maskNotWithHover(ast);
    }

    return { selector: ast.toString(), hasHoverPseudo };
  } catch {
    const replaced = selector.replace(/:hover(?![a-zA-Z0-9_-])/gi, ":hover");
    return { selector: replaced, hasHoverPseudo: /:hover(?![a-zA-Z0-9_-])/.test(replaced) };
  }
}

function preprocessCss(css, { isEntryCss }) {
  const cssCommentLines = collectCssCommentLines(css);
  let root;
  try {
    root = postcss.parse(css);
  } catch (err) {
    if (err?.name === "CssSyntaxError") {
      return {
        processedCss: css,
        guardrailRoot: null,
        cssCommentLines,
        ignoredHoverRuleLines: new Set(),
      };
    }
    throw err;
  }

  const guardrailRoot = isEntryCss ? root.clone() : null;
  const ignoredHoverRuleLines = new Set();

  root.walkDecls((decl) => {
    const rawVal = decl.raws.value?.raw ?? decl.value;
    if (isEntryCss && isDirectInsideRootOrTheme(decl)) {
      const newlines = "\n".repeat((rawVal.match(/\n/g) || []).length);
      decl.value = `var(--nuage-masked)${newlines}`;
      decl.raws.value = undefined;
      return;
    }
    const transformed = transformDeclValueForStylelint(rawVal);
    if (transformed !== rawVal) {
      decl.value = transformed;
      decl.raws.value = undefined;
    }
  });

  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() === "media") {
      atRule.name = "media";
      atRule.params = maskMediaHoverParams(atRule.params);
    }
  });

  root.walkRules((rule) => {
    const { selector: normalizedSelector, hasHoverPseudo } = normalizeHoverSelector(rule.selector);
    if (normalizedSelector !== rule.selector) {
      rule.selector = normalizedSelector;
    }
    if (!hasHoverPseudo) return;

    const startLine = rule.source?.start?.line ?? 1;
    const selectorLines = rule.selector.split("\n").length;
    let ignored = false;
    for (let offset = 0; offset < selectorLines; offset += 1) {
      if (hasIgnoreComment(cssCommentLines, startLine + offset, IGNORE_HOVER_TOKEN)) {
        ignored = true;
        break;
      }
    }
    if (!ignored && Array.isArray(rule.nodes)) {
      for (const child of rule.nodes) {
        if (child.type === "comment" && child.text.includes(IGNORE_HOVER_TOKEN)) {
          ignored = true;
          break;
        }
      }
    }
    if (ignored) {
      ignoredHoverRuleLines.add(startLine);
    }
  });

  return {
    processedCss: root.toString(),
    guardrailRoot,
    cssCommentLines,
    ignoredHoverRuleLines,
  };
}

function parseFontSizePx(value) {
  const cleaned = value.replace(/!important/gi, "").trim().toLowerCase();
  const single = /^([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)$/.exec(cleaned);
  if (single) {
    const num = Number.parseFloat(single[1]);
    return single[2] === "px" ? num : num * 16;
  }
  const maxMatch = /^max\((.+)\)$/.exec(cleaned);
  if (!maxMatch) return null;
  const valid = maxMatch[1].split(",").map(parseFontSizePx).filter((n) => n !== null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

function isMobilePxThreshold(numStr, unit) {
  const px = Number.parseFloat(numStr) * (unit.toLowerCase() === "px" ? 1 : 16);
  return px >= 480 && px <= 1024;
}

function mediaNodeMatchesMobileWidth(node) {
  if (!node) return false;
  if (isMediaCondition(node) || isMediaInParens(node)) {
    return mediaNodeMatchesMobileWidth(node.media);
  }
  if (isMediaConditionListWithAnd(node) || isMediaConditionListWithOr(node)) {
    return [node.leading, ...(node.list ?? []).map((item) => item.media)].some(mediaNodeMatchesMobileWidth);
  }
  if (isMediaNot(node)) {
    return false;
  }
  if (isMediaFeature(node)) {
    if (isMediaFeaturePlain(node.feature)) {
      const name = node.feature.name.getName().toLowerCase();
      const val = node.feature.value.toString().replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
      const m = /^([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)$/.exec(val);
      return name === "max-width" && Boolean(m && isMobilePxThreshold(m[1], m[2]));
    }
    if (isMediaFeatureRange(node.feature)) {
      const text = node.feature.toString().replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
      const m =
        /\bwidth\s*<=\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\b/.exec(text) ||
        /\b([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\s*>=\s*width\b/.exec(text);
      return Boolean(m && isMobilePxThreshold(m[1], m[2]));
    }
  }
  return false;
}

function isMobileWidthMediaQuery(params) {
  try {
    const queries = parseMediaQueryList(params);
    return queries.some((q) => {
      if (isMediaQueryInvalid(q)) return false;
      if (isMediaQueryWithType(q)) {
        const isNegated = (q.modifier ?? []).some((t) => t[4]?.value?.toLowerCase() === "not");
        return !isNegated && mediaNodeMatchesMobileWidth(q.media);
      }
      if (isMediaQueryWithoutType(q)) {
        return mediaNodeMatchesMobileWidth(q.media);
      }
      return false;
    });
  } catch {
    return false;
  }
}

function isZeroLengthToken(token) {
  return /^[-+]?(?:0+(?:\.0+)?|\.[0]+)(?:px|rem|em|pt|vh|vw|%)?$/i.test(token);
}

function isTransparentColorToken(token) {
  const t = token.trim().toLowerCase();
  if (t === "transparent") return true;
  if (/^#0{4}(?:0{4})?$/.test(t)) return true;
  const rgbaMatch = /^(?:rgba|hsla)\s*\((.+)\)$/.exec(t);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(/[,/]/).map((s) => s.trim());
    const alpha = parts[parts.length - 1];
    if (alpha && /^(?:0+(?:\.0+)?|0+%)$/.test(alpha)) return true;
  }
  return false;
}

function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(str.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(str.slice(start).trim());
  return parts.filter(Boolean);
}

function tokenizeTopLevelSpaces(str) {
  const tokens = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === "(") {
      if (start === -1) start = i;
      depth += 1;
    } else if (ch === ")") {
      if (depth > 0) depth -= 1;
    } else if (/\s/.test(ch) && depth === 0) {
      if (start !== -1) {
        tokens.push(str.slice(start, i));
        start = -1;
      }
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) tokens.push(str.slice(start));
  return tokens;
}

function isVisibleBoxShadow(shadowVal) {
  const v = shadowVal.trim().toLowerCase();
  if (!v || v === "none") return false;
  if (/^var\([^)]+\)$/.test(v)) return true;

  for (const layer of splitTopLevelCommas(v)) {
    if (layer === "none") continue;
    const tokens = tokenizeTopLevelSpaces(layer);
    const lengths = [];
    let hasOpaqueColorOrDefault = true;
    for (const tok of tokens) {
      if (tok === "inset") continue;
      if (/^[-+]?(?:\d|\.\d)/.test(tok) || /^(?:calc|min|max|clamp|var)\(/i.test(tok)) {
        lengths.push(tok);
      } else if (isTransparentColorToken(tok)) {
        hasOpaqueColorOrDefault = false;
      }
    }
    if (hasOpaqueColorOrDefault && lengths.some((len) => !isZeroLengthToken(len))) {
      return true;
    }
  }
  return false;
}

const OUTLINE_STYLES = new Set([
  "none", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset", "auto",
]);
const OUTLINE_WIDTH_KEYWORDS = new Set(["thin", "medium", "thick"]);

function parseOutlineShorthand(val) {
  const tokens = tokenizeTopLevelSpaces(val);
  let style = "none";
  let width = "medium";
  let color = "currentcolor";
  let hasVarToken = false;
  for (const tok of tokens) {
    if (OUTLINE_STYLES.has(tok)) {
      style = tok;
    } else if (OUTLINE_WIDTH_KEYWORDS.has(tok) || /^[-+]?(?:\d|\.\d)/.test(tok)) {
      width = tok;
    } else if (/^var\(/i.test(tok)) {
      hasVarToken = true;
      color = tok;
    } else {
      color = tok;
    }
  }
  // `outline: var(--focus-ring)` のように複合トークン全体を CSS 変数で与える場合は有効な outline とみなす
  if (hasVarToken && style === "none" && !tokens.includes("none") && !tokens.includes("hidden") && !tokens.some(isZeroLengthToken)) {
    style = "solid";
  }
  return { style, width, color };
}

function evaluateFocusRuleState(decls) {
  const state = {
    outlineStyle: null,
    outlineWidth: null,
    outlineColor: null,
    boxShadow: null,
  };
  const setProp = (key, val, important) => {
    const cur = state[key];
    if (!cur || important || !cur.important) {
      state[key] = { val, important };
    }
  };

  for (const d of decls) {
    const p = d.prop.toLowerCase();
    const important = Boolean(d.important);
    const v = d.value.replace(/!important/gi, "").trim().toLowerCase();
    if (!v) continue;

    if (p === "outline") {
      if (v === "none") {
        setProp("outlineStyle", "none", important);
        setProp("outlineWidth", "medium", important);
      } else if (isZeroLengthToken(v)) {
        setProp("outlineStyle", "none", important);
        setProp("outlineWidth", v, important);
      } else {
        const parsed = parseOutlineShorthand(v);
        setProp("outlineStyle", parsed.style, important);
        setProp("outlineWidth", parsed.width, important);
        setProp("outlineColor", parsed.color, important);
      }
    } else if (p === "outline-style") {
      setProp("outlineStyle", v, important);
    } else if (p === "outline-width") {
      setProp("outlineWidth", v, important);
    } else if (p === "outline-color") {
      setProp("outlineColor", v, important);
    } else if (p === "box-shadow") {
      setProp("boxShadow", v, important);
    }
  }

  const styleVal = state.outlineStyle?.val;
  const widthVal = state.outlineWidth?.val;
  const colorVal = state.outlineColor?.val;
  const shadowVal = state.boxShadow?.val;

  const isSuppressed =
    styleVal === "none" ||
    styleVal === "hidden" ||
    (widthVal !== undefined && isZeroLengthToken(widthVal));

  const hasVisibleOutline =
    Boolean(styleVal) &&
    styleVal !== "none" &&
    styleVal !== "hidden" &&
    (widthVal === undefined || !isZeroLengthToken(widthVal)) &&
    colorVal !== "transparent";

  const hasVisibleBoxShadow = Boolean(shadowVal) && isVisibleBoxShadow(shadowVal);

  return {
    isSuppressed,
    hasVisibleFocus: hasVisibleOutline || hasVisibleBoxShadow,
  };
}

function classifyFocusSelector(selector) {
  if (!/focus/i.test(selector)) {
    return { hasFocusNotVisible: false, hasFocusVisible: false };
  }
  try {
    const ast = selectorParser().astSync(selector);
    let hasFocusNotVisible = false;
    let hasFocusVisible = false;

    ast.each((sel) => {
      let hasFocus = false;
      let hasNotFocusVisible = false;
      let hasDirectFocusVisible = false;

      function walkBranch(container, insideNot) {
        for (const node of container.nodes ?? []) {
          if (node.type === "attribute") continue;
          if (node.type === "pseudo") {
            const pv = node.value.toLowerCase();
            if (pv === ":not") {
              if (
                (node.nodes ?? []).some((inner) =>
                  (inner.nodes ?? []).some(
                    (n) => n.type === "pseudo" && n.value.toLowerCase() === ":focus-visible",
                  ),
                )
              ) {
                hasNotFocusVisible = true;
              }
              walkBranch(node, true);
              continue;
            }
            if (!insideNot && pv === ":focus") hasFocus = true;
            if (!insideNot && pv === ":focus-visible") hasDirectFocusVisible = true;
          }
          if (node.nodes) walkBranch(node, insideNot);
        }
      }
      walkBranch(sel, false);

      if (hasFocus && hasNotFocusVisible) hasFocusNotVisible = true;
      if (hasDirectFocusVisible) hasFocusVisible = true;
    });

    return { hasFocusNotVisible, hasFocusVisible };
  } catch {
    return {
      hasFocusNotVisible: /:focus\s*:not\(\s*:focus-visible\s*\)/i.test(selector),
      hasFocusVisible: /:focus-visible\b/i.test(selector.replace(/:not\(\s*:focus-visible\s*\)/gi, "")),
    };
  }
}

function collectSubjectFormTags(selectorNode, results) {
  const nodes = selectorNode.nodes ?? [];
  let lastComb = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].type === "combinator") lastComb = i;
  }
  const subject = nodes.slice(lastComb + 1);
  if (subject.some((n) => n.type === "pseudo" && n.value.startsWith("::"))) {
    return;
  }
  const isQualified = subject.some(
    (n) => n.type === "class" || n.type === "id" || n.type === "attribute",
  );
  for (const n of subject) {
    if (n.type === "tag") {
      const tag = n.value.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        results.push({ tag, isQualified });
      }
    } else if (n.type === "pseudo" && (n.value === ":is" || n.value === ":where")) {
      for (const inner of n.nodes ?? []) {
        collectSubjectFormTags(inner, results);
      }
    }
  }
}

function updateCascadeFlag(map, selectorKey, ok, important) {
  const cur = map.get(selectorKey);
  if (!cur || important || !cur.important) {
    map.set(selectorKey, { ok, important });
  }
}

function checkEntryCssGuardrails(root, file) {
  const varStates = new Map();
  const tapHighlightStates = new Map();
  const userSelectStates = new Map();
  const touchActionStates = new Map();
  const flags = {
    focusSuppression: false,
    focusVisible: false,
  };
  const mobileFormStates = {
    input: { ok: false, important: false },
    textarea: { ok: false, important: false },
    select: { ok: false, important: false },
  };

  root.walkDecls((decl) => {
    const val = decl.value.replace(/!important/gi, "").trim().toLowerCase();
    if (decl.prop.startsWith("--") && isDirectInsideRootOrTheme(decl)) {
      const imp = Boolean(decl.important);
      const cur = varStates.get(decl.prop);
      if (!cur || imp || !cur.important) {
        varStates.set(decl.prop, { valid: val.length > 0, important: imp });
      }
    }
  });

  root.walkRules((rule) => {
    const decls = (rule.nodes ?? []).filter((n) => n.type === "decl");
    const selectorParts = rule.selector.split(",").map((s) => s.trim()).filter(Boolean);

    const applyPropCascade = (propName, isValidVal, stateMap) => {
      let winVal = null;
      let winImp = false;
      for (const d of decls) {
        if (d.prop.toLowerCase() !== propName) continue;
        const imp = Boolean(d.important);
        if (winVal === null || imp || !winImp) {
          winVal = d.value.replace(/!important/gi, "").trim().toLowerCase();
          winImp = imp;
        }
      }
      if (winVal !== null) {
        const ok = isValidVal(winVal);
        for (const selPart of selectorParts) {
          updateCascadeFlag(stateMap, selPart, ok, winImp);
        }
      }
    };

    applyPropCascade(
      "-webkit-tap-highlight-color",
      (v) => v === "transparent" || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(v),
      tapHighlightStates,
    );
    applyPropCascade("user-select", (v) => v === "none", userSelectStates);
    applyPropCascade("touch-action", (v) => v === "manipulation", touchActionStates);

    const focusState = evaluateFocusRuleState(decls);
    const { hasFocusNotVisible, hasFocusVisible } = classifyFocusSelector(rule.selector);
    if (hasFocusNotVisible && focusState.isSuppressed) {
      flags.focusSuppression = true;
    }
    if (hasFocusVisible && focusState.hasVisibleFocus) {
      flags.focusVisible = true;
    }
  });

  root.walkAtRules("media", (atRule) => {
    if (!isMobileWidthMediaQuery(atRule.params)) return;
    atRule.walkRules((rule) => {
      let winningFontSize = null;
      let winningImportant = false;
      for (const n of rule.nodes ?? []) {
        if (n.type !== "decl" || n.prop.toLowerCase() !== "font-size") continue;
        const imp = Boolean(n.important);
        if (!winningFontSize || imp || !winningImportant) {
          winningFontSize = n.value;
          winningImportant = imp;
        }
      }
      if (!winningFontSize) return;
      const px = parseFontSizePx(winningFontSize);
      if (px === null) return;

      try {
        const ast = selectorParser().astSync(rule.selector);
        const matched = [];
        ast.each((sel) => collectSubjectFormTags(sel, matched));
        const ok = px >= 16;
        for (const { tag, isQualified } of matched) {
          if (!ok && isQualified) continue;
          const cur = mobileFormStates[tag];
          if (winningImportant || !cur.important) {
            mobileFormStates[tag] = { ok, important: winningImportant };
          }
        }
      } catch {
        // 構文異常セレクタは無視
      }
    });
  });

  const definedVars = new Set(
    [...varStates.entries()].filter(([, info]) => info.valid).map(([name]) => name),
  );
  const hasAnyOk = (stateMap) => [...stateMap.values()].some((s) => s.ok);

  const messages = [];
  const missingVars = REQUIRED_CSS_VARS.filter((v) => !definedVars.has(v));
  if (missingVars.length > 0) {
    messages.push(`エントリ CSS に必須 CSS 変数が不足している: ${missingVars.join(", ")}`);
  }

  const requiredChecks = [
    [hasAnyOk(tapHighlightStates), "エントリ CSS に '-webkit-tap-highlight-color: transparent' が定義されていない。"],
    [flags.focusSuppression, "エントリ CSS に ':focus:not(:focus-visible)' でのアウトライン抑止（outline: none / 0）が定義されていない。"],
    [flags.focusVisible, "エントリ CSS に ':focus-visible' のフォーカス表示定義が不足している。"],
    [hasAnyOk(userSelectStates), "エントリ CSS に 'user-select: none' が定義されていない。"],
    [hasAnyOk(touchActionStates), "エントリ CSS に 'touch-action: manipulation' が定義されていない。"],
  ];
  for (const [passed, msg] of requiredChecks) {
    if (!passed) messages.push(msg);
  }

  const missingMobile = ["input", "textarea", "select"].filter((tag) => !mobileFormStates[tag].ok);
  if (missingMobile.length > 0) {
    messages.push(
      `エントリ CSS のモバイル幅メディアクエリ（例: @media (max-width: 768px)）内に ${missingMobile.join(", ")} の 'font-size: 16px' 以上が定義されていない（iOS Safari 自動ズーム防止）。`,
    );
  }

  return messages.map((message) => ({
    file,
    line: 1,
    column: 1,
    rule: RULE_ENTRY_CSS_GUARDRAILS,
    message,
  }));
}

function mergeCommentLines(baseMap, cssMap, lineOffset) {
  if (lineOffset === 0 && baseMap.size === 0) return cssMap;
  const merged = new Map(baseMap);
  for (const [ln, text] of cssMap.entries()) {
    addCommentLines(merged, lineOffset + ln, text);
  }
  return merged;
}

async function lintCssWithStylelint({
  css,
  relFile,
  isEntryCss = false,
  scriptCommentLines = new Map(),
  lineOffset = 0,
}) {
  const { processedCss, guardrailRoot, cssCommentLines, ignoredHoverRuleLines } =
    preprocessCss(css, { isEntryCss });

  const violations = [];
  if (guardrailRoot) {
    violations.push(...checkEntryCssGuardrails(guardrailRoot, relFile));
  }

  // 呼び出し元リポジトリの .stylelintignore に影響されないよう、ファイルパスではなく code として渡す
  const result = await stylelint.lint({
    code: processedCss,
    config: stylelintConfig,
  });

  const commentLines = mergeCommentLines(scriptCommentLines, cssCommentLines, lineOffset);

  for (const res of result.results) {
    for (const warn of res.warnings) {
      if (warn.rule === "color-no-hex") {
        const m = /^Unexpected hex color "([^"]+)"/.exec(warn.text);
        if (m && !VALID_HEX_COLOR_REGEX.test(m[1])) {
          continue;
        }
      }
      const localLine = warn.line ?? 1;
      const mappedLine = lineOffset + localLine;
      if (warn.rule === "defensive-css/no-accidental-hover" && ignoredHoverRuleLines.has(localLine)) {
        continue;
      }
      const ignoreToken = STYLELINT_IGNORE_TOKEN[warn.rule];
      if (ignoreToken && hasIgnoreComment(commentLines, mappedLine, ignoreToken)) {
        continue;
      }
      let message = warn.text.replace(/\s*\([^)]+\)\s*$/, "");
      if (warn.rule === "defensive-css/no-accidental-hover") {
        message = message.replace(/:n0t\(/g, ":not(").replace(/:h0ver/g, ":hover");
      }
      violations.push({
        file: relFile,
        line: mappedLine,
        column: warn.column ?? 1,
        rule: warn.rule,
        message,
      });
    }
  }
  return violations;
}

/**
 * 指定ディレクトリに対して UI 設計標準 lint を実行し、結果オブジェクトを返す。
 *
 * @param {{ targetDir: string, entryCss?: string, excludes?: string[] }} params
 */
export async function runUiLint({ targetDir, entryCss = "", excludes = [] }) {
  const resolvedTargetDir = fs.realpathSync(path.resolve(targetDir));
  const resolvedEntry = resolveEntryCssPath(resolvedTargetDir, entryCss);
  if (resolvedEntry && typeof resolvedEntry === "object" && resolvedEntry.missing) {
    throw new Error(`Entry CSS file '${resolvedEntry.missing}' does not exist.`);
  }
  const entryCssPath = resolvedEntry;

  const { cssFiles, scriptFiles } = collectTargetFiles(resolvedTargetDir, excludes);
  const realCssFiles = cssFiles.map((f) => fs.realpathSync(f));
  const nonEntryCssFiles = entryCssPath
    ? realCssFiles.filter((f) => f !== entryCssPath)
    : realCssFiles;

  const violations = [];
  const checkedSet = new Set([...realCssFiles, ...scriptFiles]);
  if (entryCssPath) checkedSet.add(entryCssPath);

  const toRel = (absPath) =>
    toPosix(path.relative(resolvedTargetDir, absPath)) || path.basename(absPath);

  if (entryCssPath) {
    const entryCode = fs.readFileSync(entryCssPath, "utf8");
    violations.push(
      ...(await lintCssWithStylelint({
        css: entryCode,
        relFile: toRel(entryCssPath),
        isEntryCss: true,
      })),
    );
  }

  for (const cssPath of nonEntryCssFiles) {
    const cssCode = fs.readFileSync(cssPath, "utf8");
    violations.push(
      ...(await lintCssWithStylelint({
        css: cssCode,
        relFile: toRel(cssPath),
      })),
    );
  }

  for (const scriptPath of scriptFiles) {
    const content = fs.readFileSync(scriptPath, "utf8");
    const rel = toRel(scriptPath);
    const { commentLines, styleBlocks, colorViolations } = analyzeScriptFile(scriptPath, content);
    for (const v of colorViolations) {
      violations.push({ file: rel, ...v });
    }
    for (const block of styleBlocks) {
      violations.push(
        ...(await lintCssWithStylelint({
          css: block.css,
          relFile: rel,
          scriptCommentLines: commentLines,
          lineOffset: block.startLine - 1,
        })),
      );
    }
  }

  violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.rule.localeCompare(b.rule),
  );

  return {
    targetDir: resolvedTargetDir,
    entryCssPath,
    checkedFilesCount: checkedSet.size,
    violations,
  };
}

function parseArgs(argv) {
  const opts = {
    targetDir: process.env.TARGET_DIR || "",
    entryCss: process.env.ENTRY_CSS || "",
    excludes: parseListValue(process.env.EXCLUDE || ""),
    failOnPolicy: process.env.FAIL_ON_POLICY || "true",
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readVal = (flag) => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      if (i + 1 >= argv.length) throw new Error(`${flag} requires a value.`);
      i += 1;
      return argv[i];
    };

    if (arg === "--target-dir" || arg.startsWith("--target-dir=")) {
      opts.targetDir = readVal("--target-dir");
    } else if (arg === "--entry-css" || arg.startsWith("--entry-css=")) {
      opts.entryCss = readVal("--entry-css");
    } else if (arg === "--exclude" || arg.startsWith("--exclude=")) {
      opts.excludes.push(...parseListValue(readVal("--exclude")));
    } else if (arg === "--fail-on-policy" || arg.startsWith("--fail-on-policy=")) {
      opts.failOnPolicy = readVal("--fail-on-policy");
    } else if (arg === "--json") {
      opts.json = true;
    } else if (!arg.startsWith("-")) {
      if (opts.targetDir) throw new Error(`Unexpected positional argument: ${arg}`);
      opts.targetDir = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function writeStepSummary({ targetDirLabel, entryCssLabel, failOnPolicy, checkedFilesCount, violations }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const lines = [
    "### UI Design Standard Validation",
    "",
    `- \`target-dir\`: \`${targetDirLabel}\``,
    `- \`entry-css\`: \`${entryCssLabel || "(none)"}\``,
    `- \`fail-on-policy\`: \`${failOnPolicy}\``,
    `- \`files-checked\`: \`${checkedFilesCount}\``,
    `- \`violations\`: \`${violations.length}\``,
    "",
  ];
  if (violations.length === 0) {
    lines.push("✅ すべての UI 設計標準チェックを通過した。");
  } else {
    lines.push("```text");
    for (const v of violations) lines.push(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
    lines.push("```");
    if (!failOnPolicy) {
      lines.push("", "> [!WARNING]", "> UI ポリシー違反が検出されたが `fail-on-policy: false` のため警告のみで通過させた。");
    }
  }
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (!opts.targetDir) {
    console.error("❌ No target directory specified.");
    process.exit(1);
  }
  if (!fs.existsSync(opts.targetDir) || !fs.statSync(opts.targetDir).isDirectory()) {
    console.error(`❌ Target directory '${opts.targetDir}' does not exist or is not a directory.`);
    process.exit(1);
  }
  if (opts.failOnPolicy !== "true" && opts.failOnPolicy !== "false") {
    console.error(`❌ Invalid boolean value for FAIL_ON_POLICY: '${opts.failOnPolicy}' (expected 'true' or 'false').`);
    process.exit(1);
  }
  const failOnPolicy = opts.failOnPolicy === "true";

  let result;
  try {
    result = await runUiLint({ targetDir: opts.targetDir, entryCss: opts.entryCss, excludes: opts.excludes });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const targetDirLabel = opts.targetDir;
  const entryCssLabel = result.entryCssPath
    ? toPosix(path.relative(result.targetDir, result.entryCssPath)) || opts.entryCss
    : opts.entryCss;

  writeStepSummary({
    targetDirLabel,
    entryCssLabel,
    failOnPolicy,
    checkedFilesCount: result.checkedFilesCount,
    violations: result.violations,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("========================================");
    console.log(`UI Validation: ${targetDirLabel}`);
    if (entryCssLabel) console.log(`Entry CSS    : ${entryCssLabel}`);
    console.log(`Files checked: ${result.checkedFilesCount}`);
    console.log("========================================");

    if (result.violations.length === 0) {
      console.log("✅ 0 violations found.");
    } else {
      for (const v of result.violations) {
        console.log(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
      }
      console.log(`\nFound ${result.violations.length} UI policy violation(s).`);
    }
  }

  if (result.violations.length > 0) {
    if (failOnPolicy) {
      console.error("❌ UI design standard violations detected.");
      process.exit(1);
    }
    console.log("⚠️ UI design standard violations detected, but fail-on-policy=false so continuing with warnings.");
  }
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);

if (isMain) main();
