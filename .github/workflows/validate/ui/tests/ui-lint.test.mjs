import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { checkTsxColors } from "../check-tsx-colors.mjs";

const UI_DIR = path.resolve(import.meta.dirname, "..");
const STYLELINT_BIN = path.join(UI_DIR, "node_modules/.bin/stylelint");
const STYLELINT_CFG = path.join(UI_DIR, "stylelint.config.mjs");
const STYLELINT_IGN = path.join(UI_DIR, ".stylelintignore");
const TSX_CLI = path.join(UI_DIR, "check-tsx-colors.mjs");

const tmpRoots = [];
function createFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuage-ui-lint-"));
  tmpRoots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return dir;
}
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

const runStylelint = (cwd, env = {}) => spawnSync(
  STYLELINT_BIN, ["**/*.css", "--config", STYLELINT_CFG, "--ignore-path", STYLELINT_IGN, "--formatter", "json", "--allow-empty-input"],
  { cwd, encoding: "utf8", env: { ...process.env, ...env } },
);

describe("nuage ui-validate", () => {
  it("stylelint CLI で CSS の違反・disable コメント・.stylelintignore 無視・ENTRY_CSS（[id]・REPO_ROOT）・EXCLUDE を厳密検証する", () => {
    const dir = createFixture({
      ".stylelintignore": "**/*.css\n",
      "frontend/app/[id]/globals.css": ":root { --bg: #191816; }\n.entry:hover { opacity: 0.9; }\n",
      "frontend/app/i/globals.css": [
        ".hex { color: #ffffff; }",
        ".named { color: red; }",
        ".fn { background: rgba(0, 0, 0, 0.5); border-color: hsl(210, 50%, 50%); }",
        "/* stylelint-disable-next-line color-no-hex */",
        ".ok { color: #191816; }",
        "@media (hover: hover) { .ok:hover { color: var(--fg); } }",
      ].join("\n"),
      "frontend/legacy/old.css": ".old { color: #000; }\n",
      "frontend/src/legacy/keep.css": ".keep { color: #000; }\n",
      "frontend/app/admin/page.css": ".adm { color: #000; }\n",
      "frontend/src/a.test.css": ".t { color: #000; }\n",
      "frontend/node_modules/pkg/x.css": ".m { color: red; }\n",
    });
    const fe = path.join(dir, "frontend");
    const fail = runStylelint(fe, { ENTRY_CSS: "frontend/app/[id]/globals.css", REPO_ROOT: dir, EXCLUDE: "legacy,app/admin/*" });
    assert.equal(fail.status, 2);
    const hits = JSON.parse(fail.stderr).flatMap((r) => r.warnings.map((w) => `${path.relative(fe, r.source)}:${w.line}:${w.rule}`)).sort();
    assert.deepEqual(hits, [
      "app/[id]/globals.css:2:defensive-css/no-accidental-hover",
      "app/i/globals.css:1:color-no-hex",
      "app/i/globals.css:2:color-named",
      "app/i/globals.css:3:function-disallowed-list",
      "app/i/globals.css:3:function-disallowed-list",
      "src/legacy/keep.css:1:color-no-hex",
    ]);
    assert.equal(runStylelint(fe, { ENTRY_CSS: "app/missing.css" }).status, 1);

    const ok = createFixture({ "src/index.css": ":root { --bg: #191816; }\n@media (hover: hover) { a:hover { opacity: 0.8; } }\n" });
    assert.equal(runStylelint(ok, { ENTRY_CSS: "src/index.css" }).status, 0);
  });

  it("check-tsx-colors で境界・コメント/テキスト誤検知・ignore スコープ・除外範囲・CLI 起動を検証する", () => {
    const dir = createFixture({
      "src/Card.tsx": [
        "const t = `multi\nstyle={{ color: '#111' }}`;",
        "export function Card() {",
        "  return <div>",
        "    <p>Use bg-[#222] here, it's fine</p>{/* bg-[#333] */}",
        '    <svg style={{ fill: "url(#abc)" }} /><div data-style={{ color: "#444" }} />',
        '    <div style={ { color: "#555" } } /><span className="text-[color:#666]" />',
        "    <div style={\n      {\n        /* }} */\n        color: \"#777\"\n      }\n    } />",
        '    <p title="nuage-ui-ignore-color" className="bg-[#888]" />',
        '    <p className="bg-[#999]" /> {/* nuage-ui-ignore-color */}',
        '    <p className="bg-[#aaa]" />',
        "    {/* nuage-ui-ignore-color */}",
        '    <p className="bg-[#bbb]" />',
        "  </div>;",
        "}",
      ].join("\n"),
      ".hidden/Dot.TSX": 'export const d = <div className="bg-[#ccc]" />;\n',
      "src/legacy/Keep.tsx": 'export const k = <div style={{ color: "#ddd" }} />;\n',
      "legacy/Drop.tsx": 'export const l = <div style={{ color: "#000" }} />;\n',
      "app/admin/page.tsx": 'export const a = <div style={{ color: "#000" }} />;\n',
      "src/Card.test.tsx": 'export const x = <div className="bg-[#fff]" />;\n',
    });
    fs.mkdirSync(path.join(dir, "src/Dir.tsx"));
    fs.symlinkSync(path.join(dir, "src/Card.tsx"), path.join(dir, "src/Link.tsx"));

    const { files, violations } = checkTsxColors(dir, ["legacy", "app/*"]);
    assert.deepEqual(files, [".hidden/Dot.TSX", "src/Card.tsx", "src/legacy/Keep.tsx"]);
    assert.deepEqual(violations.map((v) => `${v.file}:${v.line}:${v.message}`), [
      '.hidden/Dot.TSX:1:Unexpected Tailwind arbitrary color class "bg-[#ccc]".',
      'src/Card.tsx:7:Unexpected raw color "#555" in inline style.',
      'src/Card.tsx:7:Unexpected Tailwind arbitrary color class "text-[color:#666]".',
      'src/Card.tsx:11:Unexpected raw color "#777" in inline style.',
      'src/Card.tsx:14:Unexpected Tailwind arbitrary color class "bg-[#888]".',
      'src/Card.tsx:16:Unexpected Tailwind arbitrary color class "bg-[#aaa]".',
      'src/legacy/Keep.tsx:1:Unexpected raw color "#ddd" in inline style.',
    ]);

    const jpCli = path.join(dir, "空白 日本語/check.mjs");
    fs.mkdirSync(path.dirname(jpCli), { recursive: true });
    fs.copyFileSync(TSX_CLI, jpCli);
    assert.equal(spawnSync(process.execPath, [jpCli, dir], { encoding: "utf8", env: { ...process.env, EXCLUDE: "legacy,app/*" } }).status, 2);
    assert.equal(spawnSync(process.execPath, [TSX_CLI, dir], { encoding: "utf8", env: { ...process.env, EXCLUDE: "legacy,app/*,.hidden,src/Card.tsx,src/legacy" } }).status, 0);
    assert.equal(spawnSync(process.execPath, [TSX_CLI, path.join(dir, "missing")], { encoding: "utf8" }).status, 1);
  });
});
