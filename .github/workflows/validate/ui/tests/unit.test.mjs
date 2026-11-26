import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { runUiLint } from "../lint.mjs";

const tempDirs = [];

function createTempProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nuage-ui-unit-"));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

function createValidEntryCss(extra = "") {
  return `
:root {
  --bg: #191816;
  --fg: #e8e4dc;
  --card: #211f1c;
  --line: #2f2d29;
  --muted: #98928a;
  --accent: #60a5fa;
  --warn: #e0a08a;
  --success: #10b981;
  --blocked: #f59e0b;
  --font-sans: sans-serif;
  --font-mono: monospace;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 14px;
  --radius-full: 9999px;
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-snappy: ease-out;
  --duration-press: 0.08s;
  --duration-release: 0.35s;
  --scale-button-active: 0.94;
  --scale-icon-active: 0.88;
}

* {
  -webkit-tap-highlight-color: transparent;
}

button:focus:not(:focus-visible) {
  outline: none;
}

button:focus-visible {
  outline: 2px solid var(--accent);
}

button {
  user-select: none;
  touch-action: manipulation;
}

@media (max-width: 768px) {
  input,
  textarea,
  select {
    font-size: 16px;
  }
}
${extra}
`;
}

after(() => {
  for (const d of tempDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("raw color prohibition", () => {
  it("allows raw colors inside entry CSS :root and @theme, and rejects outside", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(`
@theme {
  --color-accent: #60a5fa;
}
.bad-rule {
  color: #ffffff;
}
`),
      "styles/other.css": `
:root {
  --local-bad: #123456;
  --local-rgb: rgba(255, 0, 0, 0.5);
}
.svg-bg {
  fill: url(#my-gradient);
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.deepEqual(
      res.violations.map((v) => [v.file, v.rule]),
      [
        ["app/globals.css", "color-no-hex"],
        ["styles/other.css", "color-no-hex"],
        ["styles/other.css", "function-disallowed-list"],
      ],
    );
  });

  it("detects exact counts and positions in <style>, inline style={{}}, Tailwind arbitrary values, and JS literals while avoiding false positives", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(),
      "components/Sample.tsx": `
import "./helper";
// #ff0000 in comment should be ignored
/* rgba(0, 0, 0, 0.5) in comment should be ignored */
export function Sample({ url, tag }: { url: string; tag: string }) {
  const themeColor = "#191816";
  const aframe = "dotsColor: #60a5fa; backgroundColor: rgb(25, 24, 22)";
  const safeUrl = \`\${url}#toolbar=0\`;
  const safeId = "#vr-video";
  return (
    <div
      className="bg-[#211f1c] text-[rgba(232,228,220,0.9)] border-[#2f2d29] fill-[#fff] stroke-[#000]"
      style={{ color: "hsl(210, 50%, 50%)", borderColor: "hsla(0, 0%, 100%, 0.2)", fill: "url(#fff)" }}
    >
      <a href="/rgb(1,2,3)">link</a>
      <span>#123</span>
      <style>{\`
        .chip {
          color: var(--fg);
          background: \${
            "var(--card)"
          };
          border-color: #60a5fa;
        }
      \`}</style>
    </div>
  );
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.deepEqual(
      res.violations.map((v) => [v.line, v.column, v.rule]),
      [
        [6, 23, "nuage-ui/no-raw-color"],
        [7, 30, "nuage-ui/no-raw-color"],
        [7, 56, "nuage-ui/no-raw-color"],
        [12, 22, "nuage-ui/no-raw-color"],
        [12, 37, "nuage-ui/no-raw-color"],
        [12, 68, "nuage-ui/no-raw-color"],
        [12, 83, "nuage-ui/no-raw-color"],
        [12, 97, "nuage-ui/no-raw-color"],
        [13, 24, "nuage-ui/no-raw-color"],
        [13, 59, "nuage-ui/no-raw-color"],
        [23, 25, "color-no-hex"],
      ],
    );
  });

  it("supports nuage-ui-ignore-color and stylelint-disable-next-line opt-out on exact lines only", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(`
.ignored-inline { color: #fff; /* nuage-ui-ignore-color */ }
/* nuage-ui-ignore-color */
.ignored-prev { color: rgba(0, 0, 0, 0.5); }
/* stylelint-disable-next-line color-no-hex */
.ignored-stylelint { color: #abc; }
.multiline-grad {
  background: linear-gradient(
    rgba(255, 0, 0, 0.5), /* nuage-ui-ignore-color */
    to right,
    rgb(0, 0, 0)
  );
}
`),
      "app/manifest.ts": `
export const manifest = {
  theme_color: "#191816", // nuage-ui-ignore-color
  // nuage-ui-ignore-color
  background_color: "#191816",
};
`,
      "components/Box.tsx": `
export function Box() {
  return (
    <>
      {/* nuage-ui-ignore-color */}
      <div className="bg-[#191816]" />
      <div title="nuage-ui-ignore-color" style={{ color: "#fff" }} />
      <style>{\`
        .ok { color: #fff; /* nuage-ui-ignore-color */ }
      \`}</style>
    </>
  );
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.deepEqual(
      res.violations.map((v) => [v.file, v.line, v.rule]),
      [
        ["app/globals.css", 60, "function-disallowed-list"],
        ["components/Box.tsx", 7, "nuage-ui/no-raw-color"],
      ],
    );
  });
});

describe("defensive-css/no-accidental-hover", () => {
  it("requires :hover in CSS and <style> (including uppercase, any-hover, mixed :not(:hover), and conditional JSX) to be wrapped inside @media (hover: hover)", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(`
.bad:hover {
  opacity: 0.9;
}
.upper:HOVER {
  opacity: 0.9;
}
.mixed:hover, .other:not(:hover) {
  opacity: 0.9;
}
@media (hover: none) {
  .wrong-media:hover {
    opacity: 0.8;
  }
}
@media (
  hover:
  none
) {
  .wrong-multiline-media:hover {
    opacity: 0.8;
  }
}
@media (any-hover: none) {
  .wrong-any-hover:hover {
    opacity: 0.8;
  }
}
@media (hover: hover) and (pointer: fine) {
  .good:hover {
    opacity: 0.9;
  }
}
`),
      "components/Card.tsx": `
export function Card({ enabled }: { enabled: boolean }) {
  return (
    <div>
      <style>{\`
        @media (hover: hover) {
          .card:hover { border-color: var(--accent); }
        }
        .card-bad:hover { border-color: var(--warn); }
      \`}</style>
      <style>{enabled ? ".cond-bad:hover { opacity: 0.8; }" : ""}</style>
    </div>
  );
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.deepEqual(
      res.violations.map((v) => [v.file, v.line, v.rule]),
      [
        ["app/globals.css", 51, "defensive-css/no-accidental-hover"],
        ["app/globals.css", 54, "defensive-css/no-accidental-hover"],
        ["app/globals.css", 57, "defensive-css/no-accidental-hover"],
        ["app/globals.css", 61, "defensive-css/no-accidental-hover"],
        ["app/globals.css", 69, "defensive-css/no-accidental-hover"],
        ["app/globals.css", 74, "defensive-css/no-accidental-hover"],
        ["components/Card.tsx", 9, "defensive-css/no-accidental-hover"],
        ["components/Card.tsx", 11, "defensive-css/no-accidental-hover"],
      ],
    );
  });

  it("supports nuage-ui-ignore-hover (including inside rule block) and stylelint-disable-next-line opt-out", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(`
/* nuage-ui-ignore-hover */
.ignored-prev:hover { opacity: 0.8; }
.ignored-same:hover { /* nuage-ui-ignore-hover */
  opacity: 0.8;
}
.ignored-inside:hover {
  /* nuage-ui-ignore-hover */
  opacity: 0.8;
}
/* stylelint-disable-next-line defensive-css/no-accidental-hover */
.ignored-stylelint:hover { opacity: 0.8; }
`),
      "components/Button.tsx": `
export function Button() {
  return (
    <>
      {/* nuage-ui-ignore-hover */}
      <style>{\`.btn-inline:hover { opacity: 0.9; }\`}</style>
      <style>{\`
        /* nuage-ui-ignore-hover */
        .btn-prev:hover { opacity: 0.9; }
        .btn-same:hover { opacity: 0.9; } /* nuage-ui-ignore-hover */
      \`}</style>
    </>
  );
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.equal(res.violations.length, 0);
  });
});

describe("nuage-ui/entry-css-guardrails", () => {
  it("detects missing tokens, invalid focus-visible (outline: 0px), and non-subject mobile selectors", async () => {
    const dir = createTempProject({
      "app/globals.css": `
:root {
  --bg: #191816;
}
button:focus-visible {
  outline: 0px;
}
@media (max-width: 768px) {
  input + div, textarea + div, select + div {
    font-size: 16px;
  }
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    const messages = res.violations.map((v) => v.message).join("\n");
    assert.match(messages, /必須 CSS 変数が不足/);
    assert.match(messages, /--scale-icon-active/);
    assert.match(messages, /-webkit-tap-highlight-color: transparent/);
    assert.match(messages, /:focus:not\(:focus-visible\)/);
    assert.match(messages, /:focus-visible/);
    assert.match(messages, /user-select: none/);
    assert.match(messages, /touch-action: manipulation/);
    assert.match(messages, /input, textarea, select/);
  });

  it("accepts 1rem inside @media (max-width: 640px)", async () => {
    const css = createValidEntryCss().replace("font-size: 16px;", "font-size: 1rem;").replace("max-width: 768px", "max-width: 640px");
    const dir = createTempProject({
      "app/globals.css": css,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.equal(res.violations.length, 0);
  });
});

describe("exclude and file discovery handling", () => {
  it("scans hidden directories and uppercase extensions while excluding default and directory-glob patterns", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(),
      ".agents/skills/gen.ts": `export const c = "#fff";`,
      "components/Upper.TSX": `export const c = "#fff";`,
      "styles/Upper.CSS": `.u { color: #fff; }`,
      "components/Button.test.tsx": `export const x = "#fff";`,
      "components/Button.stories.tsx": `export const x = "#fff";`,
      "e2e/home.spec.ts": `export const x = "#fff";`,
      "mocks/handlers.ts": `export const x = "#fff";`,
      ".storybook/preview.tsx": `export const x = "#fff";`,
      "vite.config.ts": `export const x = "#fff";`,
      "src/generated-v2/old.tsx": `export const x = "#fff";`,
    });

    const resWithDefaultOnly = await runUiLint({
      targetDir: dir,
      entryCss: "app/globals.css",
    });
    assert.deepEqual(
      resWithDefaultOnly.violations.map((v) => v.file),
      [
        ".agents/skills/gen.ts",
        "components/Upper.TSX",
        "src/generated-v2/old.tsx",
        "styles/Upper.CSS",
      ],
    );

    const resWithExclude = await runUiLint({
      targetDir: dir,
      entryCss: "app/globals.css",
      excludes: ["generated-*", ".agents", "*.TSX", "*.CSS"],
    });
    assert.equal(resWithExclude.violations.length, 0);
  });
});

describe("review regression guards", () => {
  it("ignores .stylelintignore in cwd and still validates CSS files", async () => {
    const dir = createTempProject({
      ".stylelintignore": "app/globals.css\nstyles/bad.css\n",
      "app/globals.css": createValidEntryCss(),
      "styles/bad.css": ".x { color: #fff; }\n",
    });

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
      assert.equal(res.violations.length, 1);
      assert.equal(res.violations[0].file, "styles/bad.css");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("handles token-backed rgba with whitespace/newlines, string url( in content, and syntax errors in entry CSS", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(`
.token-alpha {
  background: rgba( var(--accent-rgb), 0.1 );
  border-color: rgba(
    var(--accent-rgb),
    0.5
  );
  color: hsl( var(--fg-hsl) );
}
.raw-rgb-var-alpha {
  color: rgba(255, 0, 0, var(--alpha));
}
.string-url-parens {
  content: "url(";
  color: #fff;
  --text: ")";
}
`),
      "components/Dynamic.tsx": `
export function Dynamic({ on }: { on: boolean }) {
  const label = "Issue #123";
  const anchor = "#cafe";
  const feed = "#feed";
  return (
    <div>
      <a href="#add">{label} {anchor} {feed}</a>
      <span style={{ color: "#add" }}>ok</span>
      <style>{\`
        .a { color: \${on ? "#fff" : "#000"}; }
      \`}</style>
    </div>
  );
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.deepEqual(
      res.violations.map((v) => [v.file, v.line, v.rule]),
      [
        ["app/globals.css", 60, "function-disallowed-list"],
        ["app/globals.css", 64, "color-no-hex"],
        ["components/Dynamic.tsx", 9, "nuage-ui/no-raw-color"],
        ["components/Dynamic.tsx", 11, "nuage-ui/no-raw-color"],
        ["components/Dynamic.tsx", 11, "nuage-ui/no-raw-color"],
      ],
    );
  });

  it("reports CssSyntaxError in entry CSS without aborting other files", async () => {
    const dir = createTempProject({
      "app/globals.css": `:root { --bg: #191816;`,
      "components/Bad.tsx": `export const x = "#fff";\n`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.deepEqual(
      res.violations.map((v) => [v.file, v.rule]),
      [
        ["app/globals.css", "CssSyntaxError"],
        ["components/Bad.tsx", "nuage-ui/no-raw-color"],
      ],
    );
  });

  it("does not suppress an entire <style> block with a single preceding ignore comment", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(),
      "components/MultiHover.tsx": `
export function MultiHover() {
  return (
    <div>
      {/* nuage-ui-ignore-hover */}
      <style>{\`
        .c:hover { opacity: 0.8; }
        .d:hover { opacity: 0.7; }
      \`}</style>
    </div>
  );
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.deepEqual(
      res.violations.map((v) => v.line),
      [7, 8],
    );
  });
});
