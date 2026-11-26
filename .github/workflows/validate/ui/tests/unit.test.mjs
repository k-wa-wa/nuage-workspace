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

describe("nuage-ui/no-raw-color", () => {
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
}
.svg-bg {
  fill: url(#my-gradient);
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.equal(res.violations.length, 2);
    assert.deepEqual(
      res.violations.map((v) => [v.file, v.rule]),
      [
        ["app/globals.css", "nuage-ui/no-raw-color"],
        ["styles/other.css", "nuage-ui/no-raw-color"],
      ],
    );
  });

  it("detects raw colors in <style>, inline style={{}}, Tailwind arbitrary values, and JS literals while avoiding false positives", async () => {
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
      style={{ color: "hsl(210, 50%, 50%)", borderColor: "hsla(0, 0%, 100%, 0.2)" }}
    >
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
    const lines = res.violations.map((v) => v.line);
    // 6: #191816, 7: #60a5fa & rgb(...), 12: 5 Tailwind values, 13: hsl & hsla, 22: #60a5fa in <style>
    assert.ok(lines.includes(6));
    assert.ok(lines.includes(7));
    assert.ok(lines.includes(12));
    assert.ok(lines.includes(13));
    assert.ok(lines.includes(22));
    assert.ok(!lines.includes(8), "URL fragment should not be flagged");
    assert.ok(!lines.includes(9), "#vr-video should not be flagged");
    assert.ok(!lines.includes(15), "JSX text #123 should not be flagged");
  });

  it("supports nuage-ui-ignore-color on same line and preceding line", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(`
.ignored-inline { color: #fff; /* nuage-ui-ignore-color */ }
/* nuage-ui-ignore-color */
.ignored-prev { color: rgba(0, 0, 0, 0.5); }
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
      <style>{\`
        .ok { color: #fff; /* nuage-ui-ignore-color */ }
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

describe("nuage-ui/hover-media-query", () => {
  it("requires :hover in CSS and <style> to be wrapped inside @media (hover: hover)", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(`
.bad:hover {
  opacity: 0.9;
}
@media (hover: none) {
  .wrong-media:hover {
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
export function Card() {
  return (
    <div>
      <style>{\`
        @media (hover: hover) {
          .card:hover { border-color: var(--accent); }
        }
        .card-bad:hover { border-color: var(--warn); }
      \`}</style>
    </div>
  );
}
`,
    });

    const res = await runUiLint({ targetDir: dir, entryCss: "app/globals.css" });
    assert.equal(res.violations.length, 3);
    assert.equal(res.violations[0].file, "app/globals.css");
    assert.equal(res.violations[1].file, "app/globals.css");
    assert.equal(res.violations[2].file, "components/Card.tsx");
    assert.equal(res.violations[2].line, 9);
    assert.equal(res.violations[2].rule, "nuage-ui/hover-media-query");
  });

  it("supports nuage-ui-ignore-hover opt-out", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(`
/* nuage-ui-ignore-hover */
.ignored-prev:hover { opacity: 0.8; }
.ignored-same:hover { /* nuage-ui-ignore-hover */
  opacity: 0.8;
}
`),
      "components/Button.tsx": `
export function Button() {
  return (
    <>
      {/* nuage-ui-ignore-hover */}
      <style>{\`
        .btn:hover { opacity: 0.9; }
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
  it("detects missing tokens, accessibility rules, and mobile font-size < 16px", async () => {
    const dir = createTempProject({
      "app/globals.css": `
:root {
  --bg: #191816;
}
@media (max-width: 768px) {
  input, textarea {
    font-size: 14px;
  }
  select {
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
    assert.match(messages, /input, textarea/);
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

describe("exclude handling", () => {
  it("excludes default directories/suffixes and custom --exclude patterns", async () => {
    const dir = createTempProject({
      "app/globals.css": createValidEntryCss(),
      "components/Button.test.tsx": `export const x = "#fff";`,
      "components/Button.stories.tsx": `export const x = "#fff";`,
      "e2e/home.spec.ts": `export const x = "#fff";`,
      "mocks/handlers.ts": `export const x = "#fff";`,
      ".storybook/preview.tsx": `export const x = "#fff";`,
      "vite.config.ts": `export const x = "#fff";`,
      "legacy/old.tsx": `export const x = "#fff";`,
    });

    const resWithDefaultOnly = await runUiLint({
      targetDir: dir,
      entryCss: "app/globals.css",
    });
    assert.equal(resWithDefaultOnly.violations.length, 1);
    assert.equal(resWithDefaultOnly.violations[0].file, "legacy/old.tsx");

    const resWithExclude = await runUiLint({
      targetDir: dir,
      entryCss: "app/globals.css",
      excludes: ["legacy"],
    });
    assert.equal(resWithExclude.violations.length, 0);
  });
});
