import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { checkTsxColors } from "../check-tsx-colors.mjs";
import { runUiLint } from "../lint.mjs";

const UI_DIR = path.resolve(import.meta.dirname, "..");
const LINT_CLI = path.join(UI_DIR, "lint.mjs");
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

const runLintCli = (env = {}) => spawnSync(process.execPath, [LINT_CLI], { cwd: UI_DIR, encoding: "utf8", env: { ...process.env, ...env } });

describe("nuage ui-validate", () => {
  it("lint.mjs で CSS 走査範囲・entry-css 優先/候補解決・stylelint 名パス・symlink 境界・CssSyntaxError 分離を検証する", async () => {
    const dir = createFixture({
      "repo-stylelint/frontend/app/[id]/globals.css": ":root { --bg: #191816; }\n.entry:hover { opacity: 0.9; }\n",
      "repo-stylelint/frontend/components/app/globals.css/placeholder.txt": "",
      "repo-stylelint/frontend/components/.stylelintrc.js": 'throw new Error("UNTRUSTED_CONFIG_EXECUTED");\n',
      "repo-stylelint/frontend/components/.stylelintignore": "**/*.css\n",
      "repo-stylelint/frontend/components/.internal/Theme.CSS": ".hex { color: #ffffff; }\n",
      "repo-stylelint/frontend/components/app.css": [
        ".named { color: red; }",
        ".fn { background: rgba(0, 0, 0, 0.5); border-color: hsl(210, 50%, 50%); }",
        "/* stylelint-disable-next-line color-no-hex */",
        ".ok { color: #191816; }",
        "@media (hover: hover) { .ok:hover { color: var(--fg); } }",
      ].join("\n"),
      "repo-stylelint/frontend/components/legacy/old.css": ".old { color: #000; }\n",
      "repo-stylelint/frontend/components/src/legacy/keep.css": ".keep { color: #000; }\n",
      "repo-stylelint/frontend/components/app/admin/page.css": ".adm { color: #000; }\n",
      "repo-stylelint/frontend/components/src/a.test.css": ".t { color: #000; }\n",
      "repo-stylelint/frontend/components/node_modules/pkg/x.css": ".m { color: red; }\n",
      "outside/secret.css": ".sec { color: #fff; }\n",
    });
    const repo = path.join(dir, "repo-stylelint");
    const comp = path.join(repo, "frontend/components");
    fs.mkdirSync(path.join(comp, "dir.css"));
    fs.symlinkSync(path.join(comp, "app.css"), path.join(comp, "link.css"));
    fs.symlinkSync(path.join(dir, "outside"), path.join(repo, "escape-dir"));
    fs.symlinkSync(path.join(dir, "outside/secret.css"), path.join(repo, "escape.css"));

    const res = await runUiLint({ targetDir: "frontend/components", repoRoot: repo, entryCss: "frontend/app/[id]/globals.css", excludes: ["legacy", "app/admin/*"] });
    assert.deepEqual(res.violations.map((v) => `${v.file}:${v.line}:${v.rule}`), [
      "../app/[id]/globals.css:2:defensive-css/no-accidental-hover",
      ".internal/Theme.CSS:1:color-no-hex",
      "app.css:1:color-named",
      "app.css:2:function-disallowed-list",
      "app.css:2:function-disallowed-list",
      "src/legacy/keep.css:1:color-no-hex",
    ]);

    // entry-css が exclude に一致しても :hover 検査は維持する & 親ディレクトリ名に stylelint を含む呼び出し
    const exclEntry = await runUiLint({ targetDir: "frontend/app/[id]", repoRoot: repo, entryCss: "globals.css", excludes: ["globals.css"] });
    assert.deepEqual(exclEntry.violations.map((v) => `${v.file}:${v.line}:${v.rule}`), ["globals.css:2:defensive-css/no-accidental-hover"]);
    const namedRun = runLintCli({ TARGET_DIR: "frontend/app/[id]", REPO_ROOT: repo, ENTRY_CSS: "globals.css", FAIL_ON_POLICY: "false" });
    assert.equal(namedRun.status, 0);
    assert.match(namedRun.stdout, /::warning::/);

    // target-dir 側がディレクトリでも REPO_ROOT 側の実ファイルを選ぶ
    fs.mkdirSync(path.join(repo, "app"), { recursive: true });
    fs.writeFileSync(path.join(repo, "app/globals.css"), ":root { --bg: #191816; }\n.x:hover { opacity: 0.5; }\n");
    const disambig = await runUiLint({ targetDir: "frontend/components", repoRoot: repo, entryCss: "app/globals.css" });
    assert.ok(disambig.violations.some((v) => v.file === "../../app/globals.css" && v.rule === "defensive-css/no-accidental-hover"));

    const synDir = createFixture({ "bad.css": ".card { color:\n" });
    assert.equal(runLintCli({ TARGET_DIR: synDir, FAIL_ON_POLICY: "false" }).status, 1);
    assert.equal(runLintCli({ TARGET_DIR: path.join(dir, "missing"), FAIL_ON_POLICY: "false" }).status, 1);
    assert.equal(runLintCli({ TARGET_DIR: "frontend/components", REPO_ROOT: repo, ENTRY_CSS: "missing.css", FAIL_ON_POLICY: "false" }).status, 1);
    assert.equal(runLintCli({ TARGET_DIR: "escape-dir", REPO_ROOT: repo, FAIL_ON_POLICY: "false" }).status, 1);
    assert.equal(runLintCli({ TARGET_DIR: "frontend/components", REPO_ROOT: repo, ENTRY_CSS: "escape.css", FAIL_ON_POLICY: "false" }).status, 1);

    const ok = createFixture({ "src/index.css": ":root { --bg: #191816; }\n@media (hover: hover) { a:hover { opacity: 0.8; } }\n" });
    assert.equal(runLintCli({ TARGET_DIR: ok, ENTRY_CSS: "src/index.css" }).status, 0);
  });

  it("check-tsx-colors で有効構文・配列/ASI・表示文言分離・ignore 境界・走査範囲を検証する", () => {
    const dir = createFixture({
      "src/Default.tsx": 'export default <div style={{ color: "#abc" }} />;\n',
      "src/Generic.tsx": 'export const G = <Foo<Item> style={{ color: "#abc" }} />;\n',
      "src/FnGeneric.tsx": 'export const F = <Widget<() => string> style={{ color: "#abc" }} />;\n',
      "src/Classes.tsx": [
        'const classes = ["base", "bg-[#abc]"];',
        'const className = "panel"',
        'const title = "Use bg-[#def] here"',
        'export const C = <div className={classes.join(" ")} title={title} />;',
      ].join("\n"),
      "src/Card.tsx": [
        "const t = `multi\nstyle={{ color: '#111' }}`;",
        "export function Card() {",
        "  return <div>",
        "    <p>(it's ok) Use bg-[#222] here</p>{/* bg-[#333] */}",
        '    <p title="Use bg-[#444] here" /><div>{"Use bg-[#555] here"}</div>',
        '    <svg style={{ fill: "url(#abc)" }} /><div data-style={{ color: "#666" }} />',
        '    <div style={ { color: "#777" } } /><span className="text-[color:#888]" />',
        "    <div style={{ /* nuage-ui-ignore-color */ color: \"#999\" }} />",
        '    <div className={cn("bg-[#aaa]")} style={{ /* nuage-ui-ignore-colorful */ color: "#bbb" }} />',
        '    <p title="nuage-ui-ignore-color" className="bg-[#ccc]" />',
        '    <p className="bg-[#ddd]" /> {/* nuage-ui-ignore-color */}',
        "    {/* nuage-ui-ignore-color */}",
        '    <p className="bg-[#eee]" />',
        "  </div>;",
        "}",
      ].join("\n"),
      ".hidden/Dot.TSX": 'export const d = <div className="bg-[#123]" />;\n',
      "src/legacy/Keep.tsx": 'export const k = <div style={{ color: "#456" }} />;\n',
      "legacy/Drop.tsx": 'export const l = <div style={{ color: "#000" }} />;\n',
      "app/admin/page.tsx": 'export const a = <div style={{ color: "#000" }} />;\n',
      "src/Card.test.tsx": 'export const x = <div className="bg-[#fff]" />;\n',
    });
    fs.mkdirSync(path.join(dir, "src/Dir.tsx"));
    fs.symlinkSync(path.join(dir, "src/Card.tsx"), path.join(dir, "src/Link.tsx"));

    const { files, violations } = checkTsxColors(dir, ["legacy", "app/*"]);
    assert.deepEqual(files, [".hidden/Dot.TSX", "src/Card.tsx", "src/Classes.tsx", "src/Default.tsx", "src/FnGeneric.tsx", "src/Generic.tsx", "src/legacy/Keep.tsx"]);
    assert.deepEqual(violations.map((v) => `${v.file}:${v.line}:${v.message}`), [
      '.hidden/Dot.TSX:1:Unexpected Tailwind arbitrary color class "bg-[#123]".',
      'src/Card.tsx:8:Unexpected raw color "#777" in inline style.',
      'src/Card.tsx:8:Unexpected Tailwind arbitrary color class "text-[color:#888]".',
      'src/Card.tsx:9:Unexpected raw color "#999" in inline style.',
      'src/Card.tsx:10:Unexpected Tailwind arbitrary color class "bg-[#aaa]".',
      'src/Card.tsx:10:Unexpected raw color "#bbb" in inline style.',
      'src/Card.tsx:11:Unexpected Tailwind arbitrary color class "bg-[#ccc]".',
      'src/Classes.tsx:1:Unexpected Tailwind arbitrary color class "bg-[#abc]".',
      'src/Default.tsx:1:Unexpected raw color "#abc" in inline style.',
      'src/FnGeneric.tsx:1:Unexpected raw color "#abc" in inline style.',
      'src/Generic.tsx:1:Unexpected raw color "#abc" in inline style.',
      'src/legacy/Keep.tsx:1:Unexpected raw color "#456" in inline style.',
    ]);

    const jpCli = path.join(dir, "空白 日本語/check.mjs");
    fs.mkdirSync(path.dirname(jpCli), { recursive: true });
    fs.copyFileSync(TSX_CLI, jpCli);
    assert.equal(spawnSync(process.execPath, [jpCli, dir], { encoding: "utf8", env: { ...process.env, EXCLUDE: "legacy,app/*" } }).status, 2);
    assert.equal(spawnSync(process.execPath, [TSX_CLI, dir], { encoding: "utf8", env: { ...process.env, EXCLUDE: "legacy,app/*,.hidden,src/Card.tsx,src/Classes.tsx,src/Default.tsx,src/FnGeneric.tsx,src/Generic.tsx,src/legacy" } }).status, 0);
  });
});
