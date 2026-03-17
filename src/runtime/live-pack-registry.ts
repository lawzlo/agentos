import crypto from "node:crypto";

function visibleLines(worldState) {
  const lines = [
    ...(worldState?.interactionCandidates ?? []).map((candidate) => candidate.text),
    ...(worldState?.ocrBlocks ?? []).map((block) => block.text),
    worldState?.visibleText ?? ""
  ]
    .flatMap((entry) => String(entry ?? "").split("\n"))
    .map((entry) => entry.trim())
    .filter(Boolean);

  return [...new Set(lines)].slice(0, 120);
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

function createVisualDesktopPack({
  name,
  defaultTriggerTexts = []
}: {
  name: string;
  defaultTriggerTexts?: string[];
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
      const match = matchTriggerText(lines, [...defaultTriggerTexts, ...(rule.watchProfile?.triggerTexts ?? [])]);
      if (!match) {
        return null;
      }

      const itemFingerprint = fingerprint(`${name}:${match}`);
      if (dedupeState.lastFingerprint === itemFingerprint) {
        return null;
      }

      return {
        fingerprint: itemFingerprint,
        summary: match,
        text: match,
        inputs: {
          watchItemText: match
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
        defaultTriggerTexts: ["unread", "new message", "new messages", "未读"]
      }),
      createVisualDesktopPack({
        name: "wechat-desktop",
        defaultTriggerTexts: ["未读", "新消息", "wechat", "微信"]
      }),
      createVisualDesktopPack({
        name: "generic-mail-desktop",
        defaultTriggerTexts: ["unread", "inbox", "mail", "邮件", "未读", "收件箱"]
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
