import { GroundingError, PolicyError, RecoverableError, TakeoverRequiredError, VerificationError } from "../errors.js";

export class RecoveryAgent {
  constructor(traceStore) {
    this.traceStore = traceStore;
  }

  classify(error) {
    const message = error.message.toLowerCase();
    if (error instanceof TakeoverRequiredError) {
      return {
        classification: "permission_blocked",
        decision: "takeover",
        nextAction: "request_takeover"
      };
    }

    if (error instanceof PolicyError || message.includes("permission") || message.includes("policy denied")) {
      return {
        classification: "permission_blocked",
        decision: "takeover",
        nextAction: "request_takeover"
      };
    }

    if (error instanceof GroundingError || message.includes("could not ground") || message.includes("target")) {
      return {
        classification: "target_not_found",
        decision: "retry",
        nextAction: "reobserve"
      };
    }

    if (message.includes("navigation")) {
      return {
        classification: "unexpected_navigation",
        decision: "retry",
        nextAction: "reobserve"
      };
    }

    if (message.includes("modal") || message.includes("dialog") || message.includes("popup")) {
      return {
        classification: "modal_interrupt",
        decision: "retry",
        nextAction: "alternate_path"
      };
    }

    if (error instanceof VerificationError || message.includes("verification")) {
      return {
        classification: "target_changed",
        decision: "retry",
        nextAction: "reground"
      };
    }

    if (error instanceof RecoverableError || message.includes("timeout")) {
      return {
        classification: "surface_changed",
        decision: "retry",
        nextAction: "wait_and_retry"
      };
    }

    return {
      classification: "low_confidence",
      decision: "fail",
      nextAction: "stop"
    };
  }

  handle({ taskId, traceId, attempt, error }) {
    const decision = this.classify(error);
    this.traceStore.log({
      traceId,
      taskId,
      role: "recovery",
      type: "recovery.decision",
      message: `Recovery classified the failure as ${decision.classification}.`,
      payload: { attempt, error: error.message, ...decision, details: error.details ?? null }
    });

    return decision;
  }
}
