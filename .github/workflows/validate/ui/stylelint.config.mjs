/**
 * Nuage UI 設計標準 Stylelint 設定
 *
 * 1. 生カラー直書き禁止（color-no-hex / color-named / function-disallowed-list）:
 *    ダークテーマ専用設計を一貫して保つため、一般 CSS での #hex・名前付きカラー・
 *    rgb()/rgba()/hsl()/hsla() 直書きを禁止し、エントリ CSS の :root トークンへ集約する。
 *    --entry-css 指定時は overrides で色ルールのみ無効化し :root 定義を許可する。
 * 2. :hover ガード必須（defensive-css/no-accidental-hover）:
 *    タッチデバイスでの :hover 残留を防ぐため @media (hover: hover) 内への配置を必須とする。
 *
 * 例外は Stylelint 標準の「stylelint-disable-next-line <rule>」でオプトアウトする。
 */
import defensiveCss from "stylelint-plugin-defensive-css";

export function buildStylelintConfig(entryCss = process.env.NUAGE_UI_ENTRY_CSS) {
  return {
    plugins: [defensiveCss],
    rules: {
      "color-no-hex": true,
      "color-named": "never",
      "function-disallowed-list": ["rgb", "rgba", "hsl", "hsla"],
      "defensive-css/no-accidental-hover": true,
    },
    ...(entryCss
      ? {
          overrides: [
            {
              files: [entryCss],
              rules: { "color-no-hex": null, "color-named": null, "function-disallowed-list": null },
            },
          ],
        }
      : {}),
  };
}

export default buildStylelintConfig();
