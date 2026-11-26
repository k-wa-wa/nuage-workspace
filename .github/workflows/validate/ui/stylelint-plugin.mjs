/**
 * Nuage UI 設計標準を検査する Stylelint カスタムプラグイン
 *
 * 【提供するルールと設計背景】
 * 1. nuage-ui/no-raw-color:
 *    ダークテーマ統一とトークン一元管理のため、生カラー（#hex, rgb/rgba/hsl/hsla）の直書きを禁止する。
 *    エントリ CSS の :root { ... } と @theme { ... } 内のみ許可し、正当な例外は
 *    同一行末または直前行のコメント「nuage-ui-ignore-color」でオプトアウトする。
 * 2. nuage-ui/hover-media-query:
 *    タッチデバイスでの :hover 残留を防ぐため、:hover セレクタは必ず @media (hover: hover) 内に配置する。
 *    正当な例外は同一行末または直前行のコメント「nuage-ui-ignore-hover」でオプトアウトする。
 * 3. nuage-ui/entry-css-guardrails:
 *    エントリ CSS に必須トークン 21 個、-webkit-tap-highlight-color: transparent、
 *    :focus:not(:focus-visible) 抑止 + :focus-visible 定義、user-select: none + touch-action: manipulation、
 *    モバイル幅での input / textarea / select の font-size >= 16px（iOS Safari 自動ズーム防止）が
 *    定義されていることを保証する。
 */

import stylelint from "stylelint";
import {
  IGNORE_COLOR_TOKEN,
  IGNORE_HOVER_TOKEN,
  REQUIRED_CSS_VARS,
  findRawColors,
  hasIgnoreComment,
  isMobileWidthMediaQuery,
  parseFontSizePx,
} from "./rules.mjs";

export const RULE_NO_RAW_COLOR = "nuage-ui/no-raw-color";
export const RULE_HOVER_MEDIA_QUERY = "nuage-ui/hover-media-query";
export const RULE_ENTRY_CSS_GUARDRAILS = "nuage-ui/entry-css-guardrails";

const noRawColorMessages = stylelint.utils.ruleMessages(RULE_NO_RAW_COLOR, {
  rejected: (value) =>
    `生カラー '${value}' の直書きは禁止である（セマンティック CSS 変数を使うこと。例外は ${IGNORE_COLOR_TOKEN} で明示する）。`,
});

const hoverMediaQueryMessages = stylelint.utils.ruleMessages(RULE_HOVER_MEDIA_QUERY, {
  rejected: (selector) =>
    `:hover セレクタ '${selector}' は @media (hover: hover) ブロック内に配置すること（例外は ${IGNORE_HOVER_TOKEN} で明示する）。`,
});

const entryGuardrailsMessages = stylelint.utils.ruleMessages(RULE_ENTRY_CSS_GUARDRAILS, {
  missingVars: (vars) => `エントリ CSS に必須 CSS 変数が不足している: ${vars.join(", ")}`,
  missingTapHighlight: () =>
    "エントリ CSS に '-webkit-tap-highlight-color: transparent' が定義されていない。",
  missingFocusSuppression: () =>
    "エントリ CSS に ':focus:not(:focus-visible)' でのアウトライン抑止（outline: none / 0）が定義されていない。",
  missingFocusVisible: () =>
    "エントリ CSS に ':focus-visible' のフォーカス表示定義が不足している。",
  missingUserSelect: () =>
    "エントリ CSS に 'user-select: none' が定義されていない。",
  missingTouchAction: () =>
    "エントリ CSS に 'touch-action: manipulation' が定義されていない。",
  missingMobileInputFontSize: (elements) =>
    `エントリ CSS のモバイル幅メディアクエリ（例: @media (max-width: 768px)）内に ${elements.join(", ")} の 'font-size: 16px' 以上が定義されていない（iOS Safari 自動ズーム防止）。`,
});

function isInsideRootOrTheme(node) {
  let current = node.parent;
  while (current) {
    if (current.type === "atrule" && current.name.toLowerCase() === "theme") {
      return true;
    }
    if (current.type === "rule") {
      const selectors = current.selector.split(",").map((s) => s.trim());
      if (selectors.includes(":root")) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isInsideHoverMediaQuery(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === "atrule" &&
      current.name.toLowerCase() === "media" &&
      /\(\s*hover\s*:\s*hover\s*\)/i.test(current.params)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function selectorMatchesFormElement(selectorPart, tagName) {
  const re = new RegExp(
    `(?:^|[\\s>+~])${tagName}(?=$|[:.\\[#\\s>+~])`,
    "i",
  );
  return re.test(selectorPart.trim());
}

const noRawColorPlugin = stylelint.createPlugin(
  RULE_NO_RAW_COLOR,
  (primaryOption, secondaryOption) => {
    return (root, result) => {
      if (!primaryOption) return;
      const isEntryCss = Boolean(secondaryOption && secondaryOption.isEntryCss);
      const rawCss = root.source?.input?.css ?? root.toString();
      const lines = rawCss.split(/\r?\n/);

      root.walkDecls((decl) => {
        if (isEntryCss && isInsideRootOrTheme(decl)) {
          return;
        }

        const declStartLine = decl.source?.start?.line ?? 1;
        // prop + between（例: "background:\n  "）の行数だけ value 開始行がずれる
        const prefixText = `${decl.prop}${decl.raws?.between ?? ":"}`;
        const valueStartLine = declStartLine + prefixText.split("\n").length - 1;

        const matches = findRawColors(decl.value, { maskUrls: true });
        for (const m of matches) {
          const matchLine = valueStartLine + m.lineOffset;
          if (hasIgnoreComment(lines, matchLine, IGNORE_COLOR_TOKEN)) {
            continue;
          }
          stylelint.utils.report({
            message: noRawColorMessages.rejected(m.value),
            node: decl,
            result,
            ruleName: RULE_NO_RAW_COLOR,
            word: m.value,
          });
        }
      });
    };
  },
);
noRawColorPlugin.ruleName = RULE_NO_RAW_COLOR;
noRawColorPlugin.messages = noRawColorMessages;

const hoverMediaQueryPlugin = stylelint.createPlugin(
  RULE_HOVER_MEDIA_QUERY,
  (primaryOption) => {
    return (root, result) => {
      if (!primaryOption) return;
      const rawCss = root.source?.input?.css ?? root.toString();
      const lines = rawCss.split(/\r?\n/);

      root.walkRules((rule) => {
        if (!/:hover(?![a-zA-Z0-9_-])/i.test(rule.selector)) {
          return;
        }
        if (isInsideHoverMediaQuery(rule)) {
          return;
        }

        const startLine = rule.source?.start?.line ?? 1;
        const selectorLineCount = rule.selector.split("\n").length;
        let ignored = hasIgnoreComment(lines, startLine, IGNORE_HOVER_TOKEN);
        if (!ignored) {
          for (let offset = 1; offset < selectorLineCount; offset += 1) {
            if (hasIgnoreComment(lines, startLine + offset, IGNORE_HOVER_TOKEN)) {
              ignored = true;
              break;
            }
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
          return;
        }

        stylelint.utils.report({
          message: hoverMediaQueryMessages.rejected(rule.selector.replace(/\s+/g, " ").trim()),
          node: rule,
          result,
          ruleName: RULE_HOVER_MEDIA_QUERY,
          word: ":hover",
        });
      });
    };
  },
);
hoverMediaQueryPlugin.ruleName = RULE_HOVER_MEDIA_QUERY;
hoverMediaQueryPlugin.messages = hoverMediaQueryMessages;

const entryGuardrailsPlugin = stylelint.createPlugin(
  RULE_ENTRY_CSS_GUARDRAILS,
  (primaryOption) => {
    return (root, result) => {
      if (!primaryOption) return;

      const definedVars = new Set();
      let hasTapHighlight = false;
      let hasFocusSuppression = false;
      let hasFocusVisible = false;
      let hasUserSelectNone = false;
      let hasTouchActionManipulation = false;
      const mobileFormFontSizes = {
        input: false,
        textarea: false,
        select: false,
      };

      root.walkDecls((decl) => {
        const prop = decl.prop;
        const propLower = prop.toLowerCase();
        const valLower = decl.value.replace(/!important/gi, "").trim().toLowerCase();

        if (prop.startsWith("--") && isInsideRootOrTheme(decl)) {
          definedVars.add(prop);
        }

        if (
          propLower === "-webkit-tap-highlight-color" &&
          (valLower === "transparent" || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(valLower))
        ) {
          hasTapHighlight = true;
        }

        if (propLower === "user-select" && valLower === "none") {
          hasUserSelectNone = true;
        }

        if (propLower === "touch-action" && valLower === "manipulation") {
          hasTouchActionManipulation = true;
        }
      });

      root.walkRules((rule) => {
        const selector = rule.selector;
        const decls = (rule.nodes ?? []).filter((n) => n.type === "decl");

        if (/:focus\s*:not\(\s*:focus-visible\s*\)/i.test(selector) || /:focus:not\(\s*:focus-visible\s*\)/i.test(selector)) {
          const suppressesOutline = decls.some((d) => {
            const p = d.prop.toLowerCase();
            const v = d.value.replace(/!important/gi, "").trim().toLowerCase();
            return (
              (p === "outline" && (v === "none" || v === "0" || v === "0px")) ||
              (p === "outline-style" && v === "none") ||
              (p === "outline-width" && (v === "0" || v === "0px"))
            );
          });
          if (suppressesOutline) {
            hasFocusSuppression = true;
          }
        }

        const withoutNotFocusVisible = selector.replace(/:not\(\s*:focus-visible\s*\)/gi, "");
        if (/:focus-visible\b/i.test(withoutNotFocusVisible)) {
          const definesFocusStyle = decls.some((d) => {
            const p = d.prop.toLowerCase();
            const v = d.value.replace(/!important/gi, "").trim().toLowerCase();
            return (
              (p === "outline" || p === "outline-style" || p === "outline-color" || p === "box-shadow") &&
              v !== "none" &&
              v !== "0"
            );
          });
          if (definesFocusStyle) {
            hasFocusVisible = true;
          }
        }
      });

      root.walkAtRules("media", (atRule) => {
        if (!isMobileWidthMediaQuery(atRule.params)) {
          return;
        }
        atRule.walkRules((rule) => {
          const fontDecls = (rule.nodes ?? []).filter(
            (n) => n.type === "decl" && n.prop.toLowerCase() === "font-size",
          );
          if (fontDecls.length === 0) return;

          const hasAtLeast16px = fontDecls.some((d) => {
            const px = parseFontSizePx(d.value);
            return px !== null && px >= 16;
          });
          if (!hasAtLeast16px) return;

          const parts = rule.selector.split(",");
          for (const part of parts) {
            for (const tag of ["input", "textarea", "select"]) {
              if (selectorMatchesFormElement(part, tag)) {
                mobileFormFontSizes[tag] = true;
              }
            }
          }
        });
      });

      const missingVars = REQUIRED_CSS_VARS.filter((v) => !definedVars.has(v));
      if (missingVars.length > 0) {
        stylelint.utils.report({
          message: entryGuardrailsMessages.missingVars(missingVars),
          node: root,
          result,
          ruleName: RULE_ENTRY_CSS_GUARDRAILS,
        });
      }

      if (!hasTapHighlight) {
        stylelint.utils.report({
          message: entryGuardrailsMessages.missingTapHighlight(),
          node: root,
          result,
          ruleName: RULE_ENTRY_CSS_GUARDRAILS,
        });
      }

      if (!hasFocusSuppression) {
        stylelint.utils.report({
          message: entryGuardrailsMessages.missingFocusSuppression(),
          node: root,
          result,
          ruleName: RULE_ENTRY_CSS_GUARDRAILS,
        });
      }

      if (!hasFocusVisible) {
        stylelint.utils.report({
          message: entryGuardrailsMessages.missingFocusVisible(),
          node: root,
          result,
          ruleName: RULE_ENTRY_CSS_GUARDRAILS,
        });
      }

      if (!hasUserSelectNone) {
        stylelint.utils.report({
          message: entryGuardrailsMessages.missingUserSelect(),
          node: root,
          result,
          ruleName: RULE_ENTRY_CSS_GUARDRAILS,
        });
      }

      if (!hasTouchActionManipulation) {
        stylelint.utils.report({
          message: entryGuardrailsMessages.missingTouchAction(),
          node: root,
          result,
          ruleName: RULE_ENTRY_CSS_GUARDRAILS,
        });
      }

      const missingMobileElements = ["input", "textarea", "select"].filter(
        (tag) => !mobileFormFontSizes[tag],
      );
      if (missingMobileElements.length > 0) {
        stylelint.utils.report({
          message: entryGuardrailsMessages.missingMobileInputFontSize(missingMobileElements),
          node: root,
          result,
          ruleName: RULE_ENTRY_CSS_GUARDRAILS,
        });
      }
    };
  },
);
entryGuardrailsPlugin.ruleName = RULE_ENTRY_CSS_GUARDRAILS;
entryGuardrailsPlugin.messages = entryGuardrailsMessages;

export default [noRawColorPlugin, hoverMediaQueryPlugin, entryGuardrailsPlugin];
