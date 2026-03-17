function cloneValue<T>(value: T): T {
  if (value == null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values: unknown[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

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

function uniqueAnchors(anchors: Array<{ text?: string; role?: string | null }> = []) {
  const seen = new Set<string>();
  const result: Array<{ text: string; role: string }> = [];

  for (const anchor of anchors) {
    const text = String(anchor?.text ?? "").trim();
    if (!text) {
      continue;
    }

    const role = String(anchor?.role ?? "element");
    const key = `${role}:${text.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ text, role });
  }

  return result;
}

function selectSourceSteps(planSteps: Array<Record<string, any>> = [], executionSteps: Array<Record<string, any>> = []) {
  if (planSteps.length === 1 && planSteps[0]?.action === "autonomy" && executionSteps.length) {
    return executionSteps;
  }

  return planSteps.length ? planSteps : executionSteps;
}

function mergeParams(step: Record<string, any> = {}, executedStep: Record<string, any> | null = null) {
  const params = cloneValue(step?.params ?? {}) ?? {};
  const resolvedTarget = executedStep?.result?.resolvedTarget ?? null;

  if (resolvedTarget && !params.target) {
    params.target = cloneValue(resolvedTarget);
  }

  if (!params.targetQuery && (params.targetText || resolvedTarget?.text)) {
    params.targetQuery = params.targetText ?? resolvedTarget.text;
  }

  return params;
}

function collectTemplateInputs(taskSpec: Record<string, any> = {}) {
  const inputs = (taskSpec.inputs ?? {}) as Record<string, any>;
  const fields = [
    ["startUrl", "Start URL"],
    ["desktopApp", "Desktop App"],
    ["clickTarget", "Click Target"],
    ["typeTarget", "Type Target"],
    ["typeText", "Text To Type"],
    ["waitText", "Wait For Text"],
    ["waitUrl", "Wait For URL"],
    ["captureLabel", "Capture Label"],
    ["watchItemText", "Watch Item Text"],
    ["watchSummary", "Watch Summary"],
    ["watchContext", "Watch Context"]
  ];

  return fields
    .filter(([key]) => typeof inputs[key] === "string" && inputs[key].trim())
    .map(([key, label]) => ({
      key,
      label,
      defaultValue: String(inputs[key])
    }));
}

function parameterizeValue(value: unknown, templateInputs: Array<{ key: string; defaultValue: string }> = []): unknown {
  if (typeof value === "string") {
    const match = templateInputs.find((entry) => value === entry.defaultValue);
    return match ? `{{${match.key}}}` : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => parameterizeValue(entry, templateInputs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, parameterizeValue(entry, templateInputs)])
    );
  }

  return value;
}

function buildActionTemplate({
  planSteps = [],
  executionSteps = [],
  manualTeachSteps = [],
  templateInputs = []
}: {
  planSteps?: Array<Record<string, any>>;
  executionSteps?: Array<Record<string, any>>;
  manualTeachSteps?: Array<Record<string, any>>;
  templateInputs?: Array<{ key: string; defaultValue: string }>;
}) {
  const executionById = new Map(
    executionSteps
      .filter((step) => step?.stepId)
      .map((step) => [step.stepId, step])
  );

  const baseSteps = selectSourceSteps(planSteps, executionSteps)
    .filter((step) => step?.action && step.action !== "autonomy")
    .map((step, index) => {
      const executedStep = executionById.get(step.id ?? step.stepId) ?? executionSteps[index] ?? null;
      return {
        label: step.label,
        surface: step.surface,
        action: step.action,
        params: parameterizeValue(mergeParams(step, executedStep), templateInputs) as Record<string, unknown>,
        saveAs: step.saveAs ?? null,
        expect: parameterizeValue(cloneValue(step.expect ?? null), templateInputs) as Record<string, unknown> | null,
        checkpoint: step.checkpoint ?? true
      };
    });

  return baseSteps.concat(
    manualTeachSteps.map((step) => ({
      label: step.label,
      surface: step.surface,
      action: step.action,
      params: parameterizeValue(cloneValue(step.params ?? {}), templateInputs) as Record<string, unknown>,
      saveAs: step.saveAs ?? null,
      expect: parameterizeValue(cloneValue(step.expect ?? null), templateInputs) as Record<string, unknown> | null,
      checkpoint: step.checkpoint ?? true
    }))
  );
}

function deriveAnchors({
  planSteps = [],
  executionSteps = [],
  manualTeachSteps = []
}: {
  planSteps?: Array<Record<string, any>>;
  executionSteps?: Array<Record<string, any>>;
  manualTeachSteps?: Array<Record<string, any>>;
}) {
  const anchors: Array<{ text?: string; role?: string | null }> = [];

  for (const step of [...planSteps, ...executionSteps, ...manualTeachSteps]) {
    const target = step?.params?.target ?? step?.result?.resolvedTarget ?? null;
    const targetText = target?.text ?? step?.params?.targetQuery ?? step?.params?.text ?? "";
    const role = target?.role ?? (step?.action?.includes("type") ? "textbox" : "button");
    if (targetText) {
      anchors.push({ text: targetText, role });
    }
  }

  return uniqueAnchors(anchors);
}

export function buildTeachRecording({
  goal,
  taskSpec = {},
  planSteps = [],
  executionSteps = [],
  manualTeachSteps = [],
  manualCorrections = [],
  result = null
}: {
  goal: string;
  taskSpec?: Record<string, any>;
  planSteps?: Array<Record<string, any>>;
  executionSteps?: Array<Record<string, any>>;
  manualTeachSteps?: Array<Record<string, any>>;
  manualCorrections?: Array<Record<string, any>>;
  result?: Record<string, any> | null;
}) {
  const templateInputs = collectTemplateInputs(taskSpec);
  const actionTemplate = buildActionTemplate({
    planSteps,
    executionSteps,
    manualTeachSteps,
    templateInputs
  });
  const anchors = deriveAnchors({ planSteps, executionSteps, manualTeachSteps });
  const taskInputs = ((taskSpec as Record<string, any>).inputs ?? {}) as Record<string, any>;
  const triggerTerms = uniqueStrings([
    goal,
    taskInputs.clickTarget,
    taskInputs.typeTarget,
    taskInputs.waitText,
    taskInputs.watchItemText,
    taskInputs.watchSummary,
    ...anchors.map((anchor) => anchor.text)
  ]).slice(0, 12);
  const recoveryHints = uniqueStrings([
    ...manualCorrections.map((entry) => entry?.note),
    ...(result?.recovery?.classification ? [`recovery:${result.recovery.classification}`] : [])
  ]).slice(0, 12);
  const surfaces = uniqueStrings(actionTemplate.map((step) => step.surface ?? "unknown"));

  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    actionTemplate,
    anchors,
    templateInputs,
    triggerTerms,
    recoveryHints,
    summary: {
      sourceGoal: goal,
      stepCount: actionTemplate.length,
      surfaces,
      manualTeachStepsCount: manualTeachSteps.length,
      manualCorrectionsCount: manualCorrections.length
    }
  };
}
