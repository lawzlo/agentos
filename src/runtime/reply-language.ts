export type ReplyLanguageHint = "en" | "zh" | null;

export function inferReplyLanguage({
  summary = "",
  context = []
}: {
  summary?: string | null;
  context?: string[] | null;
}): ReplyLanguageHint {
  const sample = [summary, ...(Array.isArray(context) ? context : [])]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");

  if (!sample) {
    return null;
  }

  const chineseCount = (sample.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  const latinWordCount = (sample.match(/\b[a-z]{2,}\b/giu) ?? []).length;

  if (chineseCount >= 8 && chineseCount >= latinWordCount) {
    return "zh";
  }

  if (latinWordCount >= 6 && chineseCount <= 2) {
    return "en";
  }

  if (chineseCount >= 16) {
    return "zh";
  }

  if (latinWordCount >= 12) {
    return "en";
  }

  return null;
}
