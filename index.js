import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

// --- Clients ---

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Model Constants ---

const SONNET_MODEL = "claude-sonnet-4-20250514";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const GEMINI_MODEL = "gemini-2.5-flash";
const OPENAI_MODEL = "gpt-4o-mini";
const MAX_ITERATIONS = 3;
const MAX_RESTARTS = 3;

// --- System Prompts ---

const SONNET_SUPERVISOR_SYSTEM = `You are a senior software architect acting as a supervisor. Your job is to take a user's request and convert it into a precise, detailed implementation prompt for a junior developer.

Your output must include:
- Exact function/class/method signatures
- Input/output types and formats
- Edge cases to handle
- Error handling requirements
- Performance considerations
- Security requirements if applicable

Do NOT write code yourself. Write a detailed specification that a developer can follow to produce perfect code.

Be extremely precise. Leave no room for ambiguity. The developer will follow your instructions literally.`;

const HAIKU_WORKER_SYSTEM = `You are an expert developer. You receive detailed specifications and implement them perfectly.

Rules:
- Return ONLY code inside a single code block
- No explanations, no comments outside the code block
- Follow the specification exactly
- Write clean, production-ready code
- Include proper error handling as specified
- Use modern best practices for the target language`;

const SONNET_REVIEWER_SYSTEM = `You are a senior code reviewer. You compare code against the original requirements and check for correctness.

You MUST respond with valid JSON only, no other text:
{
  "pass": true/false,
  "issues": ["issue 1", "issue 2"],
  "summary": "brief overall assessment"
}

Mark pass=false ONLY for:
- Bugs or logic errors
- Missing required functionality
- Security vulnerabilities
- Broken error handling

Do NOT fail for:
- Style preferences
- Minor naming choices
- Missing optional features`;

// --- AI Helper Functions ---

async function askSonnet(systemPrompt, userMessage) {
  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].text;
}

async function askHaiku(systemPrompt, userMessage) {
  const response = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].text;
}

async function askGemini(prompt) {
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function askOpenAI(prompt) {
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 4096,
  });
  return response.choices[0].message.content;
}

// --- PipelineLogger ---

class PipelineLogger {
  constructor(server, toolName) {
    this.server = server;
    this.toolName = toolName;
    this.entries = [];
    this.startTime = Date.now();
  }

  async log(level, stage, message) {
    const now = Date.now();
    const elapsed = now - this.startTime;
    const entry = { timestamp: new Date(now).toISOString(), elapsed, level, stage, message };
    this.entries.push(entry);
    try {
      this.server.sendLoggingMessage({
        level,
        logger: `orchestrator/${this.toolName}`,
        data: { stage, message, elapsed },
      });
    } catch {}
  }

  formatLog() {
    if (this.entries.length === 0) return "";
    const totalMs = Date.now() - this.startTime;
    let output = `\n---\n\n### Execution Log (${(totalMs / 1000).toFixed(1)}s total)\n\n`;
    output += "| Elapsed | Level | Stage | Message |\n";
    output += "|---------|-------|-------|---------|\n";
    for (const e of this.entries) {
      const sec = (e.elapsed / 1000).toFixed(1).padStart(7);
      const lvl = e.level.toUpperCase().padEnd(7);
      const stg = e.stage.padEnd(14);
      output += `| ${sec}s | ${lvl} | ${stg} | ${e.message} |\n`;
    }
    return output;
  }
}

// --- Retry Wrapper ---

async function runWithRetry(pipelineFn, logger) {
  for (let attempt = 1; attempt <= MAX_RESTARTS + 1; attempt++) {
    try {
      if (attempt > 1) {
        await logger.log("warning", "restart", `Pipeline restarting (attempt ${attempt}/${MAX_RESTARTS + 1})...`);
      }
      return await pipelineFn(attempt);
    } catch (error) {
      await logger.log("error", "pipeline-error", `Attempt ${attempt} failed: ${error.message}`);
      if (attempt > MAX_RESTARTS) {
        return `## Pipeline Failed\n\n**Error:** ${error.message}\n**Attempts:** ${attempt}\n${logger.formatLog()}`;
      }
    }
  }
}

// --- Utility Functions ---

function extractCodeBlock(text) {
  const match = text.match(/```[\w]*\n([\s\S]*?)```/);
  return match ? match[1].trim() : text.trim();
}

function parseReviewJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {}
    }
    const hasIssues =
      /\b(bug|error|security|vulnerability|incorrect|broken|missing)\b/i.test(
        text
      );
    return {
      pass: !hasIssues,
      issues: hasIssues ? [text.substring(0, 500)] : [],
      summary: text.substring(0, 200),
    };
  }
}

function hasBlockingIssues(geminiReview, openaiReview) {
  const blocking =
    /\b(critical|severe|bug|vulnerability|security issue|logic error|crash|broken)\b/i;
  return blocking.test(geminiReview) || blocking.test(openaiReview);
}

function buildExternalReviewPrompt(code, language) {
  return `You are a senior code reviewer. Review the following ${language} code.
Focus on: bugs, security, performance, and correctness.

Be concise. Only mention actual issues, not style preferences.
Rate severity: CRITICAL, WARNING, or INFO.

\`\`\`${language}
${code}
\`\`\``;
}

// --- Pipeline Functions ---

async function runCodePipeline(request, language, context, maxIterations, logger, sendProgress) {
  const iterations = [];
  let finalCode = "";
  let feedback = "";
  const stagesPerIter = 5;
  const totalStages = maxIterations * stagesPerIter;

  for (let i = 1; i <= maxIterations; i++) {
    const iterationLog = { iteration: i, stages: {} };
    const base = (i - 1) * stagesPerIter;

    // STAGE 1: Sonnet Supervisor
    await logger.log("info", "supervisor", `Iter ${i}: Sending request to Sonnet supervisor...`);
    await sendProgress(base + 1, totalStages, `Iter ${i}: Sonnet supervisor`);

    const supervisorInput = feedback
      ? `Original request: ${request}\nLanguage: ${language}\n${context ? `Context: ${context}\n` : ""}PREVIOUS ATTEMPT FAILED. Feedback from reviewers:\n${feedback}\n\nRewrite the specification addressing ALL issues above.`
      : `Request: ${request}\nLanguage: ${language}\n${context ? `Context: ${context}` : ""}`;

    const specification = await askSonnet(SONNET_SUPERVISOR_SYSTEM, supervisorInput);
    iterationLog.stages.supervisor = specification.substring(0, 300) + "...";
    await logger.log("info", "supervisor", `Iter ${i}: Spec received (${specification.length} chars)`);

    // STAGE 2: Haiku Worker
    await logger.log("info", "worker", `Iter ${i}: Sending spec to Haiku worker...`);
    await sendProgress(base + 2, totalStages, `Iter ${i}: Haiku worker`);

    const haikuInput = `Language: ${language}\n\nSpecification:\n${specification}`;
    const haikuOutput = await askHaiku(HAIKU_WORKER_SYSTEM, haikuInput);
    finalCode = extractCodeBlock(haikuOutput);
    iterationLog.stages.worker = `Generated ${finalCode.length} characters of code`;
    await logger.log("info", "worker", `Iter ${i}: Code generated (${finalCode.length} chars)`);

    // STAGE 3: Sonnet Reviewer
    await logger.log("info", "sonnet-review", `Iter ${i}: Sonnet reviewing code...`);
    await sendProgress(base + 3, totalStages, `Iter ${i}: Sonnet review`);

    const reviewInput = `Original request: ${request}\nLanguage: ${language}\n\nGenerated code:\n\`\`\`${language}\n${finalCode}\n\`\`\`\n\nDoes this code fully satisfy the original request? Check for bugs, missing features, and security issues.`;
    const reviewOutput = await askSonnet(SONNET_REVIEWER_SYSTEM, reviewInput);
    const review = parseReviewJSON(reviewOutput);
    iterationLog.stages.sonnetReview = review;
    await logger.log("info", "sonnet-review", `Iter ${i}: pass=${review.pass}, issues=${review.issues.length}`);

    // STAGE 4: Gemini + OpenAI Review (parallel)
    await logger.log("info", "external", `Iter ${i}: Gemini + OpenAI parallel review...`);
    await sendProgress(base + 4, totalStages, `Iter ${i}: External reviews`);

    const externalPrompt = buildExternalReviewPrompt(finalCode, language);
    const [geminiReview, openaiReview] = await Promise.all([
      askGemini(externalPrompt),
      askOpenAI(externalPrompt),
    ]);
    iterationLog.stages.geminiReview = geminiReview.substring(0, 500);
    iterationLog.stages.openaiReview = openaiReview.substring(0, 500);
    await logger.log("info", "external", `Iter ${i}: External reviews received`);

    iterations.push(iterationLog);

    // STAGE 5: Decision
    await sendProgress(base + 5, totalStages, `Iter ${i}: Decision`);
    const externalBlocking = hasBlockingIssues(geminiReview, openaiReview);

    if (review.pass && !externalBlocking) {
      await logger.log("info", "decision", `Iter ${i}: ALL REVIEWS PASSED`);
      const result = formatResult(finalCode, language, iterations, i, "PASSED", review, geminiReview, openaiReview);
      return result + logger.formatLog();
    }

    if (i === maxIterations) {
      await logger.log("warning", "decision", `Iter ${i}: Max iterations reached, returning best result`);
      const result = formatResult(finalCode, language, iterations, i, "MAX_ITERATIONS", review, geminiReview, openaiReview);
      return result + logger.formatLog();
    }

    // Build feedback for next iteration
    const allIssues = [];
    if (!review.pass) allIssues.push(`Sonnet: ${review.issues.join("; ")}`);
    if (externalBlocking) {
      allIssues.push(`Gemini: ${geminiReview.substring(0, 300)}`);
      allIssues.push(`OpenAI: ${openaiReview.substring(0, 300)}`);
    }
    feedback = allIssues.join("\n\n");
    await logger.log("warning", "decision", `Iter ${i}: Issues found, retrying. Feedback: ${feedback.substring(0, 150)}...`);
  }
}

async function runQuickReviewPipeline(code, language, focus, logger, sendProgress) {
  await logger.log("info", "quick-review", "Starting Sonnet-only quick review...");
  await sendProgress(1, 2, "Sending to Sonnet");

  const reviewPrompt = `Review the following ${language} code.${focus ? ` Focus on: ${focus}.` : ""}

Only report CRITICAL issues: bugs, security vulnerabilities, logic errors, crashes.
Do NOT report style, naming, or minor suggestions.
Rate severity: CRITICAL or SKIP.
If no critical issues, just say "No critical issues found."

\`\`\`${language}
${code}
\`\`\``;

  const sonnetReview = await askSonnet("You are a senior code reviewer. Only flag critical bugs and security issues. Be very concise.", reviewPrompt);

  await logger.log("info", "quick-review", `Sonnet review received (${sonnetReview.length} chars)`);
  await sendProgress(2, 2, "Quick review complete");

  const result = `## Quick Review (Sonnet Only)\n\n${sonnetReview}`;
  return result + logger.formatLog();
}

async function runReviewPipeline(code, language, focus, logger, sendProgress) {
  await logger.log("info", "review-start", "Starting parallel 3-model review...");
  await sendProgress(1, 3, "Sending to Sonnet + Gemini + OpenAI");

  const reviewPrompt = `Review the following ${language} code.${focus ? ` Focus on: ${focus}.` : ""}

Be concise and actionable. Provide:
1. Issues Found (bugs, logic errors)
2. Security Concerns
3. Performance Suggestions
4. Suggested Improvements

\`\`\`${language}
${code}
\`\`\``;

  const [sonnetReview, geminiReview, openaiReview] = await Promise.all([
    askSonnet("You are a senior code reviewer. Be thorough but concise.", reviewPrompt),
    askGemini(reviewPrompt),
    askOpenAI(reviewPrompt),
  ]);

  await logger.log("info", "sonnet", `Sonnet review received (${sonnetReview.length} chars)`);
  await logger.log("info", "gemini", `Gemini review received (${geminiReview.length} chars)`);
  await logger.log("info", "openai", `OpenAI review received (${openaiReview.length} chars)`);
  await sendProgress(3, 3, "All reviews complete");

  const result = `## Sonnet Review (Supervisor)\n\n${sonnetReview}\n\n---\n\n## Gemini Review\n\n${geminiReview}\n\n---\n\n## OpenAI Review\n\n${openaiReview}`;
  return result + logger.formatLog();
}

async function runRefactorPipeline(code, language, instructions, context, logger, sendProgress) {
  await logger.log("info", "refactor", "Starting refactor pipeline...");
  return runCodePipeline(
    `Refactor the following code according to these instructions: ${instructions}\n\nExisting code:\n\`\`\`${language}\n${code}\n\`\`\``,
    language,
    context,
    MAX_ITERATIONS,
    logger,
    sendProgress
  );
}

// --- Result Formatting ---

function formatResult(
  code,
  language,
  iterations,
  totalIterations,
  status,
  lastReview,
  geminiReview,
  openaiReview
) {
  let output = `## Pipeline Result\n\n`;
  output += `**Status:** ${status === "PASSED" ? "All reviews passed" : "Completed after max iterations"}\n`;
  output += `**Iterations:** ${totalIterations}\n\n`;
  output += `### Generated Code\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
  output += `---\n\n### Review Summary\n\n`;
  output += `**Sonnet:** ${lastReview.summary}\n`;
  output += `**Issues:** ${lastReview.issues.length === 0 ? "None" : lastReview.issues.join(", ")}\n\n`;
  output += `**Gemini:**\n${geminiReview.substring(0, 800)}\n\n`;
  output += `**OpenAI:**\n${openaiReview.substring(0, 800)}\n\n`;

  if (totalIterations > 1) {
    output += `---\n\n### Iteration History\n\n`;
    for (const iter of iterations) {
      output += `**Iteration ${iter.iteration}:**\n`;
      output += `- Supervisor: ${iter.stages.supervisor.substring(0, 100)}...\n`;
      output += `- Worker: ${iter.stages.worker}\n`;
      output += `- Sonnet Review: pass=${iter.stages.sonnetReview.pass}, issues=${iter.stages.sonnetReview.issues.length}\n\n`;
    }
  }

  return output;
}

// --- Tool Definitions ---

const TOOLS = [
  {
    name: "orchestrate_code",
    description:
      "Full AI pipeline: Sonnet designs the spec, Haiku writes code, Sonnet reviews, then Gemini+OpenAI do final review. Auto-retries up to 3 times if issues found. Includes live logging and auto-restart on failures.",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "What you want built (e.g. 'Create a REST API endpoint for user registration')",
        },
        language: {
          type: "string",
          description: "Target programming language (e.g. csharp, javascript, python)",
        },
        context: {
          type: "string",
          description: "Project context, tech stack, constraints (optional)",
        },
        max_iterations: {
          type: "number",
          description: "Max retry iterations (default: 3, max: 3)",
          default: 3,
        },
      },
      required: ["request", "language"],
    },
  },
  {
    name: "quick_review",
    description:
      "Lightweight Sonnet-only review for pre-commit hooks. Only flags critical bugs and security issues. Fast and cheap.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code to review" },
        language: {
          type: "string",
          description: "Programming language (e.g. csharp, javascript)",
        },
        focus: {
          type: "string",
          description: "Review focus: security, performance, bugs (optional)",
        },
      },
      required: ["code", "language"],
    },
  },
  {
    name: "orchestrate_review",
    description:
      "Send code to Sonnet + Gemini + OpenAI simultaneously for a triple-review. Includes live logging and auto-restart on failures.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code to review" },
        language: {
          type: "string",
          description: "Programming language (e.g. csharp, javascript)",
        },
        focus: {
          type: "string",
          description: "Review focus: security, performance, readability, bugs, or general",
        },
      },
      required: ["code", "language"],
    },
  },
  {
    name: "orchestrate_refactor",
    description:
      "Refactor existing code through the full pipeline. Sonnet plans the refactor, Haiku implements it, then triple-review validates the result. Includes live logging and auto-restart on failures.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The existing code to refactor" },
        language: {
          type: "string",
          description: "Programming language (e.g. csharp, javascript)",
        },
        instructions: {
          type: "string",
          description: "What to refactor and how (e.g. 'Extract validation logic into a separate service')",
        },
        context: {
          type: "string",
          description: "Project context, tech stack, constraints (optional)",
        },
      },
      required: ["code", "language", "instructions"],
    },
  },
];

// --- Tool Handler ---

async function handleTool(name, args, logger, sendProgress) {
  switch (name) {
    case "orchestrate_code": {
      const maxIter = Math.min(args.max_iterations || MAX_ITERATIONS, MAX_ITERATIONS);
      return runWithRetry(
        () => runCodePipeline(args.request, args.language, args.context, maxIter, logger, sendProgress),
        logger
      );
    }
    case "quick_review":
      return runWithRetry(
        () => runQuickReviewPipeline(args.code, args.language, args.focus, logger, sendProgress),
        logger
      );
    case "orchestrate_review":
      return runWithRetry(
        () => runReviewPipeline(args.code, args.language, args.focus, logger, sendProgress),
        logger
      );
    case "orchestrate_refactor":
      return runWithRetry(
        () => runRefactorPipeline(args.code, args.language, args.instructions, args.context, logger, sendProgress),
        logger
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- MCP Server Setup ---

const server = new Server(
  { name: "ai-orchestrator-mcp", version: "1.1.0" },
  { capabilities: { tools: {}, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;
  const logger = new PipelineLogger(server, toolName);
  const progressToken = request.params._meta?.progressToken;

  const sendProgress = async (current, total, message) => {
    if (progressToken !== undefined) {
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: current, total, message },
        });
      } catch {}
    }
  };

  try {
    await logger.log("info", "init", `Pipeline started: ${toolName}`);
    const result = await handleTool(toolName, request.params.arguments, logger, sendProgress);
    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    await logger.log("error", "fatal", `Unhandled error: ${error.message}`);
    return {
      content: [{ type: "text", text: `## Pipeline Error\n\n**Error:** ${error.message}\n${logger.formatLog()}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
