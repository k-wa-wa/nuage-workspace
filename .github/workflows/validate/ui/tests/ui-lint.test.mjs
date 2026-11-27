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

describe("nuage ui-validate", () => {
  it("stylelint CLI で CSS の生カラー・未ラップ :hover を検出し、ENTRY_CSS・EXCLUDE・disable コメントを尊重する", () => {
    const dir = createFixture({
      "src/index.css": ":root { --bg: #191816; --a: rgba(96,165,250,0.08); }\n.entry:hover { opacity: 0.9; }\n",
      "src/app.css": [
        ".hex { color: #ffffff; }",
        ".named { color: red; }",
        ".fn { background: rgba(0, 0, 0, 0.5); border-color: hsl(210, 50%, 50%); }",
        "/* stylelint-disable-next-line color-no-hex */",
        ".ok { color: #191816; }",
        "@media (hover: hover) { .ok:hover { color: var(--fg); } }",
      ].join("\n"),
      "legacy/old.css": ".old { color: #000; }\n",
      "src/a.test.css": ".t { color: #000; }\n",
      "node_modules/pkg/x.css": ".m { color: red; }\n",
    });
    const fail = spawnSync(STYLELINT_BIN, ["**/*.css", "--config", STYLELINT_CFG, "--allow-empty-input"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, ENTRY_CSS: "src/index.css", EXCLUDE: "legacy/**" },
    });
    assert.equal(fail.status, 2);
    assert.match(fail.stderr, /src\/index\.css[\s\S]*defensive-css\/no-accidental-hover/);
    assert.doesNotMatch(fail.stderr, /src\/index\.css[\s\S]*color-no-hex/);
    for (const r of ["color-no-hex", "color-named", "function-disallowed-list"]) assert.match(fail.stderr, new RegExp(r));
    assert.doesNotMatch(fail.stderr, /legacy\/old\.css|a\.test\.css|node_modules/);

    const okDir = createFixture({ "src/index.css": ":root { --bg: #191816; }\n@media (hover: hover) { a:hover { opacity: 0.8; } }\n" });
    const pass = spawnSync(STYLELINT_BIN, ["**/*.css", "--config", STYLELINT_CFG, "--allow-empty-input"], {
      cwd: okDir, encoding: "utf8", env: { ...process.env, ENTRY_CSS: "src/index.css" },
    });
    assert.equal(pass.status, 0);
  });

  it("check-tsx-colors で style={{}}・Tailwind 任意値の生カラーを検出し、除外と ignore コメントを尊重する", () => {
    const dir = createFixture({
      "src/Card.tsx": [
        "export function Card() {",
        '  return <div className="bg-[#191816] hover:text-[#ffffff]" style={{ color: "#e8e4dc" }}>',
        '    <span style={{\n      backgroundColor: "rgba(0, 0, 0, 0.5)",\n    }} />',
        '    <p className="border-[#2f2d29]" style={{ color: "#fff" }} /> {/* nuage-ui-ignore-color */}',
        "    {/* nuage-ui-ignore-color */}",
        '    <p className="ring-[#60a5fa]" />',
        '    <div style={{ color: "var(--fg)" }}>Issue #123<style>{`.x:hover{color:#fff}`}</style></div>',
        "  </div>;",
        "}",
      ].join("\n"),
      "app/manifest.ts": 'export const m = { theme_color: "#191816" };\n',
      "src/Card.test.tsx": 'export const x = <div className="bg-[#fff]" />;\n',
      "legacy/Old.tsx": 'export const y = <div style={{ color: "#000" }} />;\n',
    });
    const { files, violations } = checkTsxColors(dir, ["legacy/**"]);
    assert.deepEqual(files, ["src/Card.tsx"]);
    assert.equal(violations.length, 4);

    const fail = spawnSync(process.execPath, [TSX_CLI, dir], { encoding: "utf8", env: { ...process.env, EXCLUDE: "legacy/**" } });
    assert.equal(fail.status, 1);
    assert.match(fail.stdout, /src\/Card\.tsx:2:.*nuage-ui\/no-raw-color/);

    const pass = spawnSync(process.execPath, [TSX_CLI, dir], { encoding: "utf8", env: { ...process.env, EXCLUDE: "legacy/**,src/Card.tsx" } });
    assert.equal(pass.status, 0);
  });
});
