function cleanupMatch(value) {
    return String(value ?? "").trim().replace(/[，。,.；;:：]+$/u, "");
}
function detectUrl(goal) {
    const direct = goal?.match(/https?:\/\/[^\s，。；;：:“”"'<>]+/iu)?.[0];
    if (direct) {
        return cleanupMatch(direct);
    }
    const bare = goal?.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s，。；;：:“”"'<>]*)?/iu)?.[0];
    if (!bare) {
        return null;
    }
    const normalized = cleanupMatch(bare);
    return normalized.startsWith("http") ? normalized : `https://${normalized}`;
}
function detectClickTarget(goal) {
    const chinese = goal?.match(/(?:点击|点)\s+["“]?([^"”。，,；;]+?)["”]?(?:然后|并|再|后|，|。|,|;|$)/u)?.[1];
    if (chinese) {
        return cleanupMatch(chinese);
    }
    const english = goal?.match(/click\s+["“]?([^"”.,;]+?)["”]?(?:\s+then|\s+and|[.,;]|$)/iu)?.[1];
    return english ? cleanupMatch(english) : null;
}
function detectCapture(goal) {
    return /截图|截屏|screenshot|capture/iu.test(goal ?? "");
}
export class SentinelAgent {
    normalize(taskSpec) {
        const goal = taskSpec.goal?.trim();
        const inputs = { ...(taskSpec.inputs ?? {}) };
        const detectedUrl = detectUrl(goal);
        const detectedClickTarget = detectClickTarget(goal);
        if (!inputs.startUrl && detectedUrl) {
            inputs.startUrl = detectedUrl;
        }
        if (!inputs.clickTarget && detectedClickTarget) {
            inputs.clickTarget = detectedClickTarget;
        }
        if (!inputs.capture && detectCapture(goal)) {
            inputs.capture = true;
            inputs.captureLabel = inputs.captureLabel ?? "goal-capture";
        }
        return {
            ...taskSpec,
            goal,
            inputs,
            constraints: taskSpec.constraints ?? [],
            permissions: taskSpec.permissions ?? {},
            triggerSource: taskSpec.triggerSource ?? "manual",
            preferredSurface: taskSpec.preferredSurface ?? (inputs.desktopApp && !inputs.startUrl ? "desktop" : "auto"),
            doneCondition: taskSpec.doneCondition ?? "Complete the requested work and return a verifiable result.",
            priority: taskSpec.priority ?? "normal"
        };
    }
    fromEvent(event) {
        return {
            goal: event.payload.goal ?? event.payload.subject ?? `Handle ${event.type} event`,
            inputs: event.payload,
            triggerSource: event.source,
            preferredSurface: event.payload.preferredSurface ?? "auto"
        };
    }
}
