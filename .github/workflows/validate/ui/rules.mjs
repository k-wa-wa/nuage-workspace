/**
 * Nuage UI 設計標準 lint の共通定義・ヘルパー群
 *
 * 【なぜこのルールが必要か】
 * 1. 生カラー直書き禁止（nuage-ui/no-raw-color）:
 *    Nuage の UI はダークテーマ専用として設計されており、色・透過率はすべてエントリ CSS の
 *    セマンティックトークン（--bg, --fg, --accent, --accent-subtle 等）へ集約する。
 *    コンポーネントや一般 CSS へ #hex / rgb() / rgba() / hsl() / hsla() を直書きすると、
 *    プロダクト横断の統一感と保守性が損なわれる。
 *    ※ PWA の themeColor / manifest.ts、3D ライブラリ属性等の正当な例外には
 *      同一行末または直前行のコメント（nuage-ui-ignore-color）でオプトアウトできる。
 *
 * 2. :hover の @media (hover: hover) ラップ必須（nuage-ui/hover-media-query）:
 *    スマホやタブレット等のタッチデバイスでは、タップ後に :hover 状態が画面上に残留し、
 *    ボタンが押されたままに見える不具合が起きる。
 *    :hover スタイルは必ず @media (hover: hover) { ... } 内に限定して定義する。
 *    ※ 正当な例外には同一行末または直前行のコメント（nuage-ui-ignore-hover）でオプトアウトできる。
 *
 * 3. エントリ CSS の必須トークン・モバイル/アクセシビリティガードレール（nuage-ui/entry-css-guardrails）:
 *    - 21 個の必須 CSS 変数（カラー・タイポグラフィ・角丸・触覚スプリングトークン）の定義
 *    - -webkit-tap-highlight-color: transparent による WebKit 青色ハイライトの排除
 *    - :focus:not(:focus-visible) でのクリック時青枠抑止と :focus-visible のキーボードフォーカス視認性確保
 *    - user-select: none と touch-action: manipulation による長押し誤選択・ダブルタップ遅延の防止
 *    - モバイル幅（@media (max-width: 768px) 等）での input / textarea / select に対する
 *      font-size: 16px 以上（iOS Safari のフォーカス時自動ズーム防止）
 */

export const IGNORE_COLOR_TOKEN = "nuage-ui-ignore-color";
export const IGNORE_HOVER_TOKEN = "nuage-ui-ignore-hover";

export const REQUIRED_CSS_VARS = [
  "--bg",
  "--fg",
  "--card",
  "--line",
  "--muted",
  "--accent",
  "--warn",
  "--success",
  "--blocked",
  "--font-sans",
  "--font-mono",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-full",
  "--ease-spring",
  "--ease-snappy",
  "--duration-press",
  "--duration-release",
  "--scale-button-active",
  "--scale-icon-active",
];

// URL パスやフラグメント（/path#123, #vr-video 等）との誤検知を避けつつ、
// #RGB / #RGBA / #RRGGBB / #RRGGBBAA と rgb() / rgba() / hsl() / hsla() を検出する。
const HEX_COLOR_SOURCE = "(?<![A-Za-z0-9_/.-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![A-Za-z0-9_-])";
const FUNC_COLOR_SOURCE = "\\b(?:rgba?|hsla?)\\s*\\([^)]*\\)";
export const RAW_COLOR_REGEX = new RegExp(`${HEX_COLOR_SOURCE}|${FUNC_COLOR_SOURCE}`, "gi");

/**
 * 指定行（1-based）または直前行にオプトアウトコメントが含まれるかを判定する。
 *
 * @param {string[]} lines
 * @param {number} lineNumber 1-based line number
 * @param {string} token
 * @returns {boolean}
 */
export function hasIgnoreComment(lines, lineNumber, token) {
  if (!Array.isArray(lines) || lineNumber < 1) {
    return false;
  }
  const currentLine = lines[lineNumber - 1] ?? "";
  const prevLine = lineNumber >= 2 ? (lines[lineNumber - 2] ?? "") : "";
  return currentLine.includes(token) || prevLine.includes(token);
}

/**
 * CSS 文字列から url(...) の中身を同文字数の空白へ置換し、SVG フラグメント（url(#id)）の誤検知を防ぐ。
 * 改行文字は保持するため行番号はずれない。
 *
 * @param {string} value
 * @returns {string}
 */
export function maskCssUrls(value) {
  return value.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/**
 * 文字列内の生カラー（#hex, rgb/rgba/hsl/hsla）をすべて抽出する。
 *
 * @param {string} text
 * @param {{ maskUrls?: boolean }} [options]
 * @returns {Array<{ value: string, index: number, lineOffset: number }>}
 */
export function findRawColors(text, options = {}) {
  const source = options.maskUrls ? maskCssUrls(text) : text;
  const matches = [];
  RAW_COLOR_REGEX.lastIndex = 0;
  let match;
  while ((match = RAW_COLOR_REGEX.exec(source)) !== null) {
    const before = source.slice(0, match.index);
    const lineOffset = before.split("\n").length - 1;
    matches.push({
      value: match[0],
      index: match.index,
      lineOffset,
    });
  }
  return matches;
}

/**
 * メディアクエリ文字列がモバイル幅（max-width が 480px〜1024px 相当）を表すか判定する。
 *
 * @param {string} params
 * @returns {boolean}
 */
export function isMobileWidthMediaQuery(params) {
  const normalized = params.trim().toLowerCase();
  const patterns = [
    /\bmax-width\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\b/g,
    /\bwidth\s*<=\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\b/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(normalized)) !== null) {
      const num = Number.parseFloat(m[1]);
      const unit = m[2];
      const px = unit === "px" ? num : num * 16;
      if (px >= 480 && px <= 1024) {
        return true;
      }
    }
  }
  return false;
}

/**
 * CSS の font-size 値を px 数値へ変換する（px / rem / em / max() に対応）。
 * 判定不能な場合は null を返す。
 *
 * @param {string} value
 * @returns {number | null}
 */
export function parseFontSizePx(value) {
  const cleaned = value.replace(/!important/gi, "").trim().toLowerCase();
  const singleMatch = /^([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)$/.exec(cleaned);
  if (singleMatch) {
    const num = Number.parseFloat(singleMatch[1]);
    const unit = singleMatch[2];
    return unit === "px" ? num : num * 16;
  }

  const maxMatch = /^max\((.+)\)$/.exec(cleaned);
  if (maxMatch) {
    const parts = maxMatch[1].split(",").map((p) => parseFontSizePx(p));
    const valid = parts.filter((n) => n !== null);
    if (valid.length > 0) {
      return Math.max(...valid);
    }
  }

  return null;
}
