#!/usr/bin/env node

// Post-commit review - reviews all changed files in the latest commit
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

const LANG_MAP = {
  ".js": "javascript", ".mjs": "javascript", ".ts": "typescript",
  ".tsx": "typescript", ".py": "python", ".cs": "csharp",
  ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby",
  ".php": "php", ".cpp": "cpp", ".c": "c",
};

const SKIP = ["package.json", "package-lock.json", ".env", ".env.example", ".gitignore"];

mkdirSync(LOGS_DIR, { recursive: true });

// Get commit hash
const commitHash = process.argv[2] || execSync("git rev-parse HEAD", { cwd: REPO_DIR }).toString().trim();
const shortHash = commitHash.substring(0, 7);
const commitMsg = execSync(`git log -1 --format=%s ${commitHash}`, { cwd: REPO_DIR }).toString().trim();
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

try {
  log("info", "Connecting to MCP server...");
  await client.connect(transport);
  log("info", "Connected.");

  let criticalCount = 0;
  let warningCount = 0;

  for (let i = 0; i < codeFiles.length; i++) {
    const file = codeFiles[i];
    const lang = LANG_MAP[extname(file)];
    log("info", `--- Reviewing file ${i + 1}/${codeFiles.length}: ${file} (${lang}) ---`);

    let code;
    try {
      code = readFileSync(join(REPO_DIR, file), "utf8");
    } catch (e) {
      log("warning", `Cannot read ${file}: ${e.message} (might be deleted)`);
      continue;
    }

    if (code.trim().length === 0) {
      log("info", `${file}: empty, skipping`);
      continue;
    }

    const startTime = Date.now();
    const result = await client.callTool(
      {
        name: "orchestrate_review",
        arguments: { code, language: lang, focus: "bugs" },
      },
      undefined,
      { timeout: 180000 }
    );
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const text = result.content?.[0]?.text || "";
    const hasCritical = /\b(CRITICAL|severe|security vulnerability|injection|XSS|SQL injection)\b/i.test(text);
    const hasBugs = /\b(bug|logic error|crash|undefined|null pointer|race condition)\b/i.test(text);

    if (hasCritical) {
      criticalCount++;
      log("error", `${file}: CRITICAL issues found (${elapsed}s)`);
    } else if (hasBugs) {
      warningCount++;
      log("warning", `${file}: Potential bugs found (${elapsed}s)`);
    } else {
      log("info", `${file}: Clean (${elapsed}s)`);
    }

    // Write detailed review to commit-specific log
    appendFileSync(commitLog, `\n--- Detailed Review: ${file} ---\n`);
    appendFileSync(commitLog, text.substring(0, 3000) + "\n");
  }

  // Summary
  log("info", "");
  log("info", "========== REVIEW SUMMARY ==========");
  log("info", `Commit:    ${shortHash} - ${commitMsg}`);
  log("info", `Files:     ${codeFiles.length} reviewed`);
  log("info", `Critical:  ${criticalCount}`);
  log("info", `Warnings:  ${warningCount}`);
  log("info", `Clean:     ${codeFiles.length - criticalCount - warningCount}`);
  log("info", `Full log:  ${commitLog}`);

  if (criticalCount > 0) {
    log("error", ">>> ACTION REQUIRED: Critical issues found! Consider reverting or fixing. <<<");
  } else if (warningCount > 0) {
    log("warning", ">>> Minor issues found. Review recommended. <<<");
  } else {
    log("info", ">>> All files passed review. <<<");
  }

  log("info", "====================================");

  await client.close();
  process.exit(criticalCount > 0 ? 1 : 0);
} catch (e) {
  log("error", `Review failed: ${e.message}`);
  try { await client.close(); } catch {}
  process.exit(1);
}
