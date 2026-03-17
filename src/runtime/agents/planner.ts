import { createId } from "../id.js";
import { PlanningError } from "../errors.js";

export function normalizeStep(step, index) {
  return {
    id: step.id ?? createId(`step${index + 1}`),
    label: step.label ?? `Step ${index + 1}`,
    surface: step.surface ?? "browser",
    action: step.action,
    params: step.params ?? {},
    expect: step.expect ?? null,
    saveAs: step.saveAs ?? null,
    checkpoint: step.checkpoint ?? true
  };
}

export function describeStep(step) {
  const params = step.params ?? {};

  switch (step.action) {
    case "goto":
      return `Open ${params.url}`;
    case "clickTarget":
      return `Click "${params.targetQuery ?? params.target?.text ?? step.label}"`;
    case "typeIntoTarget":
      return `Type into "${params.targetQuery ?? params.target?.text ?? step.label}"`;
    case "waitFor":
      if (params.urlIncludes) {
        return `Wait for ${params.urlIncludes}`;
      }
      if (params.text) {
        return `Wait for "${params.text}" to appear`;
      }
      return "Wait for the page to settle";
    case "capture":
      return "Capture a screenshot";
    case "launchApp":
      return `Open ${params.name}`;
    case "focusApp":
      return `Bring ${params.name} to the front`;
    case "typeText":
      return "Type text";
    case "waitForText":
      return `Wait for "${params.text}" on screen`;
    default:
      return step.label ?? step.action;
  }
}

function materializeSkillValue(value, runtimeInputs = {}, skillInputs = []) {
  if (typeof value === "string") {
    const match = value.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);
    if (!match) {
      return value;
    }

    const key = match[1];
    if (runtimeInputs[key] != null && runtimeInputs[key] !== "") {
      return runtimeInputs[key];
    }

    return skillInputs.find((entry) => entry.key === key)?.defaultValue ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => materializeSkillValue(entry, runtimeInputs, skillInputs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, materializeSkillValue(entry, runtimeInputs, skillInputs)])
    );
  }

  return value;
}

function materializeSkillSteps(skill, taskSpec = {}) {
  const runtimeInputs = (taskSpec as Record<string, unknown>).inputs ?? {};
  const skillInputs = skill.metadata?.skillInputs ?? [];

  return (skill.actionTemplate ?? []).map((step) => ({
    ...step,
    params: materializeSkillValue(step.params ?? {}, runtimeInputs, skillInputs),
    expect: materializeSkillValue(step.expect ?? null, runtimeInputs, skillInputs)
  }));
}

function heuristicPlan(taskSpec) {
  const steps = [];
  const inputs = taskSpec.inputs ?? {};
  const actions = inputs.actions;
  const defaultSurface =
    taskSpec.preferredSurface === "desktop" || (!inputs.startUrl && inputs.desktopApp)
      ? "desktop"
      : "browser";

  if (Array.isArray(actions) && actions.length) {
    return actions.map((step, index) => normalizeStep(step, index));
  }

  if (Array.isArray(taskSpec.steps) && taskSpec.steps.length) {
    return taskSpec.steps.map((step, index) => normalizeStep(step, index));
  }

  if (defaultSurface === "browser" && inputs.startUrl) {
    steps.push(
      normalizeStep(
        {
          label: "Open target page",
          surface: "browser",
          action: "goto",
          params: { url: inputs.startUrl },
          expect: { urlIncludes: String(inputs.startUrl).replace(/^https?:\/\//, "").split("/")[0] }
        },
        steps.length
      )
    );
  }

  if (inputs.form && typeof inputs.form === "object") {
    for (const [selector, value] of Object.entries(inputs.form)) {
      steps.push(
        normalizeStep(
          {
            label: `Fill ${selector}`,
            surface: "browser",
            action: "type",
            params: { selector, text: String(value), clear: true }
          },
          steps.length
        )
      );
    }
  }

  if (defaultSurface === "browser" && inputs.typeTarget && inputs.typeText) {
    steps.push(
      normalizeStep(
        {
          label: `Type into ${inputs.typeTarget}`,
          surface: "browser",
          action: "typeIntoTarget",
          params: { targetQuery: String(inputs.typeTarget), text: String(inputs.typeText), clear: true }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "browser" && inputs.submitSelector) {
    steps.push(
      normalizeStep(
        {
          label: "Submit form",
          surface: "browser",
          action: "click",
          params: { selector: inputs.submitSelector }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "browser" && inputs.clickTarget) {
    steps.push(
      normalizeStep(
        {
          label: `Click ${inputs.clickTarget}`,
          surface: "browser",
          action: "clickTarget",
          params: { targetQuery: String(inputs.clickTarget) }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "browser" && inputs.waitUrl) {
    steps.push(
      normalizeStep(
        {
          label: `Wait for ${inputs.waitUrl}`,
          surface: "browser",
          action: "waitFor",
          params: { urlIncludes: String(inputs.waitUrl) },
          expect: { urlIncludes: String(inputs.waitUrl) }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "browser" && inputs.waitText) {
    steps.push(
      normalizeStep(
        {
          label: `Wait for ${inputs.waitText}`,
          surface: "browser",
          action: "waitFor",
          params: { text: String(inputs.waitText) },
          expect: { textVisible: String(inputs.waitText) }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "browser" && inputs.capture) {
    steps.push(
      normalizeStep(
        {
          label: "Capture page",
          surface: "browser",
          action: "capture",
          params: { label: inputs.captureLabel ?? "capture" },
          saveAs: "capture"
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "desktop" && inputs.desktopApp) {
    steps.push(
      normalizeStep(
        {
          label: `Open ${inputs.desktopApp}`,
          surface: "desktop",
          action: "launchApp",
          params: { name: String(inputs.desktopApp) }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "desktop" && inputs.typeTarget && inputs.typeText) {
    steps.push(
      normalizeStep(
        {
          label: `Type into ${inputs.typeTarget}`,
          surface: "desktop",
          action: "typeIntoTarget",
          params: { targetQuery: String(inputs.typeTarget), text: String(inputs.typeText) }
        },
        steps.length
      )
    );
  } else if (defaultSurface === "desktop" && inputs.typeText) {
    steps.push(
      normalizeStep(
        {
          label: "Type text",
          surface: "desktop",
          action: "typeText",
          params: { text: String(inputs.typeText) }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "desktop" && inputs.waitText) {
    steps.push(
      normalizeStep(
        {
          label: `Wait for ${inputs.waitText}`,
          surface: "desktop",
          action: "waitForText",
          params: { text: String(inputs.waitText), timeoutMs: 5000 }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "desktop" && inputs.clickTarget) {
    steps.push(
      normalizeStep(
        {
          label: `Click ${inputs.clickTarget}`,
          surface: "desktop",
          action: "clickTarget",
          params: { targetQuery: String(inputs.clickTarget) }
        },
        steps.length
      )
    );
  }

  if (defaultSurface === "desktop" && inputs.capture) {
    steps.push(
      normalizeStep(
        {
          label: "Capture screen",
          surface: "desktop",
          action: "capture",
          params: { label: inputs.captureLabel ?? "capture" },
          saveAs: "capture"
        },
        steps.length
      )
    );
  }

  return steps;
}

export class PlannerAgent {
  modelClient: any;
  traceStore: any;
  skillRegistry: any;
  constructor({ modelClient, traceStore, skillRegistry }) {
    this.modelClient = modelClient;
    this.traceStore = traceStore;
    this.skillRegistry = skillRegistry;
  }

  async #derivePlan(task) {
    const requestedSkill = task.taskSpec.skillName ? this.skillRegistry?.getSkill(task.taskSpec.skillName) : null;
    if (requestedSkill?.actionTemplate?.length) {
      return {
        steps: materializeSkillSteps(requestedSkill, task.taskSpec).map((step, index) => normalizeStep(step, index)),
        source: "requested_skill",
        summary: `Use the saved skill ${requestedSkill.name}.`,
        skillName: requestedSkill.name
      };
    }

    const matchedSkill = this.skillRegistry?.matchSkill({
      goal: task.goal,
      preferredSurface: task.preferredSurface
    });
    if (matchedSkill?.actionTemplate?.length) {
      return {
        steps: materializeSkillSteps(matchedSkill, task.taskSpec).map((step, index) => normalizeStep(step, index)),
        source: "matched_skill",
        summary: `Reuse the matched skill ${matchedSkill.name}.`,
        skillName: matchedSkill.name
      };
    }

    if (Array.isArray(task.taskSpec.steps) && task.taskSpec.steps.length) {
      return {
        steps: task.taskSpec.steps.map((step, index) => normalizeStep(step, index)),
        source: "explicit_steps",
        summary: "Run the exact steps you provided."
      };
    }

    if (this.modelClient.isConfigured()) {
      const response = await this.modelClient.planTask(task.taskSpec);
      return {
        steps: (response.steps ?? []).map((step, index) => normalizeStep(step, index)),
        source: "model",
        summary: response.summary ?? "Use a model-generated plan."
      };
    }

    return {
      steps: heuristicPlan(task.taskSpec),
      source: "heuristic",
      summary: "Use a local plan based on your request."
    };
  }

  async preview(taskSpec) {
    const task = {
      id: "preview",
      goal: taskSpec.goal,
      preferredSurface: taskSpec.preferredSurface ?? "auto",
      taskSpec
    };
    const result = await this.#derivePlan(task);

    if (!result.steps.length) {
      throw new PlanningError(
        "No executable plan could be derived. Add more detail or switch to Advanced JSON.",
        { goal: task.goal }
      );
    }

    return {
      ...result,
      humanPlan: result.steps.map((step) => describeStep(step))
    };
  }

  async plan(task, traceId) {
    const result = await this.#derivePlan(task);
    if (!result.steps.length) {
      throw new PlanningError(
        "No executable plan could be derived. Provide task.steps or model configuration.",
        { goal: task.goal }
      );
    }

    this.traceStore.log({
      traceId,
      taskId: task.id,
      role: "planner",
      type: "plan.generated",
      message:
        result.source === "requested_skill"
          ? `Planner loaded skill ${result.skillName}.`
          : result.source === "matched_skill"
            ? `Planner matched skill ${result.skillName}.`
            : result.source === "explicit_steps"
              ? "Planner accepted explicit task steps."
              : result.source === "model"
                ? "Planner generated steps through the model provider."
                : "Planner generated a heuristic plan.",
      payload: {
        stepCount: result.steps.length,
        summary: result.summary ?? null,
        source: result.source,
        skillName: result.skillName ?? null
      }
    });

    return result.steps;
  }
}
