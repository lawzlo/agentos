function cloneValue(value) {
  if (value == null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

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

function uniqueAnchors(anchors = []) {
  const seen = new Set();
  const result = [];

  for (const anchor of anchors) {
    const text = String(anchor?.text ?? "").trim();
    if (!text) {
      continue;
    }

    const role = anchor?.role ?? "element";
    const key = `${role}:${text.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ text, role });
  }

  return result;
}

function selectSourceSteps(planSteps = [], executionSteps = []) {
  if (planSteps.length === 1 && planSteps[0]?.action === "autonomy" && executionSteps.length) {
    return executionSteps;
  }

  return planSteps.length ? planSteps : executionSteps;
}

function mergeParams(step, executedStep) {
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

function buildActionTemplate({ planSteps = [], executionSteps = [], manualTeachSteps = [] }) {
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
        params: mergeParams(step, executedStep),
        saveAs: step.saveAs ?? null,
        expect: cloneValue(step.expect ?? null),
        checkpoint: step.checkpoint ?? true
      };
    });

  return baseSteps.concat(
    manualTeachSteps.map((step) => ({
      label: step.label,
      surface: step.surface,
      action: step.action,
      params: cloneValue(step.params ?? {}),
      saveAs: step.saveAs ?? null,
      expect: cloneValue(step.expect ?? null),
      checkpoint: step.checkpoint ?? true
    }))
  );
}

function deriveAnchors({ planSteps = [], executionSteps = [], manualTeachSteps = [] }) {
  const anchors = [];

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

function collectWatchInputs(taskSpec: Record<string, any> = {}) {
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
    ["watchSummary", "Watch Summary"]
  ];

  return fields
    .filter(([key]) => typeof inputs[key] === "string" && inputs[key].trim())
    .map(([key, label]) => ({
      key,
      label,
      defaultValue: inputs[key]
    }));
}

function parameterizeValue(value, templateInputs = []) {
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

export function materializeWatchValue(value, runtimeInputs = {}, templateInputs = []) {
  if (typeof value === "string") {
    const match = value.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);
    if (!match) {
      return value;
    }

    const key = match[1];
    if (runtimeInputs[key] != null && runtimeInputs[key] !== "") {
      return runtimeInputs[key];
    }

    return templateInputs.find((entry) => entry.key === key)?.defaultValue ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => materializeWatchValue(entry, runtimeInputs, templateInputs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, materializeWatchValue(entry, runtimeInputs, templateInputs)])
    );
  }

  return value;
}

export function materializeWatchActionTemplate(actionTemplate = [], runtimeInputs = {}, templateInputs = []) {
  return actionTemplate.map((step) => ({
    ...step,
    params: materializeWatchValue(step.params ?? {}, runtimeInputs, templateInputs),
    expect: materializeWatchValue(step.expect ?? null, runtimeInputs, templateInputs)
  }));
}

export function deriveWatchProfileFromExecution({
  goal,
  taskId,
  taskSpec = {},
  planSteps = [],
  executionSteps = [],
  manualTeachSteps = [],
  manualCorrections = [],
  result = null,
  overrides = {} as Record<string, any>
}) {
  const taskInputs = ((taskSpec as Record<string, any>).inputs ?? {}) as Record<string, any>;
  const rawActionTemplate = buildActionTemplate({
    planSteps,
    executionSteps,
    manualTeachSteps
  });
  const templateInputs = collectWatchInputs(taskSpec);
  const actionTemplate = rawActionTemplate.map((step) => ({
    ...step,
    params: parameterizeValue(step.params, templateInputs),
    expect: parameterizeValue(step.expect, templateInputs)
  }));
  const anchors = deriveAnchors({ planSteps, executionSteps, manualTeachSteps });
  const triggerTexts = uniqueStrings([
    ...(overrides.triggerTexts ?? []),
    ...(taskInputs.waitText ? [taskInputs.waitText] : []),
    ...(taskInputs.clickTarget ? [taskInputs.clickTarget] : []),
    ...(taskInputs.watchItemText ? [taskInputs.watchItemText] : []),
    ...(taskInputs.watchSummary ? [taskInputs.watchSummary] : []),
    ...anchors.map((anchor) => anchor.text)
  ]).slice(0, 10);
  const recoveryHints = uniqueStrings([
    ...(overrides.recoveryHints ?? []),
    ...manualCorrections.map((entry) => entry?.note),
    ...(result?.recovery?.classification ? [`recovery:${result.recovery.classification}`] : [])
  ]).slice(0, 10);

  return {
    triggerTexts,
    anchors,
    actionTemplate,
    recoveryHints,
    executionMode: "planned",
    metadata: {
      learnedFromTaskId: taskId ?? null,
      sourceGoal: goal,
      manualCorrectionsCount: manualCorrections.length,
      manualTeachStepsCount: manualTeachSteps.length,
      templateInputs
    }
  };
}
