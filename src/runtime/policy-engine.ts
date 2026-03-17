import type { RiskGateDecision, RuntimeStep, TaskSpec, WatchDetection, WatchRule } from "../types/runtime-schema.js";

const HIGH_RISK_KEYWORDS = ["pay", "payment", "wire", "delete", "submit", "send", "sign", "invoice", "合同", "付款", "删除", "提交", "发送", "签署"];
const HIGH_RISK_AUTOMATION_KEYWORDS = ["pay", "payment", "wire", "delete", "invoice", "sign", "合同", "付款", "删除", "签署"];
const BLOCKED_ACTIONS = new Set(["shell", "evaluate"]);

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
    replyText = ""
  }: {
    taskSpec: TaskSpec;
    watchRule?: WatchRule | null;
    detection?: WatchDetection | null;
    replyText?: string;
  }): RiskGateDecision {
    const livePack = String(watchRule?.livePack ?? "");
    const configuredPolicy =
      watchRule?.taskInputs?.automationPolicy ??
      watchRule?.watchProfile?.metadata?.automationPolicy ??
      taskSpec?.permissions?.automationPolicy ??
      null;
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

    if (livePack === "generic-mail-desktop") {
      return {
        policy: "confirm_required",
        riskLevel,
        reasons: reasons.length ? reasons : ["mail replies require approval by default"],
        action: "draft"
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

    if (["slack-desktop", "slack-browser", "wechat-desktop"].includes(livePack)) {
      return {
        policy: "allow",
        riskLevel,
        reasons,
        action: "send"
      };
    }

    return {
      policy: "draft_only",
      riskLevel,
      reasons: reasons.length ? reasons : ["generic live pack defaults to draft-only"],
      action: "draft"
    };
  }
}
