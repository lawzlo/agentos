const HIGH_RISK_KEYWORDS = ["pay", "payment", "wire", "delete", "submit", "send", "sign"];
const BLOCKED_ACTIONS = new Set(["shell", "evaluate"]);
export class PolicyEngine {
    evaluateTask(taskSpec) {
        const text = [taskSpec.goal, taskSpec.doneCondition].filter(Boolean).join(" ").toLowerCase();
        const reasons = HIGH_RISK_KEYWORDS.filter((keyword) => text.includes(keyword)).map((keyword) => `goal contains high-risk keyword: ${keyword}`);
        return {
            allowed: true,
            riskLevel: reasons.length ? "high" : "normal",
            requiresReview: false,
            reasons
        };
    }
    evaluateStep(taskSpec, step) {
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
}
