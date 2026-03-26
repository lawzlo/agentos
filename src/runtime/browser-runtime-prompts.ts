function cleanLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function bulletList(lines: string[]): string {
  const filtered = lines.map(cleanLine).filter(Boolean);
  if (!filtered.length) {
    return "No additional visible context was extracted.";
  }
  return filtered.map((line) => `- ${line}`).join("\n");
}

export const BROWSER_CONVERSATION_DETECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    hasUnreadConversation: { type: "boolean" },
    summary: { type: ["string", "null"] },
    senderName: { type: ["string", "null"] },
    latestInboundMessage: { type: ["string", "null"] },
    salientContext: {
      type: "array",
      items: { type: "string" }
    },
    threadSummary: { type: ["string", "null"] },
    replyable: { type: "boolean" },
    pageState: { type: ["string", "null"] },
    blocker: { type: ["string", "null"] },
    rationale: { type: ["string", "null"] }
  },
  required: ["hasUnreadConversation", "replyable", "salientContext"]
} as const;

export function buildConversationDetectionInstruction(goal: string): string {
  const normalizedGoal = cleanLine(goal);
  return [
    "Inspect the current browser page without clicking or navigating.",
    "If the page shows a conversation inbox, candidate inbox, or chat list, identify the single best unread conversation that should be handled next.",
    "Prefer a genuinely unread conversation with an inbound human message that requires a reply.",
    "If no unread conversation needs action, set hasUnreadConversation=false and leave the other fields null or empty.",
    normalizedGoal ? `User goal: ${normalizedGoal}` : null,
    "Only use information visible on the current page. Do not invent hidden messages or metadata."
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildConversationPrefillInstruction({
  goal,
  summary,
  senderName,
  latestInboundMessage,
  context,
  replyPlaceholder = "{{typeText}}"
}: {
  goal: string;
  summary: string;
  senderName?: string | null;
  latestInboundMessage?: string | null;
  context?: string[];
  replyPlaceholder?: string;
}): string {
  return [
    "Use the current page in the existing browser tab. Do not open a new tab, popup, or window.",
    "If the target conversation is not already open, open it in the same tab.",
    "Do not type anything until that target conversation is visibly open.",
    "Focus the main visible reply or message composer for that conversation.",
    "Only clear text after a visible editable composer or input is grounded.",
    "Never clear or select all on the full page, chat transcript, or any non-editable region.",
    `Prefill this exact reply text without sending it:\n${replyPlaceholder}`,
    "Do not click any send, submit, or confirm action.",
    cleanLine(goal) ? `User goal:\n${cleanLine(goal)}` : null,
    cleanLine(summary) ? `Target conversation summary: ${cleanLine(summary)}` : null,
    cleanLine(senderName) ? `Expected sender or participant: ${cleanLine(senderName)}` : null,
    cleanLine(latestInboundMessage) ? `Latest inbound message:\n${cleanLine(latestInboundMessage)}` : null,
    context?.length ? `Additional visible context:\n${bulletList(context)}` : null
  ]
    .filter(Boolean)
    .join("\n\n");
}
