/**
 * Nuage UI 設計標準 Stylelint 設定
 * - 生カラー禁止: ENTRY_CSS 指定時は overrides で同ファイルの色ルールのみ無効化する
 * - :hover ガード: @media (hover: hover) 外の :hover を禁止する
 * 例外は「stylelint-disable-next-line <rule>」でオプトアウトする。
 */
import fs from "node:fs";
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
const escapeGlob = (s) => s.replace(/([*?[\](){}!,+@])/g, "[$1]");

export function buildStylelintConfig({ cwd = process.cwd(), repoRoot = process.env.REPO_ROOT || "", entryCss = process.env.ENTRY_CSS || "", excludes = parseList(process.env.EXCLUDE) } = {}) {
  const root = toPosix(path.resolve(cwd));
  const rootGlob = escapeGlob(root);
  const ignoreFiles = [
    ...DEFAULT_IGNORES.map((g) => `${rootGlob}/${g}`),
    ...excludes.flatMap((raw) => {
      const p = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
      if (!/[*?]/.test(p)) return [`${rootGlob}/${escapeGlob(p)}`, `${rootGlob}/${escapeGlob(p)}/**`];
      return p.includes("/") ? [`${rootGlob}/${p}`, `${rootGlob}/${p}/**`] : [`${rootGlob}/**/${p}`, `${rootGlob}/**/${p}/**`];
    }),
  ];
  let entryOverrides = {};
  if (entryCss) {
    const candidates = path.isAbsolute(entryCss) ? [entryCss] : [path.resolve(root, entryCss), ...(repoRoot ? [path.resolve(repoRoot, entryCss)] : [])];
    const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!found) throw new Error(`Entry CSS file '${entryCss}' does not exist.`);
    const files = [...new Set([escapeGlob(toPosix(found)), escapeGlob(toPosix(fs.realpathSync(found)))])];
    entryOverrides = { overrides: [{ files, rules: { "color-no-hex": null, "color-named": null, "function-disallowed-list": null } }] };
  }
  return {
    plugins: [defensiveCss],
    ignoreFiles,
    rules: {
      "color-no-hex": true,
      "color-named": "never",
      "function-disallowed-list": ["rgb", "rgba", "hsl", "hsla"],
      "defensive-css/no-accidental-hover": true,
    },
    ...entryOverrides,
  };
}

export default buildStylelintConfig();
