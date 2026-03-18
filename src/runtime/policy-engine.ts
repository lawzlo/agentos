import type { RiskGateDecision, RuntimeStep, TaskSpec, WatchDetection, WatchRule } from "../types/runtime-schema.js";
import { resolveReplyPolicy } from "./reply-policy.js";

const HIGH_RISK_KEYWORDS = ["pay", "payment", "wire", "delete", "submit", "send", "sign", "invoice", "合同", "付款", "删除", "提交", "发送", "签署"];
const HIGH_RISK_AUTOMATION_KEYWORDS = ["pay", "payment", "wire", "delete", "invoice", "sign", "合同", "付款", "删除", "签署"];
const BLOCKED_ACTIONS = new Set(["shell", "evaluate"]);

function configuredAutomationPolicy(
  watchRule: WatchRule | null | undefined,
  taskSpec: TaskSpec
): "allow" | "draft_only" | "confirm_required" | "blocked" | null {
  const governanceMode = watchRule?.watchProfile?.governance?.approvalMode;
  if (governanceMode && governanceMode !== "auto") {
    return governanceMode;
  }

  return (
    watchRule?.taskInputs?.automationPolicy ??
    watchRule?.watchProfile?.metadata?.automationPolicy ??
    taskSpec?.permissions?.automationPolicy ??
    null
  ) as "allow" | "draft_only" | "confirm_required" | "blocked" | null;
}

interface PolicyEvaluation {
  allowed: boolean;
  riskLevel: "normal" | "high";
  requiresReview: boolean;
  reasons: string[];
  [key: string]: unknown;
}

export class PolicyEngine {
  evaluateTask(taskSpec: TaskSpec): PolicyEvaluation {
    const text = [taskSpec.goal, taskSpec.doneCondition].filter(Boolean).join(" ").toLowerCase();
    const reasons = HIGH_RISK_KEYWORDS.filter((keyword) => text.includes(keyword)).map(
      (keyword) => `goal contains high-risk keyword: ${keyword}`
    );

    return {
      allowed: true,
      riskLevel: reasons.length ? "high" : "normal",
      requiresReview: false,
      reasons
    };
  }

  evaluateStep(taskSpec: TaskSpec, step: RuntimeStep): PolicyEvaluation {
    const permissions = taskSpec.permissions ?? {};
    const action = step.action;
    const reasons = [];

    if (BLOCKED_ACTIONS.has(action) && permissions.allowAdvancedActions !== true) {
      reasons.push(`${action} requires permissions.allowAdvancedActions=true`);
    }

    if (action === "shell" && permissions.allowShell !== true) {
      reasons.push("shell execution requires permissions.allowShell=true");
    }

    return {
      allowed: reasons.length === 0,
      riskLevel: reasons.length ? "high" : "normal",
      requiresReview: false,
      reasons
    };
  }

  evaluateAutomation({
    taskSpec,
    watchRule = null,
    detection = null,
    replyText = "",
    replyApprovalActive = false
  }: {
    taskSpec: TaskSpec;
    watchRule?: WatchRule | null;
    detection?: WatchDetection | null;
    replyText?: string;
    replyApprovalActive?: boolean;
  }): RiskGateDecision {
    const livePack = String(watchRule?.livePack ?? "");
    const configuredPolicy = configuredAutomationPolicy(watchRule, taskSpec);
    const replyPolicy = resolveReplyPolicy({ watchRule, taskSpec, livePack });
    const text = [
      taskSpec?.goal,
      taskSpec?.doneCondition,
      detection?.summary,
      ...(Array.isArray(detection?.context) ? detection.context : []),
      replyText
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const reasons = HIGH_RISK_AUTOMATION_KEYWORDS.filter((keyword) => text.includes(keyword)).map(
      (keyword) => `automation context contains high-risk keyword: ${keyword}`
    );
    const riskLevel = reasons.length ? "high" : "normal";
    const inputs = taskSpec?.inputs ?? {};
    const steps = Array.isArray(taskSpec?.steps) ? taskSpec.steps : [];
    const stepLooksLikeSend = steps.some((step) => {
      const target = (step?.params?.target ?? null) as { text?: string } | null;
      const text = String(step?.params?.targetQuery ?? target?.text ?? step?.label ?? "").toLowerCase();
      return /(send|reply|submit|发送|回复|提交)/iu.test(text);
    });
    const hasOutboundSendIntent =
      Boolean(replyText?.trim()) ||
      Boolean(inputs.sendTarget) ||
      stepLooksLikeSend;

    if (configuredPolicy === "blocked") {
      return {
        policy: "blocked",
        riskLevel,
        reasons: reasons.length ? reasons : ["automationPolicy=blocked"],
        action: "block"
      };
    }

    if (configuredPolicy === "draft_only") {
      return {
        policy: "draft_only",
        riskLevel,
        reasons: reasons.length ? reasons : ["automationPolicy=draft_only"],
        action: "draft"
      };
    }

    if (configuredPolicy === "confirm_required") {
      return {
        policy: "confirm_required",
        riskLevel,
        reasons: reasons.length ? reasons : ["automationPolicy=confirm_required"],
        action: "draft"
      };
    }

    if (configuredPolicy === "allow") {
      return {
        policy: "allow",
        riskLevel,
        reasons,
        action: "send"
      };
    }

    if (!hasOutboundSendIntent) {
      return {
        policy: "allow",
        riskLevel,
        reasons,
        action: "send"
      };
    }

    if (replyPolicy === "blocked") {
      return {
        policy: "blocked",
        riskLevel,
        reasons: reasons.length ? reasons : [`replyPolicy=${replyPolicy}`],
        action: "block"
      };
    }

    if (replyPolicy === "draft_first") {
      return {
        policy: "confirm_required",
        riskLevel,
        reasons: reasons.length ? reasons : [`replyPolicy=${replyPolicy}`],
        action: "draft"
      };
    }

    if (replyPolicy === "prefill_first") {
      return {
        policy: "allow",
        riskLevel,
        reasons: reasons.length ? reasons : [`replyPolicy=${replyPolicy}`],
        action: "prefill"
      };
    }

    if (riskLevel === "high") {
      return {
        policy: "confirm_required",
        riskLevel,
        reasons,
        action: "draft"
      };
    }

    if (replyPolicy === "approve_once_then_auto") {
      return {
        policy: replyApprovalActive ? "allow" : "confirm_required",
        riskLevel,
        reasons: reasons.length
          ? reasons
          : [replyApprovalActive ? "replyPolicy=approve_once_then_auto(active_grant)" : "replyPolicy=approve_once_then_auto"],
        action: replyApprovalActive ? "send" : "draft"
      };
    }

    if (replyPolicy === "auto_send") {
      return {
        policy: "allow",
        riskLevel,
        reasons: reasons.length ? reasons : [`replyPolicy=${replyPolicy}`],
        action: "send"
      };
    }

    return {
      policy: "draft_only",
      riskLevel,
      reasons: reasons.length ? reasons : [`replyPolicy=${replyPolicy}`],
      action: "draft"
    };
  }
}
