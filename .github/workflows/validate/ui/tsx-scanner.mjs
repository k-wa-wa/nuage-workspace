/**
 * TypeScript / React (TSX / TS / JSX / JS) ソースの UI 規約スキャナ
 *
 * 【検査内容】
 * 1. <style>{...}</style>（<style jsx> 含む）から静的 CSS 断片（条件式の文字列枝を含む）を抽出し、
 *    元のファイル行番号を維持したまま Stylelint へ渡す（生カラー禁止・@media (hover: hover) 必須）。
 * 2. style={{ ... }}、Tailwind 任意値（bg-[#...] 等）、JS/TS 文字列リテラル内の
 *    生カラー（#hex, rgb(), rgba(), hsl(), hsla()）を検出する。
 *    PWA themeColor / manifest.ts、3D ライブラリ属性等の正当な例外は
 *    同一行末または直前行コメント（nuage-ui-ignore-color）でオプトアウトできる。
 */

import ts from "typescript";

export const IGNORE_COLOR_TOKEN = "nuage-ui-ignore-color";
export const IGNORE_HOVER_TOKEN = "nuage-ui-ignore-hover";

const RAW_COLOR_REGEX =
  /(?<![A-Za-z0-9_/.-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![A-Za-z0-9_-])|\b(?:rgba?|hsla?)\s*\((?:[^()]|\([^)]*\))*\)/gi;

/**
 * 複数行になり得るコメント文字列を行番号マップ（1-based）へ登録する。
 *
 * @param {Map<number, string>} commentLines
 * @param {number} startLine
 * @param {string} text
 */
export function addCommentLines(commentLines, startLine, text) {
  const parts = text.split(/\r?\n/);
  for (let i = 0; i < parts.length; i += 1) {
    const ln = startLine + i;
    const prev = commentLines.get(ln);
    commentLines.set(ln, prev ? `${prev}\n${parts[i]}` : parts[i]);
  }
}

/**
 * 指定行（1-based）または直前行のコメント内にオプトアウトトークンが含まれるかを判定する。
 *
 * @param {Map<number, string>} commentLines
 * @param {number} lineNumber 1-based line number
 * @param {string} token
 * @returns {boolean}
 */
export function hasIgnoreComment(commentLines, lineNumber, token) {
  if (!(commentLines instanceof Map) || lineNumber < 1) return false;
  return (
    (commentLines.get(lineNumber) ?? "").includes(token) ||
    (lineNumber >= 2 && (commentLines.get(lineNumber - 1) ?? "").includes(token))
  );
}

function collectScriptCommentLines(sourceFile, sourceText) {
  const commentLines = new Map();
  const seen = new Set();

  function record(ranges) {
    if (!ranges) return;
    for (const r of ranges) {
      const key = `${r.pos}:${r.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const startLine = sourceFile.getLineAndCharacterOfPosition(r.pos).line + 1;
      addCommentLines(commentLines, startLine, sourceText.slice(r.pos, r.end));
    }
  }

  function walkAll(node) {
    record(ts.getLeadingCommentRanges(sourceText, node.getFullStart()));
    record(ts.getTrailingCommentRanges(sourceText, node.getEnd()));
    for (const child of node.getChildren(sourceFile)) {
      walkAll(child);
    }
  }

  walkAll(sourceFile);
  return commentLines;
}

function getScriptKind(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function extractStyleFromExpression(expr, sourceFile, sourceText, styleBlocks, visitExpr) {
  if (!expr) return;
  if (ts.isParenthesizedExpression(expr)) {
    extractStyleFromExpression(expr.expression, sourceFile, sourceText, styleBlocks, visitExpr);
    return;
  }
  if (ts.isNoSubstitutionTemplateLiteral(expr) || ts.isStringLiteral(expr)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(expr.getStart(sourceFile) + 1);
    if (expr.text.trim()) styleBlocks.push({ css: expr.text, startLine: line + 1 });
    return;
  }
  if (ts.isTemplateExpression(expr)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(expr.head.getStart(sourceFile) + 1);
    let css = expr.head.text;
    let prevEnd = expr.head.getEnd();
    for (const span of expr.templateSpans) {
      const litStart = span.literal.getStart(sourceFile);
      const newlines = (sourceText.slice(prevEnd, litStart).match(/\n/g) || []).length;
      css += `var(--nuage-expr)${"\n".repeat(newlines)}${span.literal.text}`;
      prevEnd = span.literal.getEnd();
      visitExpr(span.expression);
    }
    if (css.trim()) styleBlocks.push({ css, startLine: line + 1 });
    return;
  }
  if (ts.isConditionalExpression(expr)) {
    visitExpr(expr.condition);
    extractStyleFromExpression(expr.whenTrue, sourceFile, sourceText, styleBlocks, visitExpr);
    extractStyleFromExpression(expr.whenFalse, sourceFile, sourceText, styleBlocks, visitExpr);
    return;
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    visitExpr(expr.left);
    extractStyleFromExpression(expr.right, sourceFile, sourceText, styleBlocks, visitExpr);
    return;
  }
  visitExpr(expr);
}

function extractStyleElementBlocks(jsxElement, sourceFile, sourceText, visitExpr) {
  const blocks = [];
  for (const child of jsxElement.children) {
    if (ts.isJsxText(child)) {
      const text = child.getText(sourceFile);
      if (text.trim()) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(child.getStart(sourceFile));
        blocks.push({ css: text, startLine: line + 1 });
      }
      continue;
    }
    if (ts.isJsxExpression(child) && child.expression) {
      extractStyleFromExpression(child.expression, sourceFile, sourceText, blocks, visitExpr);
    }
  }
  return blocks;
}

function isStringLikeLiteral(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

function isModuleSpecifier(node) {
  const p = node.parent;
  return Boolean(
    p &&
      (((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) ||
        (ts.isExternalModuleReference(p) && p.expression === node)),
  );
}

function findEnclosingAttrInfo(node) {
  let jsxAttrName = null;
  let propName = null;
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!propName && ts.isPropertyAssignment(cur) && ts.isIdentifier(cur.name)) {
      propName = cur.name.text;
    }
    if (ts.isJsxAttribute(cur) && ts.isIdentifier(cur.name)) {
      jsxAttrName = cur.name.text;
      break;
    }
    if (ts.isJsxOpeningElement(cur) || ts.isJsxSelfClosingElement(cur)) break;
  }
  return { jsxAttrName, propName };
}

function maskUrlFunctionsInText(text) {
  return text.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (m) => m.replace(/[^\n]/g, " "));
}

function shouldReportColorMatch(node, sliceText, value, index) {
  const { jsxAttrName, propName } = findEnclosingAttrInfo(node);
  if (jsxAttrName === "href" || jsxAttrName === "xlinkHref" || propName === "href") {
    return false;
  }

  if (!value.startsWith("#")) {
    const open = value.indexOf("(");
    const close = value.lastIndexOf(")");
    const inner = open >= 0 && close > open ? value.slice(open + 1, close).trim().toLowerCase() : "";
    return !inner.startsWith("var(");
  }

  if (jsxAttrName === "style") return true;

  const before = sliceText.slice(0, index);
  // Tailwind 任意値（bg-[#123] 等）や CSS プロパティ文字列（"color: #123" 等）は常に検査する
  if (before.endsWith("[") || /:\s*$/.test(before)) return true;

  const hexBody = value.slice(1);
  if (sliceText.trim() === value) {
    // 3〜4 桁の英字のみの単語（#add, #cafe, #feed 等）はアンカー識別子と区別するため除外（#fff/#aaa 等は検出）
    return !(/^[a-fA-F]{3,4}$/.test(hexBody) && !/^(.)\1+$/i.test(hexBody));
  }
  // 非スタイル文字列中に埋め込まれた 3〜4 桁の hex（例: "Issue #123"）は誤検知を防ぐため除外する
  return hexBody.length >= 6;
}

/**
 * 単一の TS / TSX / JS / JSX ファイルを解析し、
 * コメント行マップ・<style> ブロック一覧・JS/TS 内の生カラー違反一覧を返す。
 *
 * @param {string} filePath
 * @param {string} sourceText
 */
export function analyzeScriptFile(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
  const commentLines = collectScriptCommentLines(sourceFile, sourceText);
  const styleBlocks = [];
  const colorViolations = [];

  function visit(node) {
    if (
      ts.isJsxElement(node) &&
      ts.isIdentifier(node.openingElement.tagName) &&
      node.openingElement.tagName.text === "style"
    ) {
      styleBlocks.push(...extractStyleElementBlocks(node, sourceFile, sourceText, visit));
      return;
    }

    if (isStringLikeLiteral(node) && !isModuleSpecifier(node)) {
      const start = node.getStart(sourceFile) + 1;
      const tailTrim = ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1;
      const rawSlice = sourceText.slice(start, Math.max(start, node.getEnd() - tailTrim));
      const maskedSlice = maskUrlFunctionsInText(rawSlice);
      if (maskedSlice) {
        RAW_COLOR_REGEX.lastIndex = 0;
        let m;
        while ((m = RAW_COLOR_REGEX.exec(maskedSlice)) !== null) {
          if (!shouldReportColorMatch(node, rawSlice, m[0], m.index)) continue;
          const lc = sourceFile.getLineAndCharacterOfPosition(start + m.index);
          const line = lc.line + 1;
          if (!hasIgnoreComment(commentLines, line, IGNORE_COLOR_TOKEN)) {
            colorViolations.push({
              line,
              column: lc.character + 1,
              rule: "nuage-ui/no-raw-color",
              message: `生カラー '${m[0]}' の直書きは禁止である（セマンティック CSS 変数を使うこと。例外は ${IGNORE_COLOR_TOKEN} で明示する）。`,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { commentLines, styleBlocks, colorViolations };
}
