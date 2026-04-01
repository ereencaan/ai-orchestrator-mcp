import { promises as fs, readFileSync, writeFileSync, appendFileSync } from "fs";
import path from "path";
import { execFileSync } from "child_process";
import https from "https";

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_RETRIES = 3;
const MAX_API_RESPONSE_SIZE = 50 * 1024 * 1024;
const CONCURRENCY_LIMIT = 5;
const API_TIMEOUT_MS = 60000;

function validateApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("API key is not configured");
  }
  if (apiKey.length < 20) {
    throw new Error("API key format is invalid");
  }
}

function preValidatePath(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("Invalid file path: path must be a non-empty string");
  }
  if (filePath.includes("..")) {
    throw new Error("Invalid file path: path traversal detected");
  }
  if (filePath.startsWith("/")) {
    throw new Error("Invalid file path: absolute paths not allowed");
  }
}

function validateFilePath(filePath, baseDir) {
  preValidatePath(filePath);
  const resolvedPath = path.resolve(baseDir, filePath);
  const normalizedBaseDir = path.resolve(baseDir);
  if (!resolvedPath.startsWith(normalizedBaseDir + path.sep) && resolvedPath !== normalizedBaseDir) {
    throw new Error("Invalid file path: path traversal detected");
  }
  return resolvedPath;
}

async function safeFileOperation(operation, filePath, baseDir = ".", ...args) {
  validateApiKey();
  const resolvedPath = validateFilePath(filePath, baseDir);

  try {
    if (operation === "read") {
      const stats = await fs.stat(resolvedPath);
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File size exceeds maximum allowed size of ${MAX_FILE_SIZE} bytes`);
      }
      const content = await fs.readFile(resolvedPath, "utf-8");
      return content;
    } else if (operation === "write") {
      const content = args[0];
      await fs.writeFile(resolvedPath, content, "utf-8");
    } else if (operation === "append") {
      const content = args[0];
      await fs.appendFile(resolvedPath, content, "utf-8");
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    } else if (error.code === "EACCES") {
      throw new Error(`Permission denied: ${filePath}`);
    }
    throw error;
  }
}

function validateGitArguments(args) {
  const allowedCommands = ["diff", "status", "log", "show"];
  const allowedFlagPattern = /^--[a-zA-Z0-9\-]+(=[a-zA-Z0-9\-._/]*)?$/;

  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("Invalid git arguments: arguments must be a non-empty array");
  }

  const command = args[0];
  if (!allowedCommands.includes(command)) {
    throw new Error(`Invalid git command: ${command} is not allowed`);
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!allowedFlagPattern.test(arg)) {
      throw new Error(`Invalid git argument: argument format is not allowed`);
    }
  }
}

function executeGitCommand(args, options = {}) {
  validateGitArguments(args);
  try {
    const result = execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    return result;
  } catch (error) {
    throw new Error(`Git command failed: ${error.message}`);
  }
}

async function processFile(filePath) {
  let attempts = 0;
  const result = {
    file: filePath,
    status: "pending",
  };

  while (attempts < MAX_RETRIES) {
    try {
      attempts++;
      const content = await safeFileOperation("read", filePath);
      const review = await reviewCode(filePath, content);
      result.status = "success";
      result.issues = review.issues || [];
      return result;
    } catch (error) {
      if (attempts >= MAX_RETRIES) {
        result.status = "failed";
        result.error = error.message;
        result.attempts = attempts;
        return result;
      }
    }
  }
  return result;
}

async function reviewCode(filePath, content) {
  const prompt = `Review the following code file: ${filePath}\n\n${content}\n\nProvide a detailed code review highlighting any issues, improvements, and best practices.`;

  return new Promise((resolve, reject) => {
    const requestData = JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
    });

    const options = {
      hostname: "api.openai.com",
      port: 443,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestData),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      const timeout = setTimeout(() => {
        req.abort();
        reject(new Error("API request timeout"));
      }, API_TIMEOUT_MS);

      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > MAX_API_RESPONSE_SIZE) {
          req.abort();
          clearTimeout(timeout);
          reject(new Error("API response size exceeded"));
        }
      });

      res.on("end", () => {
        clearTimeout(timeout);
        if (res.statusCode !== 200) {
          reject(new Error(`API error: status code ${res.statusCode}`));
          return;
        }
        try {
          const jsonData = JSON.parse(data);
          const reviewText = jsonData.choices[0].message.content;
          const issues = extractIssues(reviewText);
          resolve({
            issues,
            reviewText,
          });
        } catch (error) {
          reject(new Error("Failed to parse API response"));
        }
      });
    });

    req.on("error", (error) => {
      reject(new Error(`API request failed: ${error.message}`));
    });

    req.write(requestData);
    req.end();
  });
}

function extractIssues(reviewText) {
  const issues = [];
  const lines = reviewText.split("\n");
  for (const line of lines) {
    if (line.match(/^[-*•]\s+/)) {
      issues.push(line.replace(/^[-*•]\s+/, "").trim());
    }
  }
  return issues;
}

async function processFilesInParallel(files, concurrency = CONCURRENCY_LIMIT) {
  const results = [];

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map((file) => processFile(file)));

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          file: "unknown",
          status: "failed",
          error: result.reason?.message || "Unknown error",
        });
      }
    }
  }

  return results;
}

function getChangedFiles() {
  try {
    const output = executeGitCommand(["diff", "--name-only"]);
    return output
      .split("\n")
      .filter((file) => file.trim().length > 0)
      .filter((file) => /\.(js|ts|jsx|tsx)$/.test(file));
  } catch (error) {
    return [];
  }
}

async function generateReport(results) {
  const timestamp = new Date().toISOString();
  const reportPath = "code-review-report.json";

  const report = {
    timestamp,
    summary: {
      totalFiles: results.length,
      successful: results.filter((r) => r.status === "success").length,
      failed: results.filter((r) => r.status === "failed").length,
    },
    results,
  };

  try {
    await safeFileOperation("write", reportPath, ".", JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`Failed to write report: ${error.message}`);
  }
}

async function main() {
  try {
    validateApiKey();
    const files = getChangedFiles();

    if (files.length === 0) {
      console.log("No JavaScript/TypeScript files to review");
      return;
    }

    console.log(`Reviewing ${files.length} files...`);
    const results = await processFilesInParallel(files);
    await generateReport(results);
    console.log("Code review completed");
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();