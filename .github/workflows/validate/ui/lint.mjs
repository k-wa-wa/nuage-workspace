#!/usr/bin/env node
/**
 * Nuage UI 設計標準の共通 lint エントリポイント
 *
 * 【検証する 3 つのルールと背景】
 * 1. 生カラー直書き禁止（color-no-hex / declaration-property-value-disallowed-list / nuage-ui/no-raw-color）:
 *    ダークテーマ専用設計を一貫して保つため、エントリ CSS の :root / @theme 外での
 *    #hex / rgb() / rgba() / hsl() / hsla() 直書きを禁止する（rgba(var(...), ...) 等は許可。
 *    例外は nuage-ui-ignore-color または stylelint-disable-next-line）。
 * 2. :hover の @media (hover: hover) ラップ必須（defensive-css/no-accidental-hover）:
 *    タッチデバイスでの :hover 残留を防ぐため、:hover セレクタを @media (hover: hover) 内に限定する
 *    （例外は nuage-ui-ignore-hover または stylelint-disable-next-line）。
 * 3. エントリ CSS の必須トークン・モバイル/アクセシビリティガードレール（nuage-ui/entry-css-guardrails）:
 *    必須 21 トークン、-webkit-tap-highlight-color: transparent、:focus:not(:focus-visible) 抑止 +
 *    :focus-visible 定義、user-select: none + touch-action: manipulation、およびモバイル幅での
 *    input / textarea / select に対する font-size >= 16px（iOS Safari 自動ズーム防止）を検証する。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import postcss from "postcss";
import stylelint from "stylelint";
import stylelintConfig from "./stylelint.config.mjs";
import {
  IGNORE_COLOR_TOKEN,
  IGNORE_HOVER_TOKEN,
  analyzeScriptFile,
  hasIgnoreComment,
} from "./tsx-scanner.mjs";

const RULE_ENTRY_CSS_GUARDRAILS = "nuage-ui/entry-css-guardrails";

const REQUIRED_CSS_VARS = [
  "--bg", "--fg", "--card", "--line", "--muted",
  "--accent", "--warn", "--success", "--blocked",
  "--font-sans", "--font-mono",
  "--radius-sm", "--radius-md", "--radius-lg", "--radius-full",
  "--ease-spring", "--ease-snappy", "--duration-press", "--duration-release",
  "--scale-button-active", "--scale-icon-active",
];

const DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "out", "coverage",
  "e2e", "mocks", "public", ".git", ".storybook",
  "tests", "__tests__", "__mocks__", "playwright-report", "test-results", "storybook-static",
]);

const DEFAULT_EXCLUDED_FILE_REGEX = /\.(?:test|spec|stories|config)\.[^/]+$|\.d\.ts$/i;

const STYLELINT_IGNORE_TOKEN = {
  "color-no-hex": IGNORE_COLOR_TOKEN,
  "declaration-property-value-disallowed-list": IGNORE_COLOR_TOKEN,
  "defensive-css/no-accidental-hover": IGNORE_HOVER_TOKEN,
};

const toPosix = (p) => p.split(path.sep).join("/");

const parseListValue = (raw) =>
  raw ? raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : [];

function normalizeExcludes(patterns) {
  return patterns.map((raw) => {
    const pattern = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    return { pattern, hasWildcard: /[*?]/.test(pattern) };
  });
}

function matchesUserExclude(relPath, excludes, isDir) {
  return excludes.some(({ pattern, hasWildcard }) => {
    if (!hasWildcard) {
      return relPath === pattern || relPath.startsWith(`${pattern}/`);
    }
    if (isDir) {
      return path.matchesGlob(relPath, pattern);
    }
    return path.matchesGlob(relPath, pattern) ||
      (!pattern.includes("/") && path.matchesGlob(path.posix.basename(relPath), pattern));
  });
}

function collectTargetFiles(targetDir, rawExcludes) {
  const excludes = normalizeExcludes(rawExcludes);
  const entries = fs.globSync("**/*.{css,ts,tsx,js,jsx}", {
    cwd: targetDir,
    withFileTypes: true,
    exclude: (entry) => {
      const isDir = typeof entry !== "string" && entry.isDirectory();
      const name = typeof entry === "string" ? path.basename(entry) : entry.name;
      const fullPath = typeof entry === "string"
        ? path.resolve(targetDir, entry)
        : path.join(entry.parentPath ?? entry.path ?? targetDir, name);
      const relPath = toPosix(path.relative(targetDir, fullPath));
      if (isDir) {
        return DEFAULT_EXCLUDED_DIRS.has(name) || matchesUserExclude(relPath, excludes, true);
      }
      return (
        (typeof entry !== "string" && entry.isSymbolicLink()) ||
        DEFAULT_EXCLUDED_FILE_REGEX.test(relPath) ||
        matchesUserExclude(relPath, excludes, false)
      );
    },
  });

  const cssFiles = [];
  const scriptFiles = [];
  const paths = entries
    .filter((e) => e.isFile() && !e.isSymbolicLink())
    .map((e) => path.join(e.parentPath ?? e.path ?? targetDir, e.name))
    .sort((a, b) => a.localeCompare(b));

  for (const fullPath of paths) {
    if (fullPath.toLowerCase().endsWith(".css")) {
      cssFiles.push(fullPath);
    } else {
      scriptFiles.push(fullPath);
    }
  }
  return { cssFiles, scriptFiles };
}

function resolveEntryCssPath(targetDir, rawEntryCss) {
  if (!rawEntryCss) return null;
  const candidates = path.isAbsolute(rawEntryCss)
    ? [rawEntryCss]
    : [path.resolve(targetDir, rawEntryCss), path.resolve(process.cwd(), rawEntryCss)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.realpathSync(candidate);
    }
  }
  return { missing: rawEntryCss };
}

function isInsideRootOrTheme(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === "atrule" && cur.name.toLowerCase() === "theme") return true;
    if (cur.type === "rule" && cur.selector.split(",").some((s) => s.trim() === ":root")) {
      return true;
    }
  }
  return false;
}

function maskNonHoverMediaAndUrls(css) {
  return css
    .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\(\s*hover\s*:\s*(?!hover\s*\))/gi, "(h0ver:");
}

function maskThemeColorDeclarations(root) {
  const cloned = root.clone();
  cloned.walkDecls((decl) => {
    if (!isInsideRootOrTheme(decl)) return;
    const rawVal = decl.raws.value?.raw ?? decl.value;
    const newlines = "\n".repeat((rawVal.match(/\n/g) || []).length);
    decl.value = `var(--nuage-masked)${newlines}`;
    decl.raws.value = undefined;
  });
  return cloned.toString();
}

function parseFontSizePx(value) {
  const cleaned = value.replace(/!important/gi, "").trim().toLowerCase();
  const single = /^([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)$/.exec(cleaned);
  if (single) {
    const num = Number.parseFloat(single[1]);
    return single[2] === "px" ? num : num * 16;
  }
  const maxMatch = /^max\((.+)\)$/.exec(cleaned);
  if (!maxMatch) return null;
  const valid = maxMatch[1].split(",").map(parseFontSizePx).filter((n) => n !== null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

function isMobileWidthMediaQuery(params) {
  const normalized = params.trim().toLowerCase();
  for (const re of [
    /\bmax-width\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\b/g,
    /\bwidth\s*<=\s*([0-9]+(?:\.[0-9]+)?)\s*(px|rem|em)\b/g,
  ]) {
    let m;
    while ((m = re.exec(normalized)) !== null) {
      const px = Number.parseFloat(m[1]) * (m[2] === "px" ? 1 : 16);
      if (px >= 480 && px <= 1024) return true;
    }
  }
  return false;
}

function checkEntryCssGuardrails(root, file) {
  const definedVars = new Set();
  const flags = {
    tapHighlight: false,
    focusSuppression: false,
    focusVisible: false,
    userSelectNone: false,
    touchActionManipulation: false,
  };
  const mobileFormFontSizes = { input: false, textarea: false, select: false };

  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    const val = decl.value.replace(/!important/gi, "").trim().toLowerCase();
    if (decl.prop.startsWith("--") && isInsideRootOrTheme(decl)) definedVars.add(decl.prop);
    if (
      prop === "-webkit-tap-highlight-color" &&
      (val === "transparent" || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(val))
    ) {
      flags.tapHighlight = true;
    }
    if (prop === "user-select" && val === "none") flags.userSelectNone = true;
    if (prop === "touch-action" && val === "manipulation") flags.touchActionManipulation = true;
  });

  root.walkRules((rule) => {
    const decls = (rule.nodes ?? []).filter((n) => n.type === "decl");
    const norm = (d) => [d.prop.toLowerCase(), d.value.replace(/!important/gi, "").trim().toLowerCase()];

    if (/:focus\s*:not\(\s*:focus-visible\s*\)/i.test(rule.selector)) {
      if (
        decls.some((d) => {
          const [p, v] = norm(d);
          return (
            (p === "outline" && (v === "none" || v === "0" || v === "0px")) ||
            (p === "outline-style" && v === "none") ||
            (p === "outline-width" && (v === "0" || v === "0px"))
          );
        })
      ) {
        flags.focusSuppression = true;
      }
    }

    const withoutNot = rule.selector.replace(/:not\(\s*:focus-visible\s*\)/gi, "");
    if (/:focus-visible\b/i.test(withoutNot)) {
      if (
        decls.some((d) => {
          const [p, v] = norm(d);
          return (
            (p === "outline" || p === "outline-style" || p === "outline-color" || p === "box-shadow") &&
            v !== "none" &&
            v !== "0"
          );
        })
      ) {
        flags.focusVisible = true;
      }
    }
  });

  root.walkAtRules("media", (atRule) => {
    if (!isMobileWidthMediaQuery(atRule.params)) return;
    atRule.walkRules((rule) => {
      const has16px = (rule.nodes ?? []).some((n) => {
        if (n.type !== "decl" || n.prop.toLowerCase() !== "font-size") return false;
        const px = parseFontSizePx(n.value);
        return px !== null && px >= 16;
      });
      if (!has16px) return;
      for (const part of rule.selector.split(",")) {
        for (const tag of ["input", "textarea", "select"]) {
          if (new RegExp(`(?:^|[\\s>+~])${tag}(?=$|[:.\\[#\\s>+~])`, "i").test(part.trim())) {
            mobileFormFontSizes[tag] = true;
          }
        }
      }
    });
  });

  const messages = [];
  const missingVars = REQUIRED_CSS_VARS.filter((v) => !definedVars.has(v));
  if (missingVars.length > 0) {
    messages.push(`エントリ CSS に必須 CSS 変数が不足している: ${missingVars.join(", ")}`);
  }

  const requiredFlags = [
    ["tapHighlight", "エントリ CSS に '-webkit-tap-highlight-color: transparent' が定義されていない。"],
    ["focusSuppression", "エントリ CSS に ':focus:not(:focus-visible)' でのアウトライン抑止（outline: none / 0）が定義されていない。"],
    ["focusVisible", "エントリ CSS に ':focus-visible' のフォーカス表示定義が不足している。"],
    ["userSelectNone", "エントリ CSS に 'user-select: none' が定義されていない。"],
    ["touchActionManipulation", "エントリ CSS に 'touch-action: manipulation' が定義されていない。"],
  ];
  for (const [key, msg] of requiredFlags) {
    if (!flags[key]) messages.push(msg);
  }

  const missingMobile = ["input", "textarea", "select"].filter((tag) => !mobileFormFontSizes[tag]);
  if (missingMobile.length > 0) {
    messages.push(
      `エントリ CSS のモバイル幅メディアクエリ（例: @media (max-width: 768px)）内に ${missingMobile.join(", ")} の 'font-size: 16px' 以上が定義されていない（iOS Safari 自動ズーム防止）。`,
    );
  }

  return messages.map((message) => ({
    file,
    line: 1,
    column: 1,
    rule: RULE_ENTRY_CSS_GUARDRAILS,
    message,
  }));
}

async function lintCssWithStylelint(css, lines, relFile, lineOffset = 0) {
  // 呼び出し元リポジトリの .stylelintignore に影響されないよう、ファイルパスではなく code として渡す
  const result = await stylelint.lint({
    code: maskNonHoverMediaAndUrls(css),
    config: stylelintConfig,
  });

  const violations = [];
  for (const res of result.results) {
    for (const warn of res.warnings) {
      const mappedLine = lineOffset + (warn.line ?? 1);
      const ignoreToken = STYLELINT_IGNORE_TOKEN[warn.rule];
      if (ignoreToken && hasIgnoreComment(lines, mappedLine, ignoreToken)) {
        continue;
      }
      violations.push({
        file: relFile,
        line: mappedLine,
        column: warn.column ?? 1,
        rule: warn.rule,
        message: warn.text.replace(/\s*\([^)]+\)\s*$/, ""),
      });
    }
  }
  return violations;
}

/**
 * 指定ディレクトリに対して UI 設計標準 lint を実行し、結果オブジェクトを返す。
 *
 * @param {{ targetDir: string, entryCss?: string, excludes?: string[] }} params
 */
export async function runUiLint({ targetDir, entryCss = "", excludes = [] }) {
  const resolvedTargetDir = fs.realpathSync(path.resolve(targetDir));
  const resolvedEntry = resolveEntryCssPath(resolvedTargetDir, entryCss);
  if (resolvedEntry && typeof resolvedEntry === "object" && resolvedEntry.missing) {
    throw new Error(`Entry CSS file '${resolvedEntry.missing}' does not exist.`);
  }
  const entryCssPath = resolvedEntry;

  const { cssFiles, scriptFiles } = collectTargetFiles(resolvedTargetDir, excludes);
  const realCssFiles = cssFiles.map((f) => fs.realpathSync(f));
  const nonEntryCssFiles = entryCssPath
    ? realCssFiles.filter((f) => f !== entryCssPath)
    : realCssFiles;

  const violations = [];
  const checkedSet = new Set([...realCssFiles, ...scriptFiles]);
  if (entryCssPath) checkedSet.add(entryCssPath);

  const toRel = (absPath) =>
    toPosix(path.relative(resolvedTargetDir, absPath)) || path.basename(absPath);

  if (entryCssPath) {
    const entryCode = fs.readFileSync(entryCssPath, "utf8");
    const rel = toRel(entryCssPath);
    const root = postcss.parse(entryCode);
    violations.push(...checkEntryCssGuardrails(root, rel));
    violations.push(
      ...(await lintCssWithStylelint(
        maskThemeColorDeclarations(root),
        entryCode.split(/\r?\n/),
        rel,
      )),
    );
  }

  for (const cssPath of nonEntryCssFiles) {
    const cssCode = fs.readFileSync(cssPath, "utf8");
    violations.push(
      ...(await lintCssWithStylelint(cssCode, cssCode.split(/\r?\n/), toRel(cssPath))),
    );
  }

  for (const scriptPath of scriptFiles) {
    const content = fs.readFileSync(scriptPath, "utf8");
    const rel = toRel(scriptPath);
    const { lines, styleBlocks, colorViolations } = analyzeScriptFile(scriptPath, content);
    for (const v of colorViolations) {
      violations.push({ file: rel, ...v });
    }
    for (const block of styleBlocks) {
      violations.push(
        ...(await lintCssWithStylelint(block.css, lines, rel, block.startLine - 1)),
      );
    }
  }

  violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.rule.localeCompare(b.rule),
  );

  return {
    targetDir: resolvedTargetDir,
    entryCssPath,
    checkedFilesCount: checkedSet.size,
    violations,
  };
}

function parseArgs(argv) {
  const opts = {
    targetDir: process.env.TARGET_DIR || "",
    entryCss: process.env.ENTRY_CSS || "",
    excludes: parseListValue(process.env.EXCLUDE || ""),
    failOnPolicy: process.env.FAIL_ON_POLICY || "true",
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readVal = (flag) => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      if (i + 1 >= argv.length) throw new Error(`${flag} requires a value.`);
      i += 1;
      return argv[i];
    };

    if (arg === "--target-dir" || arg.startsWith("--target-dir=")) {
      opts.targetDir = readVal("--target-dir");
    } else if (arg === "--entry-css" || arg.startsWith("--entry-css=")) {
      opts.entryCss = readVal("--entry-css");
    } else if (arg === "--exclude" || arg.startsWith("--exclude=")) {
      opts.excludes.push(...parseListValue(readVal("--exclude")));
    } else if (arg === "--fail-on-policy" || arg.startsWith("--fail-on-policy=")) {
      opts.failOnPolicy = readVal("--fail-on-policy");
    } else if (arg === "--json") {
      opts.json = true;
    } else if (!arg.startsWith("-")) {
      if (opts.targetDir) throw new Error(`Unexpected positional argument: ${arg}`);
      opts.targetDir = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function writeStepSummary({ targetDirLabel, entryCssLabel, failOnPolicy, checkedFilesCount, violations }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const lines = [
    "### UI Design Standard Validation",
    "",
    `- \`target-dir\`: \`${targetDirLabel}\``,
    `- \`entry-css\`: \`${entryCssLabel || "(none)"}\``,
    `- \`fail-on-policy\`: \`${failOnPolicy}\``,
    `- \`files-checked\`: \`${checkedFilesCount}\``,
    `- \`violations\`: \`${violations.length}\``,
    "",
  ];
  if (violations.length === 0) {
    lines.push("✅ すべての UI 設計標準チェックを通過した。");
  } else {
    lines.push("```text");
    for (const v of violations) lines.push(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
    lines.push("```");
    if (!failOnPolicy) {
      lines.push("", "> [!WARNING]", "> UI ポリシー違反が検出されたが `fail-on-policy: false` のため警告のみで通過させた。");
    }
  }
  fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (!opts.targetDir) {
    console.error("❌ No target directory specified.");
    process.exit(1);
  }
  if (!fs.existsSync(opts.targetDir) || !fs.statSync(opts.targetDir).isDirectory()) {
    console.error(`❌ Target directory '${opts.targetDir}' does not exist or is not a directory.`);
    process.exit(1);
  }
  if (opts.failOnPolicy !== "true" && opts.failOnPolicy !== "false") {
    console.error(`❌ Invalid boolean value for FAIL_ON_POLICY: '${opts.failOnPolicy}' (expected 'true' or 'false').`);
    process.exit(1);
  }
  const failOnPolicy = opts.failOnPolicy === "true";

  let result;
  try {
    result = await runUiLint({ targetDir: opts.targetDir, entryCss: opts.entryCss, excludes: opts.excludes });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const targetDirLabel = opts.targetDir;
  const entryCssLabel = result.entryCssPath
    ? toPosix(path.relative(result.targetDir, result.entryCssPath)) || opts.entryCss
    : opts.entryCss;

  writeStepSummary({
    targetDirLabel,
    entryCssLabel,
    failOnPolicy,
    checkedFilesCount: result.checkedFilesCount,
    violations: result.violations,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("========================================");
    console.log(`UI Validation: ${targetDirLabel}`);
    if (entryCssLabel) console.log(`Entry CSS    : ${entryCssLabel}`);
    console.log(`Files checked: ${result.checkedFilesCount}`);
    console.log("========================================");

    if (result.violations.length === 0) {
      console.log("✅ 0 violations found.");
    } else {
      for (const v of result.violations) {
        console.log(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
      }
      console.log(`\nFound ${result.violations.length} UI policy violation(s).`);
    }
  }

  if (result.violations.length > 0) {
    if (failOnPolicy) {
      console.error("❌ UI design standard violations detected.");
      process.exit(1);
    }
    console.log("⚠️ UI design standard violations detected, but fail-on-policy=false so continuing with warnings.");
  }
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);

if (isMain) main();
