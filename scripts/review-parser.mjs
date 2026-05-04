// Shared review-text classifier used by both review-runner.mjs (pre-
// commit / on-save quick reviews) and post-commit-review.mjs (auto-fix
// pipeline). Keeping the parser in one place avoids the situation we
// hit before, where the two scripts had diverging regex sets and one
// flagged a bug the other missed.
//
// Returns { hasCritical, hasBugs, saysAllClear, isPipelineFailure }.

const allClearPatterns = [
  /\bno\s+(?:critical\s+)?(?:issues?|bugs?|problems?|vulnerabilit\w+|security\s+\w+|logic\s+errors?)\b/i,
  /no\s+\w+\s+or\s+(?:logic\s+errors?|bugs?|issues?|problems?)\b/i,
  /✅\s*\*?\*?\s*(no\s+\w+|none|all\s+clear)/i,
  /looks?\s+good/i,
  /no\s+(?:inherent|apparent|obvious)\s+(?:bugs?|issues?|problems?|vulnerabilit\w+)/i,
  /functionally\s+correct/i,
];

const criticalSignalPatterns = [
  /\*\*CRITICAL\b[^*]*\*\*/i,            // **CRITICAL**, **Critical Bug**, **CRITICAL: ...**
  /^\s*CRITICAL\b/m,
  /Severity:\s*CRITICAL/i,
  /\bcritical\s+bug\b/i,
  /\bcritical\s+vulnerabilit/i,
  /\bSQL\s+injection\b/i,
  /\bXSS\s+(?:vulnerabilit|attack|risk)/i,
  /\bRCE\b/,
  /\bCSRF\s+(?:vulnerabilit|attack|risk)/i,
  /\bcommand\s+injection\b/i,
  /\bnull\s+(?:dereference|reference\s+bug)/i,
  /will\s+throw\s+(?:a\s+)?TypeError/i,
  /\bTypeError:\s*Cannot\s+read/i,
];

const bugSignalPatterns = [
  /\*\*BUG\b[^*]*\*\*/i,
  /^\s*BUG:/im,
  /\bOff-by-one\s+(?:error|bug)/i,
  /\brace\s+condition\b/i,
];

const pipelineFailurePatterns = [
  /^##\s*Pipeline Failed\b/m,
  /^##\s*Pipeline Error\b/m,
];

export function classifyReview(text) {
  if (!text || typeof text !== "string") {
    return {
      hasCritical: false,
      hasBugs: false,
      saysAllClear: false,
      isPipelineFailure: false,
    };
  }

  const isPipelineFailure = pipelineFailurePatterns.some((re) => re.test(text));
  const saysAllClear = allClearPatterns.some((re) => re.test(text));
  const hasCriticalSignal = criticalSignalPatterns.some((re) => re.test(text));
  const hasBugSignal = bugSignalPatterns.some((re) => re.test(text));

  return {
    isPipelineFailure,
    saysAllClear,
    hasCritical: hasCriticalSignal && !saysAllClear,
    hasBugs: hasBugSignal && !saysAllClear,
  };
}
