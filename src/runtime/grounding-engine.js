import { GroundingError } from "./errors.js";

function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function textScore(query, candidateText) {
  const queryText = String(query ?? "").trim().toLowerCase();
  const candidate = String(candidateText ?? "").trim().toLowerCase();
  if (!queryText || !candidate) {
    return 0;
  }

  if (queryText === candidate) {
    return 120;
  }

  if (candidate.includes(queryText)) {
    return 90;
  }

  const queryTokens = tokenize(queryText);
  const candidateTokens = tokenize(candidate);
  if (!queryTokens.length || !candidateTokens.length) {
    return 0;
  }

  let score = 0;
  for (const token of queryTokens) {
    if (candidateTokens.includes(token)) {
      score += 18;
    } else if (candidate.includes(token)) {
      score += 10;
    }
  }

  return score;
}

function scoreCandidate(request, candidate) {
  const targetQuery = request.targetQuery ?? request.goal ?? "";
  const hints = [
    candidate.text,
    candidate.role,
    candidate.sourceHints?.ariaLabel,
    candidate.sourceHints?.placeholder,
    candidate.sourceHints?.name,
    candidate.sourceHints?.title
  ];

  let score = Math.max(...hints.map((hint) => textScore(targetQuery, hint)));
  score += Math.round((candidate.confidence ?? 0) * 10);

  if (request.action === "typeIntoTarget") {
    const inputLike = ["textbox", "input", "textarea", "searchbox"];
    if (inputLike.includes(String(candidate.role ?? "").toLowerCase())) {
      score += 25;
    }
    if (["input", "textarea"].includes(String(candidate.sourceHints?.tag ?? "").toLowerCase())) {
      score += 20;
    }
  }

  if (request.action === "clickTarget" && candidate.isInteractive) {
    score += 8;
  }

  return score;
}

export class GroundingEngine {
  constructor({ traceStore = null } = {}) {
    this.traceStore = traceStore;
  }

  ground(request) {
    const candidates = request.worldState?.interactionCandidates ?? [];
    if (!candidates.length) {
      throw new GroundingError("No interaction candidates were available for grounding.", {
        classification: "target_not_found",
        request
      });
    }

    const ranked = candidates
      .map((candidate) => ({
        candidate,
        score: scoreCandidate(request, candidate)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    if (!ranked.length) {
      throw new GroundingError(`Could not ground target "${request.targetQuery ?? request.goal}".`, {
        classification: "target_not_found",
        request,
        candidateCount: candidates.length
      });
    }

    const best = ranked[0];
    const result = {
      targetId: best.candidate.id,
      resolutionMode: best.score >= 120 ? "exact_text" : "fuzzy_text",
      confidence: Math.min(0.99, best.score / 120),
      target: best.candidate,
      fallbacks: ranked.slice(1, 4).map((entry) => ({
        targetId: entry.candidate.id,
        confidence: Math.min(0.99, entry.score / 120),
        target: entry.candidate
      }))
    };

    if (this.traceStore && request.traceId && request.taskId) {
      this.traceStore.log({
        traceId: request.traceId,
        taskId: request.taskId,
        role: "grounding",
        type: "grounding.resolved",
        message: `Grounded "${request.targetQuery ?? request.goal}" to ${result.targetId}.`,
        payload: {
          action: request.action,
          targetId: result.targetId,
          confidence: result.confidence,
          resolutionMode: result.resolutionMode
        }
      });
    }

    return result;
  }
}
