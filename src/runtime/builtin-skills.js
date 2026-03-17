export const BUILTIN_SKILLS = [
    {
        name: "slack-send-message",
        surfaceScope: "browser",
        triggerTerms: ["slack send message", "send slack message"],
        anchors: [{ text: "Slack", role: "workspace" }, { text: "Send", role: "button" }],
        actionTemplate: [],
        successCriteria: [{ type: "textVisible", value: "Message sent" }],
        recoveryHints: ["workspace switch", "composer not focused"],
        metadata: { pack: "slack", builtin: true }
    },
    {
        name: "wechat-send-message",
        surfaceScope: "desktop",
        triggerTerms: ["wechat send message", "send wechat message", "微信 发消息"],
        anchors: [{ text: "微信", role: "app" }, { text: "发送", role: "button" }],
        actionTemplate: [],
        successCriteria: [{ type: "textVisible", value: "发送" }],
        recoveryHints: ["contact not focused", "search box hidden"],
        metadata: { pack: "wechat", builtin: true }
    },
    {
        name: "boss-open-candidate",
        surfaceScope: "browser",
        triggerTerms: ["boss open candidate", "boss candidate detail", "boss直聘 候选人"],
        anchors: [{ text: "BOSS直聘", role: "workspace" }],
        actionTemplate: [],
        successCriteria: [{ type: "textVisible", value: "在线沟通" }],
        recoveryHints: ["search filters changed", "candidate card moved"],
        metadata: { pack: "boss", builtin: true }
    }
];
