/**
 * Nuage UI 設計標準 Stylelint 設定
 *
 * 【なぜこのルールが必要か】
 * 1. 生カラー直書き禁止（color-no-hex / declaration-property-value-disallowed-list）:
 *    Nuage の UI はダークテーマ専用として設計されており、色・透過率はすべてエントリ CSS の
 *    セマンティックトークン（--bg, --fg, --accent, --accent-subtle 等）へ集約する。
 *    コンポーネントや一般 CSS へ #hex / rgb() / rgba() / hsl() / hsla() を直書きすると、
 *    プロダクト横断の統一感と保守性が損なわれる（ただし rgba(var(...), ...) 等のトークン参照は許可する）。
 *    ※ 正当な例外は「nuage-ui-ignore-color」または Stylelint 標準の
 *      「stylelint-disable-next-line color-no-hex」等でオプトアウトできる。
 *
 * 2. :hover の @media (hover: hover) ラップ必須（defensive-css/no-accidental-hover）:
 *    スマホやタブレット等のタッチデバイスでは、タップ後に :hover 状態が画面上に残留し、
 *    ボタンが押されたままに見える不具合が起きる。
 *    :hover スタイルは必ず @media (hover: hover) { ... } 内に限定して定義する。
 *    ※ 正当な例外は「nuage-ui-ignore-hover」または Stylelint 標準の
 *      「stylelint-disable-next-line defensive-css/no-accidental-hover」でオプトアウトできる。
 */

import defensiveCss from "stylelint-plugin-defensive-css";

export default {
  plugins: [defensiveCss],
  rules: {
    "color-no-hex": true,
    // rgb()/rgba()/hsl()/hsla() の直書きを禁止しつつ、rgba(var(--accent-rgb), 0.1) 等のトークン経由は許可する
    "declaration-property-value-disallowed-list": {
      "/.*/": ["/\\b(?:rgba?|hsla?)\\s*\\(\\s*(?!var\\s*\\()/i"],
    },
    "defensive-css/no-accidental-hover": true,
  },
};
