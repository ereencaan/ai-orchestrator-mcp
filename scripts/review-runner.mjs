#!/usr/bin/env node

// Review runner - calls orchestrate_review via MCP protocol
// Used by: Claude Code hooks, git pre-commit hook
// Usage: node review-runner.mjs <file_path> [language]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "fs";
import { extname, dirname, join } from "path";
import { fileURLToPath } from "url";
import { classifyReview } from "./review-parser.mjs";

const LANG_MAP = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".cs": "csharp",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".cpp": "cpp",
  ".c": "c",
  ".swift": "swift",
  ".kt": "kotlin",
};

const SKIP_FILES = [
  "package.json",
  "package-lock.json",
  ".env",
  ".env.example",
  ".gitignore",
];

const filePath = process.argv[2];
const forceLang = process.argv[3];
const useQuickReview = process.argv[4] === "--quick";

if (!filePath) {
  console.error("Usage: node review-runner.mjs <file_path> [language]");
  process.exit(1);
}

// Skip non-code files
const fileName = filePath.split(/[/\\]/).pop();
if (SKIP_FILES.includes(fileName)) {
  console.log(`SKIP: ${fileName} (not a code file)`);
  process.exit(0);
}

const ext = extname(filePath);
const language = forceLang || LANG_MAP[ext];
if (!language) {
  console.log(`SKIP: ${ext} (unsupported language)`);
  process.exit(0);
}

// Read file content
let code;
try {
  code = readFileSync(filePath, "utf8");
} catch (e) {
  console.error(`Cannot read file: ${e.message}`);
  process.exit(1);
}

if (code.trim().length === 0) {
  console.log("SKIP: empty file");
  process.exit(0);
}

// Cost / timeout guard. A 6000-line file sent to three providers in
// parallel can easily cost £0.30+ and timeout. Allow override via env
// for users who genuinely want big-file review.
const MAX_BYTES = parseInt(process.env.AI_REVIEW_MAX_BYTES || "65536", 10);
if (code.length > MAX_BYTES) {
  console.log(
    `SKIP: ${fileName} (${code.length} bytes > ${MAX_BYTES} byte limit; ` +
      `set AI_REVIEW_MAX_BYTES to override)`
  );
  process.exit(0);
}

// Connect to MCP server (always points to the orchestrator install)
const NODE_PATH = process.execPath;
const ORCHESTRATOR_DIR = process.env.AI_ORCHESTRATOR_DIR || "C:\\Users\\ereen\\ai-orchestrator-mcp";

const transport = new StdioClientTransport({
  command: NODE_PATH,
  args: [ORCHESTRATOR_DIR + "\\index.js"],
  cwd: ORCHESTRATOR_DIR,
});

const client = new Client(
  { name: "review-hook", version: "1.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);

  const toolName = useQuickReview ? "quick_review" : "orchestrate_review";
  const result = await client.callTool(
    {
      name: toolName,
      arguments: { code, language, focus: "bugs" },
    },
    undefined,
    { timeout: useQuickReview ? 30000 : 120000 }
  );

  await client.close();

  const text = result.content?.[0]?.text || "";

  const { isPipelineFailure, hasCritical, hasBugs } = classifyReview(text);
  if (isPipelineFailure) {
    console.error(`PIPELINE FAILURE: orchestrator did not produce a review.`);
    console.error(text.split("\n").slice(0, 10).join("\n"));
    process.exit(2);
  }

  if (result.isError) {
    console.error(`REVIEW ERROR: ${text}`);
    process.exit(1);
  }

  // Output review summary (truncated for hook output)
  const lines = text.split("\n").filter((l) => l.trim());
  const summary = lines.slice(0, 30).join("\n");
  console.log(`\n=== Review: ${fileName} (${language}) ===`);
  console.log(summary);

  if (hasCritical) {
    console.log("\n>>> CRITICAL ISSUES FOUND - review needed <<<");
    process.exit(2);
  }

  if (hasBugs) {
    console.log("\n>>> POTENTIAL BUGS FOUND - review recommended <<<");
    // Exit 0 for warnings (don't block)
  }

  console.log("\n>>> Review complete <<<");
  process.exit(0);
} catch (e) {
  console.error(`Review failed: ${e.message}`);
  process.exit(1);
}
