#!/usr/bin/env node
/**
 * Nuage UI 設計標準の共通 lint エントリポイント
 *
 * 【検証する 3 つのルールと背景】
 * 1. 生カラー直書き禁止（nuage-ui/no-raw-color）:
 *    ダークテーマ専用設計を一貫して保つため、エントリ CSS の :root / @theme 外での
 *    #hex / rgb() / rgba() / hsl() / hsla() 直書きを禁止する（例外は nuage-ui-ignore-color）。
 * 2. :hover の @media (hover: hover) ラップ必須（nuage-ui/hover-media-query）:
 *    タッチデバイスでの :hover 残留を防ぐため、:hover セレクタを @media (hover: hover) 内に限定する
 *    （例外は nuage-ui-ignore-hover）。
 * 3. エントリ CSS の必須トークン・モバイル/アクセシビリティガードレール（nuage-ui/entry-css-guardrails）:
 *    必須 21 トークン、-webkit-tap-highlight-color: transparent、:focus:not(:focus-visible) 抑止 +
 *    :focus-visible 定義、user-select: none + touch-action: manipulation、およびモバイル幅での
 *    input / textarea / select に対する font-size >= 16px（iOS Safari 自動ズーム防止）を検証する。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import stylelint from "stylelint";
import {
  IGNORE_COLOR_TOKEN,
  IGNORE_HOVER_TOKEN,
  hasIgnoreComment,
} from "./rules.mjs";
import {
  RULE_HOVER_MEDIA_QUERY,
  RULE_NO_RAW_COLOR,
} from "./stylelint-plugin.mjs";
import { createStylelintConfig } from "./stylelint.config.mjs";
import { analyzeScriptFile } from "./tsx-scanner.mjs";

const DEFAULT_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "e2e",
  "mocks",
  "public",
  ".git",
  ".storybook",
  "tests",
  "__tests__",
  "__mocks__",
  "playwright-report",
  "test-results",
  "storybook-static",
]);

const DEFAULT_EXCLUDED_FILE_REGEXES = [
  /\.test\.[^/]+$/i,
  /\.spec\.[^/]+$/i,
  /\.stories\.[^/]+$/i,
  /\.config\.[^/]+$/i,
  /\.d\.ts$/i,
];

const CSS_EXTS = new Set([".css"]);
const SCRIPT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function parseListValue(raw) {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function globToRegExp(glob) {
  let regexStr = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
          continue;
        }
        regexStr += ".*";
        i += 2;
        continue;
      }
      regexStr += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
    i += 1;
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

function compileExcludeMatchers(patterns) {
  return patterns.map((rawPattern) => {
    const normalized = toPosix(rawPattern).replace(/^\.\//, "").replace(/\/+$/, "");
    const hasWildcard = /[*?]/.test(normalized);
    if (!hasWildcard) {
      return (relPath) =>
        relPath === normalized || relPath.startsWith(`${normalized}/`);
    }
    const re = globToRegExp(normalized);
    if (!normalized.includes("/")) {
      return (relPath) => re.test(relPath) || re.test(path.posix.basename(relPath));
    }
    return (relPath) => re.test(relPath);
  });
}

function isDefaultExcludedFile(relPath) {
  return DEFAULT_EXCLUDED_FILE_REGEXES.some((re) => re.test(relPath));
}

function collectTargetFiles(targetDir, excludeMatchers) {
  const cssFiles = [];
  const scriptFiles = [];

  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relPath = toPosix(path.relative(targetDir, fullPath));

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        if (excludeMatchers.some((fn) => fn(relPath))) {
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (isDefaultExcludedFile(relPath)) {
        continue;
      }
      if (excludeMatchers.some((fn) => fn(relPath))) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (CSS_EXTS.has(ext)) {
        cssFiles.push(fullPath);
      } else if (SCRIPT_EXTS.has(ext)) {
        scriptFiles.push(fullPath);
      }
    }
  }

  walk(targetDir);
  return { cssFiles, scriptFiles };
}

function resolveEntryCssPath(targetDir, rawEntryCss) {
  if (!rawEntryCss) return null;

  const candidates = [];
  if (path.isAbsolute(rawEntryCss)) {
    candidates.push(rawEntryCss);
  } else {
    candidates.push(path.resolve(targetDir, rawEntryCss));
    candidates.push(path.resolve(process.cwd(), rawEntryCss));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.realpathSync(candidate);
    }
  }
  return { missing: rawEntryCss };
}

function mapStylelintRuleToIgnoreToken(rule) {
  if (rule === RULE_NO_RAW_COLOR) return IGNORE_COLOR_TOKEN;
  if (rule === RULE_HOVER_MEDIA_QUERY) return IGNORE_HOVER_TOKEN;
  return null;
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
    if (arg === "--target-dir") {
      if (i + 1 >= argv.length) throw new Error("--target-dir requires a value.");
      opts.targetDir = argv[++i];
    } else if (arg.startsWith("--target-dir=")) {
      opts.targetDir = arg.slice("--target-dir=".length);
    } else if (arg === "--entry-css") {
      if (i + 1 >= argv.length) throw new Error("--entry-css requires a value.");
      opts.entryCss = argv[++i];
    } else if (arg.startsWith("--entry-css=")) {
      opts.entryCss = arg.slice("--entry-css=".length);
    } else if (arg === "--exclude") {
      if (i + 1 >= argv.length) throw new Error("--exclude requires a value.");
      opts.excludes.push(...parseListValue(argv[++i]));
    } else if (arg.startsWith("--exclude=")) {
      opts.excludes.push(...parseListValue(arg.slice("--exclude=".length)));
    } else if (arg === "--fail-on-policy") {
      if (i + 1 >= argv.length) throw new Error("--fail-on-policy requires a value.");
      opts.failOnPolicy = argv[++i];
    } else if (arg.startsWith("--fail-on-policy=")) {
      opts.failOnPolicy = arg.slice("--fail-on-policy=".length);
    } else if (arg === "--json") {
      opts.json = true;
    } else if (!arg.startsWith("-")) {
      if (!opts.targetDir) {
        opts.targetDir = arg;
      } else {
        throw new Error(`Unexpected positional argument: ${arg}`);
      }
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function formatSummaryMarkdown({
  targetDirLabel,
  entryCssLabel,
  failOnPolicy,
  checkedFilesCount,
  violations,
}) {
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
    for (const v of violations) {
      lines.push(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
    }
    lines.push("```");
    if (!failOnPolicy) {
      lines.push("");
      lines.push("> [!WARNING]");
      lines.push("> UI ポリシー違反が検出されたが `fail-on-policy: false` のため警告のみで通過させた。");
    }
  }
  lines.push("");
  return lines.join("\n");
}

function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, markdown, "utf8");
}

/**
 * 指定ディレクトリに対して UI 設計標準 lint を実行し、結果オブジェクトを返す。
 *
 * @param {{
 *   targetDir: string,
 *   entryCss?: string,
 *   excludes?: string[],
 * }} params
 */
export async function runUiLint({ targetDir, entryCss = "", excludes = [] }) {
  const resolvedTargetDir = fs.realpathSync(path.resolve(targetDir));
  const resolvedEntry = resolveEntryCssPath(resolvedTargetDir, entryCss);
  if (resolvedEntry && typeof resolvedEntry === "object" && resolvedEntry.missing) {
    throw new Error(`Entry CSS file '${resolvedEntry.missing}' does not exist.`);
  }
  const entryCssPath = resolvedEntry;

  const excludeMatchers = compileExcludeMatchers(excludes);
  const { cssFiles, scriptFiles } = collectTargetFiles(resolvedTargetDir, excludeMatchers);

  const realCssFiles = cssFiles.map((f) => fs.realpathSync(f));
  const nonEntryCssFiles = entryCssPath
    ? realCssFiles.filter((f) => f !== entryCssPath)
    : realCssFiles;

  const violations = [];
  const checkedSet = new Set([...realCssFiles, ...scriptFiles]);
  if (entryCssPath) {
    checkedSet.add(entryCssPath);
  }

  function toRel(absPath) {
    return toPosix(path.relative(resolvedTargetDir, absPath)) || path.basename(absPath);
  }

  // 1. エントリ CSS の検証（必須トークン・ガードレール + 生カラー例外 + :hover）
  if (entryCssPath) {
    const entryResult = await stylelint.lint({
      files: [entryCssPath],
      config: createStylelintConfig({ isEntryCss: true }),
    });
    for (const res of entryResult.results) {
      for (const warn of res.warnings) {
        violations.push({
          file: toRel(entryCssPath),
          line: warn.line ?? 1,
          column: warn.column ?? 1,
          rule: warn.rule,
          message: warn.text.replace(/\s*\([^)]+\)\s*$/, ""),
        });
      }
    }
  }

  // 2. 一般 CSS ファイルの検証
  if (nonEntryCssFiles.length > 0) {
    const cssResult = await stylelint.lint({
      files: nonEntryCssFiles,
      config: createStylelintConfig({ isEntryCss: false }),
    });
    for (const res of cssResult.results) {
      const rel = toRel(res.source);
      for (const warn of res.warnings) {
        violations.push({
          file: rel,
          line: warn.line ?? 1,
          column: warn.column ?? 1,
          rule: warn.rule,
          message: warn.text.replace(/\s*\([^)]+\)\s*$/, ""),
        });
      }
    }
  }

  // 3. TS / TSX / JS / JSX ファイルの検証
  const fragmentConfig = createStylelintConfig({ isEntryCss: false });
  for (const scriptPath of scriptFiles) {
    const content = fs.readFileSync(scriptPath, "utf8");
    const rel = toRel(scriptPath);
    const { lines, styleBlocks, colorViolations } = analyzeScriptFile(scriptPath, content);

    for (const v of colorViolations) {
      violations.push({
        file: rel,
        line: v.line,
        column: v.column,
        rule: RULE_NO_RAW_COLOR,
        message: v.message,
      });
    }

    for (const block of styleBlocks) {
      const lintRes = await stylelint.lint({
        code: block.css,
        config: fragmentConfig,
      });
      for (const res of lintRes.results) {
        for (const warn of res.warnings) {
          const mappedLine = block.startLine + (warn.line ?? 1) - 1;
          const ignoreToken = mapStylelintRuleToIgnoreToken(warn.rule);
          if (
            ignoreToken &&
            (hasIgnoreComment(lines, mappedLine, ignoreToken) ||
              hasIgnoreComment(lines, block.elementStartLine, ignoreToken))
          ) {
            continue;
          }
          violations.push({
            file: rel,
            line: mappedLine,
            column: warn.column ?? 1,
            rule: warn.rule,
            message: warn.text.replace(/\s*\([^)]+\)\s*$/, ""),
          });
        }
      }
    }
  }

  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.rule.localeCompare(b.rule);
  });

  return {
    targetDir: resolvedTargetDir,
    entryCssPath,
    checkedFilesCount: checkedSet.size,
    violations,
  };
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
    console.error(
      `❌ Invalid boolean value for FAIL_ON_POLICY: '${opts.failOnPolicy}' (expected 'true' or 'false').`,
    );
    process.exit(1);
  }
  const failOnPolicy = opts.failOnPolicy === "true";

  let result;
  try {
    result = await runUiLint({
      targetDir: opts.targetDir,
      entryCss: opts.entryCss,
      excludes: opts.excludes,
    });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const targetDirLabel = opts.targetDir;
  const entryCssLabel = result.entryCssPath
    ? toPosix(path.relative(result.targetDir, result.entryCssPath)) || opts.entryCss
    : opts.entryCss;

  writeStepSummary(
    formatSummaryMarkdown({
      targetDirLabel,
      entryCssLabel,
      failOnPolicy,
      checkedFilesCount: result.checkedFilesCount,
      violations: result.violations,
    }),
  );

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("========================================");
    console.log(`UI Validation: ${targetDirLabel}`);
    if (entryCssLabel) {
      console.log(`Entry CSS    : ${entryCssLabel}`);
    }
    console.log(`Files checked: ${result.checkedFilesCount}`);
    console.log("========================================");

    if (result.violations.length === 0) {
      console.log("✅ 0 violations found.");
    } else {
      for (const v of result.violations) {
        console.log(`${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`);
      }
      console.log("");
      console.log(`Found ${result.violations.length} UI policy violation(s).`);
    }
  }

  if (result.violations.length > 0) {
    if (failOnPolicy) {
      console.error("❌ UI design standard violations detected.");
      process.exit(1);
    } else {
      console.log(
        "⚠️ UI design standard violations detected, but fail-on-policy=false so continuing with warnings.",
      );
    }
  }
}

const isMain =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);

if (isMain) {
  main();
}
