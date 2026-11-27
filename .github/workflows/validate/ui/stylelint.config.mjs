/**
 * Nuage UI 設計標準 Stylelint 設定
 * - 生カラー禁止: ENTRY_CSS 指定時は overrides で同ファイルの色ルールのみ無効化する
 * - :hover ガード: @media (hover: hover) 外の :hover を禁止する
 * 例外は「stylelint-disable-next-line <rule>」でオプトアウトする。
 */
import path from "node:path";
import defensiveCss from "stylelint-plugin-defensive-css";

const DEFAULT_IGNORES = [
  "**/node_modules/**", "**/.next/**", "**/dist/**", "**/build/**", "**/out/**", "**/coverage/**",
  "**/e2e/**", "**/mocks/**", "**/public/**", "**/.git/**", "**/.storybook/**", "**/.nuage-workspace-policies/**",
  "**/tests/**", "**/__tests__/**", "**/__mocks__/**", "**/playwright-report/**", "**/test-results/**", "**/storybook-static/**",
  "**/*.test.*", "**/*.spec.*", "**/*.stories.*", "**/*.config.*", "**/*.d.ts",
];
const toPosix = (p) => p.split(path.sep).join("/");
const parseList = (raw) => (raw ? raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : []);

export function buildStylelintConfig({ cwd = process.cwd(), entryCss = process.env.ENTRY_CSS || "", excludes = parseList(process.env.EXCLUDE) } = {}) {
  const root = toPosix(path.resolve(cwd));
  const ignoreFiles = [
    ...DEFAULT_IGNORES.map((g) => `${root}/${g}`),
    ...excludes.flatMap((raw) => {
      const p = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
      if (/[*?]/.test(p)) return p.includes("/") ? [`${root}/${p}`] : [`${root}/**/${p}`];
      return p.includes("/") ? [`${root}/${p}`, `${root}/${p}/**`] : [`${root}/**/${p}/**`, `${root}/**/${p}`];
    }),
  ];
  return {
    plugins: [defensiveCss],
    ignoreFiles,
    rules: {
      "color-no-hex": true,
      "color-named": "never",
      "function-disallowed-list": ["rgb", "rgba", "hsl", "hsla"],
      "defensive-css/no-accidental-hover": true,
    },
    ...(entryCss ? { overrides: [{ files: [toPosix(path.resolve(root, entryCss))], rules: { "color-no-hex": null, "color-named": null, "function-disallowed-list": null } }] } : {}),
  };
}

export default buildStylelintConfig();
