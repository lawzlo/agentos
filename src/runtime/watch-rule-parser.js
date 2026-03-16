function clampPollInterval(value) {
    const interval = Number(value ?? 15000);
    if (!Number.isFinite(interval)) {
        return 15000;
    }
    return Math.max(1000, Math.min(interval, 300000));
}
function inferPack(goal = "", input = {}) {
    if (input.livePack) {
        return {
            livePack: input.livePack,
            preferredSurface: input.preferredSurface ?? "desktop",
            appTarget: input.appTarget ?? null,
            triggerTexts: input.watchProfile?.triggerTexts ?? []
        };
    }
    const text = String(goal).toLowerCase();
    if (/(slack)/iu.test(text)) {
        return {
            livePack: "slack-desktop",
            preferredSurface: input.preferredSurface ?? "desktop",
            appTarget: input.appTarget ?? "Slack",
            triggerTexts: ["unread", "new message", "new messages", "未读"]
        };
    }
    if (/(wechat|微信)/iu.test(text)) {
        return {
            livePack: "wechat-desktop",
            preferredSurface: input.preferredSurface ?? "desktop",
            appTarget: input.appTarget ?? "WeChat",
            triggerTexts: ["未读", "新消息", "wechat", "微信"]
        };
    }
    if (/(mail|email|gmail|outlook|邮箱|邮件)/iu.test(text)) {
        return {
            livePack: "generic-mail-desktop",
            preferredSurface: input.preferredSurface ?? "desktop",
            appTarget: input.appTarget ?? null,
            triggerTexts: ["unread", "inbox", "mail", "邮件", "未读", "收件箱"]
        };
    }
    return {
        livePack: "generic-desktop",
        preferredSurface: input.preferredSurface ?? "desktop",
        appTarget: input.appTarget ?? null,
        triggerTexts: input.watchProfile?.triggerTexts ?? []
    };
}
export function normalizeWatchRule(input = {}, { modelConfigured = false } = {}) {
    const goal = String(input.goal ?? "").trim();
    if (!goal) {
        throw new Error("watch goal is required");
    }
    const inferred = inferPack(goal, input);
    const taskInputs = input.taskInputs ?? input.inputs ?? {};
    const watchProfile = {
        ...(input.watchProfile ?? {}),
        triggerTexts: input.watchProfile?.triggerTexts ?? inferred.triggerTexts,
        executionMode: input.watchProfile?.executionMode ??
            input.executionMode ??
            (input.skillName ? "planned" : modelConfigured ? "autonomous" : "planned")
    };
    const enabled = input.enabled !== false;
    return {
        id: input.id,
        goal,
        enabled,
        status: enabled ? input.status ?? "watching" : "disabled",
        preferredSurface: inferred.preferredSurface,
        workspaceName: input.workspaceName ?? null,
        skillName: input.skillName ?? null,
        appTarget: inferred.appTarget,
        livePack: inferred.livePack,
        pollIntervalMs: clampPollInterval(input.pollIntervalMs),
        watchProfile,
        taskInputs,
        dedupeState: input.dedupeState ?? {},
        lastObservedAt: input.lastObservedAt ?? null,
        lastTriggeredAt: input.lastTriggeredAt ?? null,
        lastError: input.lastError ?? null
    };
}
