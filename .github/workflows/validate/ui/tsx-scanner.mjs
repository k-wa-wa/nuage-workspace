/**
 * TypeScript / React (TSX / TS / JSX / JS) ソースの UI 規約スキャナ
 *
 * 【検査内容】
 * 1. <style>{...}</style>（<style jsx> 含む）から CSS 断片を抽出し、
 *    元のファイル行番号を維持したまま Stylelint へ渡す（生カラー禁止・@media (hover: hover) 必須）。
 * 2. style={{ ... }}、Tailwind 任意値（bg-[#...] 等）、JS/TS 文字列リテラル内の
 *    生カラー（#hex, rgb(), rgba(), hsl(), hsla()）を検出する。
 *    PWA themeColor / manifest.ts、3D ライブラリ属性等の正当な例外は
 *    同一行末または直前行コメント（nuage-ui-ignore-color）でオプトアウトできる。
 */

import ts from "typescript";
import {
  IGNORE_COLOR_TOKEN,
  findRawColors,
  hasIgnoreComment,
} from "./rules.mjs";

function getScriptKind(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function getTagNameText(tagName) {
  if (ts.isIdentifier(tagName)) {
    return tagName.text;
  }
  return "";
}

function extractTemplateExpressionCss(expr, sourceFile, sourceText) {
  const head = expr.head;
  const startPos = head.getStart(sourceFile) + 1;
  const lc = sourceFile.getLineAndCharacterOfPosition(startPos);

  let css = head.text;
  let prevEnd = head.getEnd();

  for (const span of expr.templateSpans) {
    const litStart = span.literal.getStart(sourceFile);
    const exprSlice = sourceText.slice(prevEnd, litStart);
    const newlineCount = (exprSlice.match(/\n/g) || []).length;
    css += `var(--nuage-expr)${"\n".repeat(newlineCount)}${span.literal.text}`;
    prevEnd = span.literal.getEnd();
  }

  return {
    css,
    startLine: lc.line + 1,
  };
}

function extractStyleElementBlocks(jsxElement, sourceFile, sourceText) {
  const blocks = [];
  const elementStartLine =
    sourceFile.getLineAndCharacterOfPosition(jsxElement.getStart(sourceFile)).line + 1;

  for (const child of jsxElement.children) {
    if (ts.isJsxText(child)) {
      const text = child.getText(sourceFile);
      if (text.trim().length > 0) {
        const lc = sourceFile.getLineAndCharacterOfPosition(child.getStart(sourceFile));
        blocks.push({
          css: text,
          startLine: lc.line + 1,
          elementStartLine,
        });
      }
      continue;
    }

    if (ts.isJsxExpression(child) && child.expression) {
      const expr = child.expression;
      if (ts.isNoSubstitutionTemplateLiteral(expr) || ts.isStringLiteral(expr)) {
        const startPos = expr.getStart(sourceFile) + 1;
        const lc = sourceFile.getLineAndCharacterOfPosition(startPos);
        blocks.push({
          css: expr.text,
          startLine: lc.line + 1,
          elementStartLine,
        });
      } else if (ts.isTemplateExpression(expr)) {
        const extracted = extractTemplateExpressionCss(expr, sourceFile, sourceText);
        blocks.push({
          ...extracted,
          elementStartLine,
        });
      }
    }
  }

  return blocks;
}

function isModuleSpecifierNode(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) {
    return true;
  }
  if (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) {
    return true;
  }
  if (ts.isExternalModuleReference(parent) && parent.expression === node) {
    return true;
  }
  return false;
}

function getLiteralContentSlice(node, sourceFile, sourceText) {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      contentStart: start + 1,
      text: sourceText.slice(start + 1, Math.max(start + 1, end - 1)),
    };
  }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
    return {
      contentStart: start + 1,
      text: sourceText.slice(start + 1, Math.max(start + 1, end - 2)),
    };
  }
  if (ts.isTemplateTail(node)) {
    return {
      contentStart: start + 1,
      text: sourceText.slice(start + 1, Math.max(start + 1, end - 1)),
    };
  }
  return null;
}

/**
 * 単一の TS / TSX / JS / JSX ファイルを解析し、
 * <style> ブロック一覧と JS/TS 内の生カラー違反一覧を返す。
 *
 * @param {string} filePath
 * @param {string} sourceText
 * @returns {{
 *   lines: string[],
 *   styleBlocks: Array<{ css: string, startLine: number, elementStartLine: number }>,
 *   colorViolations: Array<{ line: number, column: number, value: string, message: string }>
 * }}
 */
export function analyzeScriptFile(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );
  const lines = sourceText.split(/\r?\n/);
  const styleBlocks = [];
  const colorViolations = [];

  function visit(node) {
    if (ts.isJsxElement(node)) {
      const tagName = getTagNameText(node.openingElement.tagName);
      if (tagName === "style") {
        styleBlocks.push(...extractStyleElementBlocks(node, sourceFile, sourceText));
        // <style> 本体は Stylelint 側で検査するため、子の文字列スキャンはスキップする
        return;
      }
    }

    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (!isModuleSpecifierNode(node)) {
        const slice = getLiteralContentSlice(node, sourceFile, sourceText);
        if (slice && slice.text.length > 0) {
          const matches = findRawColors(slice.text);
          for (const m of matches) {
            const absPos = slice.contentStart + m.index;
            const lc = sourceFile.getLineAndCharacterOfPosition(absPos);
            const line = lc.line + 1;
            const column = lc.character + 1;
            if (!hasIgnoreComment(lines, line, IGNORE_COLOR_TOKEN)) {
              colorViolations.push({
                line,
                column,
                value: m.value,
                message: `生カラー '${m.value}' の直書きは禁止である（セマンティック CSS 変数を使うこと。例外は ${IGNORE_COLOR_TOKEN} で明示する）。`,
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    lines,
    styleBlocks,
    colorViolations,
  };
}
