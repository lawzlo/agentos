import crypto from "node:crypto";

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function normalizeTokens(values = []) {
  return uniqueStrings(values).map((entry) => entry.toLowerCase());
}

function collectSignals(worldState) {
  const signals = [];

  for (const [index, candidate] of (worldState?.interactionCandidates ?? []).entries()) {
    const text = String(candidate?.text ?? "").trim();
    if (!text) {
      continue;
    }

    signals.push({
      text,
      source: "candidate",
      interactive: Boolean(candidate?.isInteractive),
      role: candidate?.role ?? null,
      index,
      score: candidate?.isInteractive ? 8 : 5
    });
  }

  for (const [index, block] of (worldState?.ocrBlocks ?? []).entries()) {
    const text = String(block?.text ?? "").trim();
    if (!text) {
      continue;
    }

    signals.push({
      text,
      source: "ocr",
      interactive: false,
      role: "text",
      index,
      score: 4
    });
  }

  for (const [index, line] of String(worldState?.visibleText ?? "")
    .split("\n")
    .entries()) {
    const text = String(line ?? "").trim();
    if (!text) {
      continue;
    }

    signals.push({
      text,
      source: "visible",
      interactive: false,
      role: "text",
      index,
      score: 2
    });
  }

  for (const [index, windowInfo] of (worldState?.appContext?.windows ?? []).entries()) {
    const text = String(windowInfo?.title ?? "").trim();
    if (!text) {
      continue;
    }

    signals.push({
      text,
      source: "window",
      interactive: false,
      role: "window",
      index,
      score: 1
    });
  }

  return signals;
}

function visibleLines(worldState) {
  return uniqueStrings(collectSignals(worldState).map((signal) => signal.text)).slice(0, 120);
}

function fingerprint(value) {
  return crypto.createHash("sha1").update(String(value ?? "")).digest("hex");
}

function matchTriggerText(lines, triggerTexts = []) {
  const loweredTriggers = triggerTexts.map((entry) => String(entry).toLowerCase()).filter(Boolean);
  if (!loweredTriggers.length) {
    return lines[0] ?? null;
  }

  return (
    lines.find((line) => loweredTriggers.some((trigger) => line.toLowerCase().includes(trigger))) ?? null
  );
}

function bestSignalMatch({
  worldState,
  triggerTexts = [],
  unreadTokens = [],
  ignoreTokens = []
}) {
  const triggerTokens = normalizeTokens(triggerTexts);
  const unreadMatches = normalizeTokens(unreadTokens);
  const ignored = normalizeTokens(ignoreTokens);
  const signals = collectSignals(worldState);

  const ranked = signals
    .map((signal) => {
      const lowered = signal.text.toLowerCase();
      if (ignored.some((token) => lowered.includes(token))) {
        return null;
      }

      let score = signal.score;
      if (triggerTokens.some((token) => lowered.includes(token))) {
        score += 12;
      }
      if (unreadMatches.some((token) => lowered.includes(token))) {
        score += 10;
      }
      if (/^(send|reply|submit|search|发送|回复|提交|搜索)$/iu.test(signal.text.trim())) {
        score -= 6;
      }

      return {
        ...signal,
        score
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);

  return ranked[0] ?? null;
}

function contextForSignal(worldState, signal) {
  const lines = visibleLines(worldState);
  const index = lines.findIndex((line) => line === signal?.text);
  if (index === -1) {
    return lines.slice(0, 3);
  }

  return uniqueStrings(lines.slice(Math.max(0, index - 1), index + 2)).slice(0, 3);
}

function createVisualDesktopPack({
  name,
  defaultTriggerTexts = [],
  unreadTokens = [],
  ignoreTokens = []
}: {
  name: string;
  defaultTriggerTexts?: string[];
  unreadTokens?: string[];
  ignoreTokens?: string[];
}) {
  return {
    name,
    async activate({ rule, workspace, surfaceRegistry }) {
      if (rule.appTarget && rule.preferredSurface === "desktop") {
        const desktop = surfaceRegistry.get("desktop");
        await desktop
          .act({
            task: { id: `watch-${rule.id}`, goal: rule.goal },
            step: {
              id: `watch-focus-${rule.id}`,
              action: "focusApp",
              params: { name: rule.appTarget }
            },
            workspace,
            traceId: null
          })
          .catch(() => null);
      }
    },
    async observeInbox({ rule, workspace, surfaceRegistry }) {
      const surface = surfaceRegistry.get(rule.preferredSurface ?? "desktop");
      return surface.observe({
        task: { id: `watch-${rule.id}`, goal: rule.goal },
        workspace,
        traceId: null,
        label: `watch-${rule.id}`
      });
    },
    async detectNewItems({ rule, worldState, dedupeState = {} as Record<string, any> }) {
      const lines = visibleLines(worldState);
      const matchedSignal = bestSignalMatch({
        worldState,
        triggerTexts: [...defaultTriggerTexts, ...(rule.watchProfile?.triggerTexts ?? [])],
        unreadTokens,
        ignoreTokens
      });
      const match = matchedSignal?.text ?? matchTriggerText(lines, [...defaultTriggerTexts, ...(rule.watchProfile?.triggerTexts ?? [])]);
      if (!match || !matchedSignal) {
        return null;
      }

      const context = contextForSignal(worldState, matchedSignal);
      const itemFingerprint = fingerprint(`${name}:${match}:${context.join("|")}`);
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      const liveHints = rule.watchProfile?.liveHints ?? {};
      return {
        fingerprint: itemFingerprint,
        summary: match,
        text: match,
        context,
        inputs: {
          watchItemText: match,
          watchSummary: match,
          watchContext: context.join("\n"),
          ...(liveHints.openTargetQuery ? { clickTarget: liveHints.openTargetQuery } : {}),
          ...(liveHints.composeTargetQuery ? { typeTarget: liveHints.composeTargetQuery } : {}),
          ...(liveHints.sendTargetQuery ? { sendTarget: liveHints.sendTargetQuery } : {})
        }
      };
    },
    async extractContext({ detection, rule }) {
      return {
        summary: detection.summary,
        inputs: {
          ...(detection.inputs ?? {}),
          watchProfileMode: rule.watchProfile?.executionMode ?? "planned"
        }
      };
    }
  };
}

export class LivePackRegistry {
  surfaceRegistry: any;
  packs: Map<string, any>;
  constructor({ surfaceRegistry, extraPacks = {} as Record<string, any> }: { surfaceRegistry?: any; extraPacks?: Record<string, any> } = {}) {
    this.surfaceRegistry = surfaceRegistry;
    this.packs = new Map();

    for (const pack of [
      createVisualDesktopPack({ name: "generic-desktop" }),
      createVisualDesktopPack({
        name: "slack-desktop",
        defaultTriggerTexts: ["unread", "new message", "new messages", "未读", "mention"],
        unreadTokens: ["unread", "new message", "new messages", "未读", "mention"],
        ignoreTokens: ["send", "reply", "search", "compose", "发送", "回复", "搜索"]
      }),
      createVisualDesktopPack({
        name: "wechat-desktop",
        defaultTriggerTexts: ["未读", "新消息", "wechat", "微信"],
        unreadTokens: ["未读", "新消息", "wechat", "微信"],
        ignoreTokens: ["发送", "回复", "搜索"]
      }),
      createVisualDesktopPack({
        name: "generic-mail-desktop",
        defaultTriggerTexts: ["unread", "inbox", "mail", "邮件", "未读", "收件箱"],
        unreadTokens: ["unread", "new mail", "inbox", "邮件", "未读", "收件箱"],
        ignoreTokens: ["send", "reply", "compose", "发送", "回复", "撰写"]
      })
    ]) {
      this.register(pack.name, pack);
    }

    for (const [name, pack] of Object.entries(extraPacks ?? {})) {
      this.register(name, { name, ...(pack as Record<string, any>) });
    }
  }

  register(name: string, pack: any) {
    this.packs.set(name, pack);
  }

  get(name: string) {
    return this.packs.get(name);
  }

  list() {
    return [...this.packs.keys()].sort();
  }
}
