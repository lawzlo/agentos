import type { RuntimeStep } from "../types/runtime-schema.js";

type LivePackSurface = "browser" | "desktop";

function frontmostAppExpectation(appName: string): Record<string, unknown> {
  return { frontmostApp: appName };
}

function prefillVerificationExpectation(appName: string): Record<string, unknown> {
  return {
    frontmostApp: appName,
    textVisible: "{{typeTextPreview}}"
  };
}

function desktopVisionThreadExpectation(appName: string, type: string): Record<string, unknown> {
  return {
    frontmostApp: appName,
    visualCheck: {
      type,
      targetThread: "{{threadTitle}}"
    }
  };
}

function desktopVisionPrefillExpectation(appName: string, type: string): Record<string, unknown> {
  return {
    frontmostApp: appName,
    visualCheck: {
      type,
      targetThread: "{{threadTitle}}",
      replyPreview: "{{typeTextPreview}}"
    }
  };
}

function wechatVisionThreadExpectation(): Record<string, unknown> {
  return {
    frontmostApp: "WeChat",
    visualCheck: {
      type: "wechat_thread",
      targetThread: "{{threadTitle}}"
    }
  };
}

function wechatVisionPrefillExpectation(): Record<string, unknown> {
  return {
    frontmostApp: "WeChat",
    visualCheck: {
      type: "wechat_prefill",
      targetThread: "{{threadTitle}}",
      replyPreview: "{{typeTextPreview}}"
    }
  };
}

export function buildWeChatReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Open unread WeChat conversation",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      checkpoint: false
    },
    {
      label: "Wait for WeChat thread to open",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 8000, pollMs: 500 },
      expect: wechatVisionThreadExpectation(),
      checkpoint: false
    },
    {
      label: "Focus WeChat composer area",
      surface: "desktop",
      action: "clickAt",
      params: { x: "{{composeX}}", y: "{{composeY}}" },
      expect: frontmostAppExpectation("WeChat"),
      checkpoint: false
    },
    {
      label: "Type WeChat reply",
      surface: "desktop",
      action: "typeText",
      params: { text: "{{typeText}}" },
      checkpoint: false
    },
    {
      label: "Verify WeChat prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 250, timeoutMs: 4000, pollMs: 400 },
      expect: wechatVisionPrefillExpectation(),
      checkpoint: false
    }
  ];
}

export function buildWeChatReplyStepsWithComposerFallback({
  includeSendStep = false
}: {
  includeSendStep?: boolean;
} = {}): RuntimeStep[] {
  const steps: RuntimeStep[] = [
    {
      label: "Focus WeChat",
      surface: "desktop",
      action: "focusApp",
      params: { name: "WeChat" },
      expect: frontmostAppExpectation("WeChat"),
      checkpoint: false
    },
    {
      label: "Dismiss stray WeChat overlay",
      surface: "desktop",
      action: "pressKey",
      params: { key: "Escape" },
      checkpoint: false
    },
    {
      label: "Open unread WeChat conversation",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      checkpoint: false
    },
    {
      label: "Wait for WeChat thread to open",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 8000, pollMs: 500 },
      expect: wechatVisionThreadExpectation(),
      checkpoint: false
    },
    {
      label: "Focus WeChat composer area",
      surface: "desktop",
      action: "clickAt",
      params: { x: "{{composeX}}", y: "{{composeY}}" },
      expect: frontmostAppExpectation("WeChat"),
      checkpoint: false
    },
    {
      label: "Type WeChat reply",
      surface: "desktop",
      action: "typeText",
      params: { text: "{{typeText}}" },
      checkpoint: false
    },
    {
      label: "Verify WeChat prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 250, timeoutMs: 4000, pollMs: 400 },
      expect: wechatVisionPrefillExpectation(),
      checkpoint: false
    }
  ];
  if (includeSendStep) {
    steps.push({
      label: "Send WeChat reply",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{sendTarget}}" },
      checkpoint: false
    });
  }
  return steps;
}

export function buildMailReplySteps(surface: LivePackSurface): RuntimeStep[] {
  return [
    {
      label: "Open unread mail thread",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      ...(surface === "desktop" ? { expect: frontmostAppExpectation("Mail") } : {}),
      checkpoint: false
    },
    {
      label: "Wait for mail composer",
      surface,
      action: "waitForTarget",
      params: { targetQuery: "{{typeTarget}}", timeoutMs: 5000 },
      checkpoint: false
    },
    {
      label: "Type mail reply",
      surface,
      action: "typeIntoTarget",
      params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}", clear: false },
      ...(surface === "desktop" ? { expect: prefillVerificationExpectation("Mail") } : { expect: { textVisible: "{{typeTextPreview}}" } }),
      checkpoint: false
    },
    {
      label: "Send mail reply",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{sendTarget}}" },
      checkpoint: false
    }
  ];
}

export function buildOutlookDesktopComposePrefillSteps(): RuntimeStep[] {
  return [
    {
      label: "Focus Outlook",
      surface: "desktop",
      action: "focusApp",
      params: { name: "Microsoft Outlook" },
      expect: frontmostAppExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Focus Outlook composer",
      surface: "desktop",
      action: "focusTarget",
      params: {
        target: "{{composeTarget}}",
        allowBoundsFallback: true
      },
      expect: frontmostAppExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Type Outlook reply",
      surface: "desktop",
      action: "typeIntoTarget",
      params: {
        target: "{{composeTarget}}",
        text: "{{typeText}}",
        clear: true,
        inputMethod: "paste",
        allowBoundsFallback: true
      },
      checkpoint: false
    },
    {
      label: "Verify Outlook prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 700, timeoutMs: 5000, pollMs: 500 },
      expect: {
        frontmostApp: "Outlook",
        regionTextAnyVisible: [
          {
            text: "{{typeTextPreview}}",
            region: "{{composeVerifyRegion}}",
            scale: 2.4
          },
          {
            text: "{{typeTextMiddlePreview}}",
            region: "{{composeVerifyRegion}}",
            scale: 2.4
          },
          {
            text: "{{typeTextTailPreview}}",
            region: "{{composeVerifyRegion}}",
            scale: 2.4
          },
          {
            text: "{{typeTextSuffixPreview}}",
            region: "{{composeVerifyRegion}}",
            scale: 2.4
          }
        ]
      },
      checkpoint: false
    },
    {
      label: "Send Outlook reply",
      surface: "desktop",
      action: "clickTarget",
      params: {
        target: "{{sendTargetCandidate}}",
        targetQuery: "{{sendTargetQuery}}",
        allowBoundsFallback: false
      },
      checkpoint: false
    }
  ];
}

export function buildSlackDesktopVisualReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Focus Slack",
      surface: "desktop",
      action: "focusApp",
      params: { name: "Slack" },
      expect: frontmostAppExpectation("Slack"),
      checkpoint: false
    },
    {
      label: "Dismiss stray Slack overlay",
      surface: "desktop",
      action: "pressKey",
      params: { key: "Escape" },
      checkpoint: false
    },
    {
      label: "Open unread Slack thread",
      surface: "desktop",
      action: "clickAt",
      params: { x: "{{openX}}", y: "{{openY}}" },
      checkpoint: false
    },
    {
      label: "Wait for Slack thread to open",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 8000, pollMs: 500 },
      expect: desktopVisionThreadExpectation("Slack", "slack_thread"),
      checkpoint: false
    },
    {
      label: "Focus Slack composer area",
      surface: "desktop",
      action: "clickAt",
      params: { x: "{{composeX}}", y: "{{composeY}}" },
      expect: frontmostAppExpectation("Slack"),
      checkpoint: false
    },
    {
      label: "Type Slack reply",
      surface: "desktop",
      action: "typeText",
      params: { text: "{{typeText}}" },
      checkpoint: false
    },
    {
      label: "Verify Slack prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 250, timeoutMs: 4000, pollMs: 400 },
      expect: desktopVisionPrefillExpectation("Slack", "slack_prefill"),
      checkpoint: false
    }
  ];
}

export function buildOutlookDesktopVisualReplySteps(): RuntimeStep[] {
  return [
    {
      label: "Focus Outlook",
      surface: "desktop",
      action: "focusApp",
      params: { name: "Microsoft Outlook" },
      expect: frontmostAppExpectation("Outlook"),
      checkpoint: false
    },
    {
      label: "Open unread Outlook thread",
      surface: "desktop",
      action: "clickAt",
      params: {
        x: "{{openX}}",
        y: "{{openY}}"
      },
      checkpoint: false
    },
    {
      label: "Wait for Outlook thread to open",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 8000, pollMs: 500 },
      expect: desktopVisionThreadExpectation("Outlook", "outlook_thread"),
      checkpoint: false
    },
    {
      label: "Open Outlook reply composer",
      surface: "desktop",
      action: "clickTarget",
      params: { targetQuery: "{{replyTargetQuery}}", allowBoundsFallback: false },
      checkpoint: false
    },
    {
      label: "Wait for Outlook composer",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 4000, pollMs: 500 },
      checkpoint: false
    },
    {
      label: "Type Outlook reply",
      surface: "desktop",
      action: "typeText",
      params: { text: "{{typeText}}" },
      checkpoint: false
    },
    {
      label: "Verify Outlook prefill",
      surface: "desktop",
      action: "wait",
      params: { ms: 500, timeoutMs: 5000, pollMs: 500 },
      expect: desktopVisionPrefillExpectation("Outlook", "outlook_prefill"),
      checkpoint: false
    }
  ];
}

export function buildSlackReplySteps(surface: LivePackSurface): RuntimeStep[] {
  return [
    {
      label: "Open unread Slack thread",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{openTarget}}" },
      ...(surface === "desktop" ? { expect: frontmostAppExpectation("Slack") } : {}),
      checkpoint: false
    },
    {
      label: "Wait for Slack composer",
      surface,
      action: "waitForTarget",
      params: { targetQuery: "{{typeTarget}}", timeoutMs: 5000 },
      checkpoint: false
    },
    {
      label: "Type Slack reply",
      surface,
      action: "typeIntoTarget",
      params: { targetQuery: "{{typeTarget}}", text: "{{typeText}}", clear: false },
      ...(surface === "desktop" ? { expect: prefillVerificationExpectation("Slack") } : { expect: { textVisible: "{{typeTextPreview}}" } }),
      checkpoint: false
    },
    {
      label: "Send Slack reply",
      surface,
      action: "clickTarget",
      params: { targetQuery: "{{sendTarget}}" },
      checkpoint: false
    }
  ];
}

export function buildBossReplySteps({
  includeOpenStep = true,
  composeReady = false
}: {
  includeOpenStep?: boolean;
  composeReady?: boolean;
} = {}): RuntimeStep[] {
  const steps: RuntimeStep[] = [];
  if (includeOpenStep) {
    steps.push({
      label: "Open BOSS candidate detail",
      surface: "browser",
      action: "clickTarget",
      params: { target: "{{openCandidate}}", targetQuery: "{{openTarget}}" },
      checkpoint: false
    });
  }

  steps.push(
    composeReady
      ? {
          label: "Wait for BOSS thread selection to settle",
          surface: "browser",
          action: "wait",
          params: { ms: 500 },
          checkpoint: false
        }
      : {
          label: "Wait for BOSS candidate thread",
          surface: "browser",
          action: "waitForTarget",
          params: { target: "{{composeTarget}}", targetQuery: "{{typeTarget}}", timeoutMs: 5000 },
          checkpoint: false
        },
    {
      label: "Type BOSS reply",
      surface: "browser",
      action: "typeIntoTarget",
      params: { target: "{{composeTarget}}", targetQuery: "{{typeTarget}}", text: "{{typeText}}", clear: true },
      expect: {
        textVisible: "{{typeTextPreview}}",
        draftThreadVisible: "{{watchItemText}}"
      },
      checkpoint: false
    },
    {
      label: "Send BOSS reply",
      surface: "browser",
      action: "clickTarget",
      params: { target: "{{sendTargetCandidate}}", targetQuery: "{{sendTarget}}" },
      checkpoint: false
    }
  );

  return steps;
}
