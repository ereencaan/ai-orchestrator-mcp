#!/usr/bin/env node

// Post-commit review + auto-fix pipeline
// Reviews all changed files, if critical issues found → auto-fix → re-review (max 3 cycles)
// Writes live logs to logs/ directory with tail-friendly output
// Usage: node post-commit-review.mjs [commit-hash]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { extname, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, "..");
const LOGS_DIR = join(REPO_DIR, "logs");
const LATEST_LOG = join(LOGS_DIR, "latest.log");
const MAX_FIX_CYCLES = 3;

const LANG_MAP = {
  ".js": "javascript", ".mjs": "javascript", ".ts": "typescript",
  ".tsx": "typescript", ".py": "python", ".cs": "csharp",
  ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby",
  ".php": "php", ".cpp": "cpp", ".c": "c",
};

const SKIP = ["package.json", "package-lock.json", ".env", ".env.example", ".gitignore"];

mkdirSync(LOGS_DIR, { recursive: true });

// Get commit hash
const rawHash = process.argv[2] || execSync("git rev-parse HEAD", { cwd: REPO_DIR }).toString().trim();
const commitHash = rawHash.replace(/[^a-f0-9]/g, "");
const shortHash = commitHash.substring(0, 7);
const commitMsg = execSync("git log -1 --format=%s " + commitHash, { cwd: REPO_DIR }).toString().trim();
const commitLog = join(LOGS_DIR, `review-${shortHash}.log`);

function timestamp() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function log(level, message) {
  const line = `[${timestamp()}] [${level.toUpperCase().padEnd(7)}] ${message}`;
  console.log(line);
  appendFileSync(commitLog, line + "\n");
  appendFileSync(LATEST_LOG, line + "\n");
}

// Get changed files in commit
const changedFiles = execSync(
  `git diff-tree --no-commit-id --name-only -r ${commitHash}`,
  { cwd: REPO_DIR }
).toString().trim().split("\n").filter(Boolean);

const codeFiles = changedFiles.filter((f) => {
  const name = f.split(/[/\\]/).pop();
  if (SKIP.includes(name)) return false;
  return LANG_MAP[extname(f)] !== undefined;
});

// Initialize log files
writeFileSync(commitLog, "");
appendFileSync(LATEST_LOG, `\n${"=".repeat(70)}\n`);

log("info", `Post-commit review started`);
log("info", `Commit: ${shortHash} - ${commitMsg}`);
log("info", `Changed files: ${changedFiles.length} total, ${codeFiles.length} code files`);

if (codeFiles.length === 0) {
  log("info", "No code files to review. Done.");
  process.exit(0);
}

// Connect to MCP server
const NODE_PATH = process.execPath;
const transport = new StdioClientTransport({
  command: NODE_PATH,
  args: [join(REPO_DIR, "index.js")],
  cwd: REPO_DIR,
});

const client = new Client(
  { name: "post-commit-reviewer", version: "1.0" },
  { capabilities: {} }
);

// Listen for live logs from MCP server
client.setNotificationHandler(
  LoggingMessageNotificationSchema,
  (notification) => {
    const { level, data } = notification.params;
    const stage = data?.stage || "";
    const msg = data?.message || "";
    const elapsed = data?.elapsed != null ? `+${(data.elapsed / 1000).toFixed(1)}s` : "";
    log(level, `  [MCP ${elapsed.padStart(7)}] ${stage.padEnd(14)} ${msg}`);
  }
);

// --- Helper: review a single file ---
async function reviewFile(client, filePath, lang) {
  let code;
  try {
    code = readFileSync(join(REPO_DIR, filePath), "utf8");
  } catch (e) {
    log("warning", `Cannot read ${filePath}: ${e.message}`);
    return { status: "skip", text: "" };
  }
  if (code.trim().length === 0) {
    return { status: "skip", text: "" };
  }

  const startTime = Date.now();
  const result = await client.callTool(
    { name: "orchestrate_review", arguments: { code, language: lang, focus: "bugs" } },
    undefined,
    { timeout: 300000 }
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const text = result.content?.[0]?.text || "";

  const hasCritical = /\b(CRITICAL|severe|security vulnerability|injection|XSS|SQL injection)\b/i.test(text);
  const hasBugs = /\b(bug|logic error|crash|undefined|null pointer|race condition)\b/i.test(text);

  let status = "clean";
  if (hasCritical) status = "critical";
  else if (hasBugs) status = "warning";

  return { status, text, elapsed, code };
}

// --- Helper: extract issues from review text ---
function extractIssues(reviewText) {
  const issues = [];
  const lines = reviewText.split("\n");
  for (const line of lines) {
    if (/^\s*[-*]\s+\*\*/.test(line) || /^\s*\d+\.\s+\*\*/.test(line) || /CRITICAL|bug|vulnerability|injection|error/i.test(line)) {
      const clean = line.replace(/^\s*[-*\d.]+\s*/, "").trim();
      if (clean.length > 10 && clean.length < 500) issues.push(clean);
    }
  }
  return issues.slice(0, 10);
}

// --- Helper: auto-fix a file via orchestrate_refactor ---
async function autoFix(client, filePath, lang, code, issues) {
  const instructions = `Fix the following issues found by code review:\n${issues.map((i, n) => `${n + 1}. ${i}`).join("\n")}\n\nDo NOT change functionality. Only fix the reported issues.`;

  log("info", `  Auto-fix: sending to orchestrate_refactor...`);
  const startTime = Date.now();

  const result = await client.callTool(
    {
      name: "orchestrate_refactor",
      arguments: { code, language: lang, instructions },
    },
    undefined,
    { timeout: 600000 }
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const text = result.content?.[0]?.text || "";

  // Extract code block from pipeline result
  const codeMatch = text.match(/```[\w]*\n([\s\S]*?)```/);
  if (!codeMatch) {
    log("warning", `  Auto-fix: no code block in result (${elapsed}s)`);
    return null;
  }

  const fixedCode = codeMatch[1].trim();
  log("info", `  Auto-fix: received fixed code (${fixedCode.length} chars, ${elapsed}s)`);
  return fixedCode;
}

// --- Main ---
try {
  log("info", "Connecting to MCP server...");
  await client.connect(transport);
  log("info", "Connected.");

  let totalFixed = 0;
  let totalCritical = 0;
  let totalWarning = 0;
  let totalClean = 0;

  for (let i = 0; i < codeFiles.length; i++) {
    const file = codeFiles[i];
    const lang = LANG_MAP[extname(file)];
    log("info", `=== File ${i + 1}/${codeFiles.length}: ${file} (${lang}) ===`);

    // Review + fix cycle
    let lastStatus = "clean";
    for (let cycle = 1; cycle <= MAX_FIX_CYCLES + 1; cycle++) {
      const isReview = cycle === 1 ? "Initial review" : `Re-review after fix (cycle ${cycle - 1}/${MAX_FIX_CYCLES})`;
      log("info", `--- ${isReview} ---`);

      const review = await reviewFile(client, file, lang);

      if (review.status === "skip") {
        log("info", `${file}: skipped`);
        break;
      }

      lastStatus = review.status;

      // Log review result
      appendFileSync(commitLog, `\n--- ${isReview}: ${file} ---\n`);
      appendFileSync(commitLog, review.text.substring(0, 3000) + "\n");

      if (review.status === "clean") {
        log("info", `${file}: CLEAN (${review.elapsed}s)`);
        break;
      }

      if (review.status === "warning") {
        log("warning", `${file}: Minor issues found (${review.elapsed}s)`);
        // Don't auto-fix warnings, just report
        break;
      }

      // CRITICAL — attempt auto-fix
      log("error", `${file}: CRITICAL issues found (${review.elapsed}s)`);

      if (cycle > MAX_FIX_CYCLES) {
        log("error", `${file}: Max fix cycles (${MAX_FIX_CYCLES}) reached. Manual fix required.`);
        break;
      }

      // Extract issues and run auto-fix
      const issues = extractIssues(review.text);
      if (issues.length === 0) {
        log("warning", `${file}: Could not extract specific issues for auto-fix.`);
        break;
      }

      log("info", `${file}: Found ${issues.length} issues. Starting auto-fix cycle ${cycle}/${MAX_FIX_CYCLES}...`);

      const currentCode = readFileSync(join(REPO_DIR, file), "utf8");
      const fixedCode = await autoFix(client, file, lang, currentCode, issues);

      if (!fixedCode) {
        log("warning", `${file}: Auto-fix failed to produce code. Manual fix required.`);
        break;
      }

      // Write fixed code to file
      writeFileSync(join(REPO_DIR, file), fixedCode);
      log("info", `${file}: Fixed code written to disk. Re-reviewing...`);
      totalFixed++;

      // Loop continues → re-review
    }

    // Tally
    if (lastStatus === "critical") totalCritical++;
    else if (lastStatus === "warning") totalWarning++;
    else totalClean++;
  }

  // Auto-commit fixes if any files were fixed
  if (totalFixed > 0) {
    log("info", "");
    log("info", `>>> ${totalFixed} file(s) auto-fixed. Creating fix commit... <<<`);
    try {
      execSync("git add -A", { cwd: REPO_DIR });
      execSync(
        `git commit --no-verify -m "auto-fix: resolve critical issues from review of ${shortHash}"`,
        { cwd: REPO_DIR }
      );
      const newHash = execSync("git rev-parse --short HEAD", { cwd: REPO_DIR }).toString().trim();
      log("info", `Fix commit created: ${newHash}`);
    } catch (e) {
      log("warning", `Auto-commit failed: ${e.message} (no changes or git error)`);
    }
  }

  // Summary
  log("info", "");
  log("info", "========== REVIEW SUMMARY ==========");
  log("info", `Commit:      ${shortHash} - ${commitMsg}`);
  log("info", `Files:       ${codeFiles.length} reviewed`);
  log("info", `Critical:    ${totalCritical} (unfixed)`);
  log("info", `Warnings:    ${totalWarning}`);
  log("info", `Clean:       ${totalClean}`);
  log("info", `Auto-fixed:  ${totalFixed} file(s)`);
  log("info", `Full log:    ${commitLog}`);

  if (totalCritical > 0) {
    log("error", ">>> UNRESOLVED CRITICAL ISSUES — manual fix required <<<");
  } else if (totalFixed > 0) {
    log("info", ">>> All critical issues auto-fixed and committed <<<");
  } else if (totalWarning > 0) {
    log("warning", ">>> Minor issues found. Review recommended. <<<");
  } else {
    log("info", ">>> All files passed review <<<");
  }

  log("info", "====================================");

  await client.close();
  process.exit(totalCritical > 0 ? 1 : 0);
} catch (e) {
  log("error", `Review failed: ${e.message}`);
  try { await client.close(); } catch {}
  process.exit(1);
}
