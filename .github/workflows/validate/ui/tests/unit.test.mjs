import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { runUiLint } from "../lint.mjs";

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

after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("nuage ui-validate", () => {
  it("CSS の生カラー（#hex, named, rgb/hsl）と未ラップ :hover を検出し、stylelint-disable-next-line を除外する", async () => {
    const dir = createFixture({
      "src/app.css": [
        ".bad-hex { color: #ffffff; }",
        ".bad-named { color: red; }",
        ".bad-fn { background: rgba(0, 0, 0, 0.5); border-color: hsl(210, 50%, 50%); }",
        ".bad-hover:hover { opacity: 0.8; }",
        "/* stylelint-disable-next-line color-no-hex */",
        ".ok-disabled { color: #191816; }",
        "@media (hover: hover) { .ok-hover:hover { color: var(--fg); } }",
      ].join("\n"),
    });

    const res = await runUiLint({ targetDir: dir });
    assert.deepEqual(
      res.violations.map((v) => `${v.line}:${v.rule}`),
      [
        "1:color-no-hex",
        "2:color-named",
        "3:function-disallowed-list",
        "3:function-disallowed-list",
        "4:defensive-css/no-accidental-hover",
      ],
    );
  });

  it("--entry-css 指定時は同ファイルのみ色ルールを除外し、defensive-css/no-accidental-hover は維持する", async () => {
    const dir = createFixture({
      "src/index.css": [
        ":root { --bg: #191816; --accent-subtle: rgba(96, 165, 250, 0.08); }",
        ".entry-hover:hover { opacity: 0.9; }",
      ].join("\n"),
      "src/other.css": ".other { color: #ffffff; }\n",
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "src/index.css" });
    assert.deepEqual(
      res.violations.map((v) => `${v.file}:${v.line}:${v.rule}`),
      [
        "src/index.css:2:defensive-css/no-accidental-hover",
        "src/other.css:1:color-no-hex",
      ],
    );
  });

  it("TSX/JSX の style={{}} 内および Tailwind 任意値クラスの生カラーを検出し、nuage-ui-ignore-color を除外する", async () => {
    const dir = createFixture({
      "src/Card.tsx": [
        "export function Card() {",
        "  return (",
        '    <div className="bg-[#191816] hover:text-[#ffffff]" style={{ color: "#e8e4dc" }}>',
        "      <span",
        "        style={{",
        '          backgroundColor: "rgba(0, 0, 0, 0.5)",',
        '          borderColor: "hsl(210, 50%, 50%)",',
        "        }}",
        "      />",
        '      <p className="border-[#2f2d29]" style={{ color: "#fff" }} /> {/* nuage-ui-ignore-color */}',
        "      {/* nuage-ui-ignore-color */}",
        '      <p className="ring-[#60a5fa]" />',
        '      <div style={{ color: "var(--fg)" }}>Issue #123</div>',
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    });

    const res = await runUiLint({ targetDir: dir });
    assert.deepEqual(
      res.violations.map((v) => `${v.line}:${v.rule}:${v.message}`),
      [
        '3:nuage-ui/no-raw-color:Unexpected Tailwind arbitrary color class "bg-[#191816]".',
        '3:nuage-ui/no-raw-color:Unexpected Tailwind arbitrary color class "text-[#ffffff]".',
        '3:nuage-ui/no-raw-color:Unexpected raw color "#e8e4dc" in inline style.',
        '6:nuage-ui/no-raw-color:Unexpected raw color "rgba(" in inline style.',
        '7:nuage-ui/no-raw-color:Unexpected raw color "hsl(" in inline style.',
      ],
    );
  });

  it("<style>{...}</style>・一般 JS 文字列・.ts ファイル・テスト/除外ディレクトリは対象外とする", async () => {
    const dir = createFixture({
      "app/manifest.ts": 'export default function manifest() { return { theme_color: "#191816" }; }\n',
      "components/VrViewer.tsx": [
        "export function VrViewer() {",
        '  const attr = "dotsColor: #60a5fa";',
        "  return <div data-attr={attr}><style>{`.bad:hover { color: #fff; }`}</style></div>;",
        "}",
      ].join("\n"),
      "components/Card.test.tsx": 'export const x = <div className="bg-[#fff]" style={{ color: "#000" }} />;\n',
      ".nuage-workspace-policies/.github/workflows/validate/ui/bad.css": ".x { color: #fff; }\n",
      "legacy/old.css": ".old { color: #fff; }\n",
    });

    const res = await runUiLint({ targetDir: dir, excludes: ["legacy/**"] });
    assert.equal(res.violations.length, 0);
    assert.equal(res.checkedFilesCount, 1);
  });
});
