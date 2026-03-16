import { BUILTIN_SKILLS } from "./builtin-skills.js";

function normalizeSkill(skill) {
  return {
    name: skill.name,
    surfaceScope: skill.surfaceScope ?? "any",
    triggerTerms: skill.triggerTerms ?? [],
    anchors: skill.anchors ?? [],
    actionTemplate: skill.actionTemplate ?? [],
    successCriteria: skill.successCriteria ?? [],
    recoveryHints: skill.recoveryHints ?? [],
    metadata: skill.metadata ?? {}
  };
}

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

function buildActionTemplate({ planSteps = [], executionSteps = [] }) {
  const executionById = new Map(
    executionSteps
      .filter((step) => step?.stepId)
      .map((step) => [step.stepId, step])
  );

  return selectSourceSteps(planSteps, executionSteps)
    .filter((step) => step?.action && step.action !== "autonomy")
    .map((step, index) => {
      const executedStep = executionById.get(step.id ?? step.stepId) ?? executionSteps[index] ?? null;
      const params = mergeParams(step, executedStep);
      return {
        label: step.label,
        surface: step.surface,
        action: step.action,
        params,
        saveAs: step.saveAs,
        expect: cloneValue(step.expect ?? null),
        checkpoint: step.checkpoint
      };
    });
}

function deriveAnchors({ planSteps = [], executionSteps = [] }) {
  const anchors = [];

  for (const step of [...planSteps, ...executionSteps]) {
    const target = step?.params?.target ?? step?.result?.resolvedTarget ?? null;
    const targetText = target?.text ?? step?.params?.targetQuery ?? step?.params?.text ?? "";
    const role = target?.role ?? (step?.action?.includes("type") ? "textbox" : "button");
    if (targetText) {
      anchors.push({ text: targetText, role });
    }
  }

  return uniqueAnchors(anchors);
}

function collectSkillInputs(taskSpec = {}) {
  const inputs = taskSpec.inputs ?? {};
  const fields = [
    ["startUrl", "Start URL"],
    ["desktopApp", "Desktop App"],
    ["clickTarget", "Click Target"],
    ["typeTarget", "Type Target"],
    ["typeText", "Text To Type"],
    ["waitText", "Wait For Text"],
    ["waitUrl", "Wait For URL"],
    ["captureLabel", "Capture Label"]
  ];

  return fields
    .filter(([key]) => typeof inputs[key] === "string" && inputs[key].trim())
    .map(([key, label]) => ({
      key,
      label,
      defaultValue: inputs[key]
    }));
}

function parameterizeValue(value, skillInputs = []) {
  if (typeof value === "string") {
    const match = skillInputs.find((entry) => value === entry.defaultValue);
    return match ? `{{${match.key}}}` : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => parameterizeValue(entry, skillInputs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, parameterizeValue(entry, skillInputs)])
    );
  }

  return value;
}

export class SkillRegistry {
  constructor(store) {
    this.store = store;
    this.#seedBuiltins();
  }

  #seedBuiltins() {
    for (const skill of BUILTIN_SKILLS) {
      this.putSkill(skill);
    }
  }

  listSkills() {
    return this.store.listSkills();
  }

  getSkill(name) {
    return this.store.getSkill(name);
  }

  putSkill(skill) {
    return this.store.putSkill(normalizeSkill(skill));
  }

  matchSkill({ goal = "", preferredSurface = "any" }) {
    const query = goal.toLowerCase();
    const skills = this.store.listSkills();
    const ranked = skills
      .filter((skill) => skill.surfaceScope === "any" || preferredSurface === "auto" || skill.surfaceScope === preferredSurface)
      .map((skill) => {
        const scores = [skill.name, ...(skill.triggerTerms ?? [])].map((term) => {
          const normalized = String(term ?? "").toLowerCase();
          if (!normalized) {
            return 0;
          }
          if (query === normalized) {
            return 3;
          }
          if (query.includes(normalized) || normalized.includes(query)) {
            return 2;
          }
          return normalized.split(/\s+/).some((token) => query.includes(token)) ? 1 : 0;
        });

        return {
          skill,
          score: Math.max(...scores)
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);

    return ranked[0]?.skill ?? null;
  }

  saveExecutionAsSkill({
    name,
    surfaceScope,
    goal,
    result,
    taskId,
    taskSpec = {},
    planSteps = [],
    executionSteps = [],
    manualCorrections = [],
    manualTeachSteps = []
  }) {
    const rawActionTemplate = buildActionTemplate({ planSteps, executionSteps }).concat(
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
    const skillInputs = collectSkillInputs(taskSpec);
    const actionTemplate = rawActionTemplate.map((step) => ({
      ...step,
      params: parameterizeValue(step.params, skillInputs),
      expect: parameterizeValue(step.expect, skillInputs)
    }));
    const anchors = deriveAnchors({ planSteps, executionSteps });
    const surfaces = uniqueStrings(actionTemplate.map((step) => step.surface));
    const normalizedSurfaceScope =
      surfaceScope && surfaceScope !== "auto"
        ? surfaceScope
        : surfaces.length === 1
          ? surfaces[0]
          : "any";
    const triggerTerms = uniqueStrings([
      goal,
      ...(taskSpec.inputs?.clickTarget ? [taskSpec.inputs.clickTarget] : []),
      ...(taskSpec.inputs?.typeTarget ? [taskSpec.inputs.typeTarget] : []),
      ...anchors.map((anchor) => anchor.text)
    ]).slice(0, 8);
    const recoveryHints = uniqueStrings([
      ...manualCorrections.map((entry) => entry?.note),
      ...(result?.recovery?.classification ? [`recovery:${result.recovery.classification}`] : [])
    ]).slice(0, 8);

    return this.putSkill({
      name,
      surfaceScope: normalizedSurfaceScope,
      triggerTerms,
      anchors,
      actionTemplate,
      successCriteria: result?.verification?.checks ?? [],
      recoveryHints,
      metadata: {
        generatedFromExecution: true,
        learnedFromTaskId: taskId ?? null,
        sourceGoal: goal,
        executionMode: taskSpec.executionMode ?? "planned",
        manualCorrectionsCount: manualCorrections.length,
        manualTeachStepsCount: manualTeachSteps.length,
        skillInputs
      }
    });
  }
}
