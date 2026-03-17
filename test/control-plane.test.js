import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir, startAgentServer, startFixtureServer, startModelServer, waitForTask } from "./helpers.js";
test("browser task runs, captures trace, and exposes outputs", async () => {
    const dataDir = await createTempDir();
    const fixture = await startFixtureServer();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Fill the demo form and verify the result.",
                preferredSurface: "browser",
                steps: [
                    {
                        label: "Open demo page",
                        surface: "browser",
                        action: "goto",
                        params: { url: fixture.url },
                        expect: { urlIncludes: fixture.url }
                    },
                    {
                        label: "Fill the form",
                        surface: "browser",
                        action: "type",
                        params: { selector: "#name", text: "AgentOS", clear: true }
                    },
                    {
                        label: "Submit",
                        surface: "browser",
                        action: "click",
                        params: { selector: "#submit" }
                    },
                    {
                        label: "Wait for status",
                        surface: "browser",
                        action: "waitFor",
                        params: { selector: "#status" },
                        expect: { selectorText: { selector: "#status", equals: "Submitted: AgentOS" } }
                    },
                    {
                        label: "Extract status",
                        surface: "browser",
                        action: "extractText",
                        params: { selector: "#status" },
                        saveAs: "status"
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.status, "completed");
        assert.equal(completed.result.outputs.status.text, "Submitted: AgentOS");
        assert.ok(completed.trace.events.length > 0);
        assert.ok(completed.artifacts.some((artifact) => artifact.kind === "screenshot"));
        const traceResponse = await fetch(`${server.baseUrl}/traces/${completed.traceId}`);
        const { trace } = await traceResponse.json();
        assert.equal(trace.status, "completed");
        assert.ok(trace.events.some((event) => event.type === "verification.summary"));
    }
    finally {
        await fixture.close();
        await server.close();
    }
});
test("browser tasks can ground natural-language targets into actions", async () => {
    const dataDir = await createTempDir();
    const fixture = await startFixtureServer();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Use grounded targets to submit the demo form.",
                preferredSurface: "browser",
                steps: [
                    {
                        label: "Open demo page",
                        surface: "browser",
                        action: "goto",
                        params: { url: fixture.url },
                        expect: { urlIncludes: fixture.url }
                    },
                    {
                        label: "Type name into the form",
                        surface: "browser",
                        action: "typeIntoTarget",
                        params: { targetQuery: "name", text: "Grounded", clear: true }
                    },
                    {
                        label: "Click submit button",
                        surface: "browser",
                        action: "clickTarget",
                        params: { targetQuery: "submit" }
                    },
                    {
                        label: "Read status",
                        surface: "browser",
                        action: "extractText",
                        params: { selector: "#status" },
                        saveAs: "status",
                        expect: { selectorText: { selector: "#status", equals: "Submitted: Grounded" } }
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.status, "completed");
        assert.equal(completed.result.outputs.status.text, "Submitted: Grounded");
        assert.ok(completed.trace.events.some((event) => event.type === "grounding.resolved"));
        assert.ok(completed.trace.events.some((event) => event.type === "target.grounded"));
    }
    finally {
        await fixture.close();
        await server.close();
    }
});
test("planned tasks verify step expectations inline before later navigation", async () => {
    const dataDir = await createTempDir();
    const fixture = await startFixtureServer();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Open the fixture, navigate away, and still preserve earlier step verification.",
                preferredSurface: "browser",
                steps: [
                    {
                        label: "Open demo page",
                        surface: "browser",
                        action: "goto",
                        params: { url: fixture.url },
                        expect: { urlIncludes: fixture.url }
                    },
                    {
                        label: "Click More information",
                        surface: "browser",
                        action: "clickTarget",
                        params: { targetQuery: "More information" }
                    },
                    {
                        label: "Wait for next page",
                        surface: "browser",
                        action: "waitFor",
                        params: { urlIncludes: "/next" },
                        expect: { urlIncludes: "/next" }
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.status, "completed");
        assert.ok(completed.trace.events.some((event) => event.type === "step.verified"));
        assert.ok(completed.trace.events.some((event) => event.message.includes("Open demo page")));
    }
    finally {
        await fixture.close();
        await server.close();
    }
});
test("event ingestion can create tasks through the unified inbox", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const response = await fetch(`${server.baseUrl}/events`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                type: "email",
                source: "mailbox",
                payload: {
                    taskSpec: {
                        goal: "Open a desktop app placeholder task",
                        preferredSurface: "desktop",
                        steps: [
                            {
                                label: "Wait locally",
                                surface: "desktop",
                                action: "wait",
                                params: { ms: 10 },
                                checkpoint: false
                            }
                        ]
                    }
                }
            })
        });
        const payload = await response.json();
        assert.ok(payload.task.id);
        const completed = await waitForTask(server.baseUrl, payload.task.id, (task) => task.status === "completed");
        assert.equal(completed.status, "completed");
        const eventsResponse = await fetch(`${server.baseUrl}/events`);
        const eventsPayload = await eventsResponse.json();
        assert.equal(eventsPayload.events.length, 1);
        assert.equal(eventsPayload.events[0].type, "email");
    }
    finally {
        await server.close();
    }
});
test("policy endpoint reports baseline task risk", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const response = await fetch(`${server.baseUrl}/policy/evaluate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Submit the payment form",
                doneCondition: "Send the payment confirmation"
            })
        });
        const payload = await response.json();
        assert.equal(payload.evaluation.riskLevel, "high");
        assert.ok(payload.evaluation.reasons.length >= 1);
    }
    finally {
        await server.close();
    }
});
test("task preview can turn a plain-language request into a human plan", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const response = await fetch(`${server.baseUrl}/tasks/preview`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "打开 example.com，点击 More information，然后截图",
                preferredSurface: "browser"
            })
        });
        const payload = await response.json();
        assert.equal(payload.preview.source, "heuristic");
        assert.equal(payload.preview.plan[0].action, "goto");
        assert.equal(payload.preview.plan[1].action, "clickTarget");
        assert.equal(payload.preview.plan.at(-1).action, "capture");
        assert.match(payload.preview.humanPlan[0], /Open/i);
        assert.equal(payload.preview.evaluation.riskLevel, "normal");
    }
    finally {
        await server.close();
    }
});
test("task preview keeps explicit URLs clean when Chinese punctuation follows the link", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const response = await fetch(`${server.baseUrl}/tasks/preview`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "打开 https://example.com，点击 More information，然后截图",
                preferredSurface: "browser"
            })
        });
        const payload = await response.json();
        assert.equal(payload.preview.taskSpec.inputs.startUrl, "https://example.com");
        assert.equal(payload.preview.plan[0].params.url, "https://example.com");
        assert.equal(payload.preview.plan[1].params.targetQuery, "More information");
    }
    finally {
        await server.close();
    }
});
test("running tasks can be paused and resumed through the control API", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Pause and resume a desktop wait sequence",
                preferredSurface: "desktop",
                steps: [
                    {
                        label: "Wait one",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 800 },
                        checkpoint: false
                    },
                    {
                        label: "Wait two",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 800 },
                        checkpoint: false
                    },
                    {
                        label: "Wait three",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 200 },
                        checkpoint: false
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        await waitForTask(server.baseUrl, task.id, (current) => ["planning", "running"].includes(current.status) && Boolean(current.traceId));
        await fetch(`${server.baseUrl}/tasks/${task.id}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "pause" })
        });
        const paused = await waitForTask(server.baseUrl, task.id, (current) => current.status === "paused");
        assert.equal(paused.runtimeControl.mode, "paused");
        assert.ok(paused.trace.events.some((event) => event.type === "control.paused"));
        await fetch(`${server.baseUrl}/tasks/${task.id}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "resume" })
        });
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.status, "completed");
        assert.ok(completed.trace.events.some((event) => event.type === "control.resumed"));
    }
    finally {
        await server.close();
    }
});
test("running tasks can be taken over and returned to the agent", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Take over a desktop wait sequence",
                preferredSurface: "desktop",
                steps: [
                    {
                        label: "Wait one",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 800 },
                        checkpoint: false
                    },
                    {
                        label: "Wait two",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 800 },
                        checkpoint: false
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        await waitForTask(server.baseUrl, task.id, (current) => ["planning", "running"].includes(current.status) && Boolean(current.traceId));
        await fetch(`${server.baseUrl}/tasks/${task.id}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "request_takeover" })
        });
        const takenOver = await waitForTask(server.baseUrl, task.id, (current) => current.status === "takeover");
        assert.equal(takenOver.runtimeControl.mode, "takeover");
        assert.ok(takenOver.trace.events.some((event) => event.type === "control.takeover_requested"));
        await fetch(`${server.baseUrl}/tasks/${task.id}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "return_to_agent" })
        });
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.status, "completed");
        assert.ok(completed.trace.events.some((event) => event.type === "control.returned"));
    }
    finally {
        await server.close();
    }
});
test("manual takeover notes are preserved in the task result and learned skill", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Learn from a manual takeover correction",
                preferredSurface: "desktop",
                saveSkillAs: "takeover-learned-skill",
                steps: [
                    {
                        label: "Wait one",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 800 },
                        checkpoint: false
                    },
                    {
                        label: "Wait two",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 800 },
                        checkpoint: false
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        await waitForTask(server.baseUrl, task.id, (current) => ["planning", "running"].includes(current.status) && Boolean(current.traceId));
        await fetch(`${server.baseUrl}/tasks/${task.id}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "request_takeover" })
        });
        await waitForTask(server.baseUrl, task.id, (current) => current.status === "takeover");
        const correctionNote = "Refocused the desktop window and confirmed the workflow was ready.";
        await fetch(`${server.baseUrl}/tasks/${task.id}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                action: "return_to_agent",
                note: correctionNote
            })
        });
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.result.manualCorrections.length, 1);
        assert.equal(completed.result.manualCorrections[0].note, correctionNote);
        assert.ok(completed.trace.events.some((event) => event.type === "takeover.note_recorded"));
        const skillResponse = await fetch(`${server.baseUrl}/skills/takeover-learned-skill`);
        const skillPayload = await skillResponse.json();
        assert.ok(skillPayload.skill.recoveryHints.includes(correctionNote));
        assert.equal(skillPayload.skill.metadata.manualCorrectionsCount, 1);
    }
    finally {
        await server.close();
    }
});
test("learned skills can substitute runtime inputs into parameterized action templates", async () => {
    const dataDir = await createTempDir();
    const fixture = await startFixtureServer();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Learn a parameterized browser skill",
                preferredSurface: "browser",
                saveSkillAs: "parameterized-demo-form",
                inputs: {
                    startUrl: fixture.url,
                    typeTarget: "name",
                    typeText: "Learned"
                },
                steps: [
                    {
                        label: "Open demo page",
                        surface: "browser",
                        action: "goto",
                        params: { url: fixture.url }
                    },
                    {
                        label: "Type name into the form",
                        surface: "browser",
                        action: "typeIntoTarget",
                        params: { targetQuery: "name", text: "Learned", clear: true }
                    },
                    {
                        label: "Submit the form",
                        surface: "browser",
                        action: "clickTarget",
                        params: { targetQuery: "submit" }
                    },
                    {
                        label: "Read status",
                        surface: "browser",
                        action: "extractText",
                        params: { selector: "#status" },
                        saveAs: "status"
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        const skillResponse = await fetch(`${server.baseUrl}/skills/parameterized-demo-form`);
        const skillPayload = await skillResponse.json();
        assert.ok(skillPayload.skill.actionTemplate.some((step) => step.params?.text === "{{typeText}}"));
        assert.ok(skillPayload.skill.metadata.skillInputs.some((input) => input.key === "typeText"));
        const replayResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Run the parameterized skill again",
                preferredSurface: "browser",
                skillName: "parameterized-demo-form",
                inputs: {
                    typeText: "Remixed"
                }
            })
        });
        const replayTask = (await replayResponse.json()).task;
        const replayed = await waitForTask(server.baseUrl, replayTask.id, (current) => current.status === "completed");
        assert.equal(replayed.result.outputs.status.text, "Submitted: Remixed");
    }
    finally {
        await fixture.close();
        await server.close();
    }
});
test("manual teach steps are preserved and saved into learned skills", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Learn from a recorded teach step",
                preferredSurface: "desktop",
                saveSkillAs: "teach-step-skill",
                steps: [
                    {
                        label: "Wait one",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 800 },
                        checkpoint: false
                    },
                    {
                        label: "Wait two",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 800 },
                        checkpoint: false
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        await waitForTask(server.baseUrl, task.id, (current) => ["planning", "running"].includes(current.status) && Boolean(current.traceId));
        await fetch(`${server.baseUrl}/tasks/${task.id}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "request_takeover" })
        });
        await waitForTask(server.baseUrl, task.id, (current) => current.status === "takeover");
        await fetch(`${server.baseUrl}/tasks/${task.id}/teach-steps`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                step: {
                    label: "Click Send",
                    surface: "desktop",
                    action: "clickTarget",
                    params: { targetQuery: "发送" }
                }
            })
        });
        await fetch(`${server.baseUrl}/tasks/${task.id}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "return_to_agent" })
        });
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.result.manualTeachSteps.length, 1);
        assert.equal(completed.result.manualTeachSteps[0].label, "Click Send");
        assert.ok(completed.trace.events.some((event) => event.type === "takeover.step_recorded"));
        const skillResponse = await fetch(`${server.baseUrl}/skills/teach-step-skill`);
        const skillPayload = await skillResponse.json();
        assert.equal(skillPayload.skill.metadata.manualTeachStepsCount, 1);
        assert.ok(skillPayload.skill.actionTemplate.some((step) => step.label === "Click Send"));
    }
    finally {
        await server.close();
    }
});
test("autonomous browser tasks can iterate through model decisions", async () => {
    const dataDir = await createTempDir();
    const fixture = await startFixtureServer();
    let decisionCount = 0;
    const model = await startModelServer(() => {
        decisionCount += 1;
        if (decisionCount === 1) {
            return {
                done: false,
                reason: "Open the starting page first.",
                action: {
                    label: "Open demo page",
                    surface: "browser",
                    action: "goto",
                    params: { url: fixture.url }
                }
            };
        }
        if (decisionCount === 2) {
            return {
                done: false,
                reason: "Fill the name field.",
                action: {
                    label: "Type the name",
                    surface: "browser",
                    action: "typeIntoTarget",
                    params: { targetQuery: "name", text: "Autonomy", clear: true }
                }
            };
        }
        if (decisionCount === 3) {
            return {
                done: false,
                reason: "Submit the form.",
                action: {
                    label: "Click submit",
                    surface: "browser",
                    action: "clickTarget",
                    params: { targetQuery: "submit" }
                }
            };
        }
        return {
            done: true,
            reason: "The page now shows the submitted status.",
            summary: "Autonomous browser workflow completed."
        };
    });
    const server = await startAgentServer({
        dataDir,
        model: {
            baseUrl: model.baseUrl,
            apiKey: "test-key",
            name: "fake-model",
            timeoutMs: 5000
        }
    });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Autonomously submit the demo form",
                preferredSurface: "browser",
                executionMode: "autonomous",
                autonomy: {
                    enabled: true,
                    maxSteps: 6
                }
            })
        });
        const { task } = await createResponse.json();
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.status, "completed");
        assert.equal(completed.result.summary, "Autonomous browser workflow completed.");
        assert.ok(completed.trace.events.some((event) => event.type === "autonomy.decision"));
        assert.ok(completed.trace.events.some((event) => event.type === "grounding.resolved"));
    }
    finally {
        await model.close();
        await fixture.close();
        await server.close();
    }
});
test("skills can be stored through the API and executed by name", async () => {
    const dataDir = await createTempDir();
    const fixture = await startFixtureServer();
    const server = await startAgentServer({ dataDir });
    try {
        const putResponse = await fetch(`${server.baseUrl}/skills/demo-fill-form`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                surfaceScope: "browser",
                triggerTerms: ["demo fill form"],
                anchors: [{ text: "Submit", role: "button" }],
                actionTemplate: [
                    {
                        label: "Open demo page",
                        surface: "browser",
                        action: "goto",
                        params: { url: fixture.url }
                    },
                    {
                        label: "Type from skill",
                        surface: "browser",
                        action: "typeIntoTarget",
                        params: { targetQuery: "name", text: "Skillful", clear: true }
                    },
                    {
                        label: "Submit from skill",
                        surface: "browser",
                        action: "clickTarget",
                        params: { targetQuery: "submit" }
                    },
                    {
                        label: "Read status",
                        surface: "browser",
                        action: "extractText",
                        params: { selector: "#status" },
                        saveAs: "status"
                    }
                ],
                successCriteria: [{ type: "selectorText", selector: "#status", equals: "Submitted: Skillful" }],
                recoveryHints: ["reload"]
            })
        });
        const putPayload = await putResponse.json();
        assert.equal(putPayload.skill.name, "demo-fill-form");
        const listResponse = await fetch(`${server.baseUrl}/skills`);
        const listPayload = await listResponse.json();
        assert.ok(listPayload.skills.some((skill) => skill.name === "demo-fill-form"));
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Run the saved browser skill",
                preferredSurface: "browser",
                skillName: "demo-fill-form"
            })
        });
        const { task } = await createResponse.json();
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.result.outputs.status.text, "Submitted: Skillful");
        assert.ok(completed.trace.events.some((event) => event.message.includes("demo-fill-form")));
    }
    finally {
        await fixture.close();
        await server.close();
    }
});
test("teach mode can learn a skill automatically from a completed task", async () => {
    const dataDir = await createTempDir();
    const fixture = await startFixtureServer();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Learn how to fill the demo form",
                preferredSurface: "browser",
                saveSkillAs: "learned-demo-form",
                steps: [
                    {
                        label: "Open demo page",
                        surface: "browser",
                        action: "goto",
                        params: { url: fixture.url }
                    },
                    {
                        label: "Type name into the form",
                        surface: "browser",
                        action: "typeIntoTarget",
                        params: { targetQuery: "name", text: "Learned", clear: true }
                    },
                    {
                        label: "Submit the form",
                        surface: "browser",
                        action: "clickTarget",
                        params: { targetQuery: "submit" }
                    },
                    {
                        label: "Read status",
                        surface: "browser",
                        action: "extractText",
                        params: { selector: "#status" },
                        saveAs: "status"
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.status, "completed");
        const skillResponse = await fetch(`${server.baseUrl}/skills/learned-demo-form`);
        const skillPayload = await skillResponse.json();
        assert.equal(skillPayload.skill.name, "learned-demo-form");
        assert.equal(skillPayload.skill.metadata.generatedFromExecution, true);
        assert.equal(skillPayload.skill.metadata.learnedFromTaskId, task.id);
        assert.ok(skillPayload.skill.anchors.some((anchor) => anchor.text.toLowerCase() === "submit"));
        assert.ok(skillPayload.skill.actionTemplate.some((step) => step.action === "clickTarget"));
        const replayResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Use the learned demo skill",
                preferredSurface: "browser",
                skillName: "learned-demo-form"
            })
        });
        const replayTask = (await replayResponse.json()).task;
        const replayed = await waitForTask(server.baseUrl, replayTask.id, (current) => current.status === "completed");
        assert.equal(replayed.result.outputs.status.text, "Submitted: Learned");
    }
    finally {
        await fixture.close();
        await server.close();
    }
});
test("completed tasks can be saved as skills after the run finishes", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const createResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                goal: "Wait briefly on desktop and save it later",
                preferredSurface: "desktop",
                steps: [
                    {
                        label: "Wait shortly",
                        surface: "desktop",
                        action: "wait",
                        params: { ms: 10 },
                        checkpoint: false
                    }
                ]
            })
        });
        const { task } = await createResponse.json();
        const completed = await waitForTask(server.baseUrl, task.id, (current) => current.status === "completed");
        assert.equal(completed.status, "completed");
        const saveResponse = await fetch(`${server.baseUrl}/skills/from-task`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                taskId: task.id,
                name: "desktop-wait-skill"
            })
        });
        const savePayload = await saveResponse.json();
        assert.equal(savePayload.skill.name, "desktop-wait-skill");
        assert.equal(savePayload.skill.metadata.learnedFromTaskId, task.id);
        assert.equal(savePayload.skill.actionTemplate[0].action, "wait");
        assert.equal(savePayload.skill.surfaceScope, "desktop");
    }
    finally {
        await server.close();
    }
});
test("named workspace profiles are reusable across tasks", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const createProfileResponse = await fetch(`${server.baseUrl}/workspace-profiles/main`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ metadata: { owner: "tester" } })
        });
        const createProfilePayload = await createProfileResponse.json();
        assert.equal(createProfilePayload.profile.name, "main");
        const taskPayload = {
            goal: "Use a persistent workspace profile",
            preferredSurface: "desktop",
            workspaceName: "main",
            steps: [
                {
                    label: "Wait in desktop runtime",
                    surface: "desktop",
                    action: "wait",
                    params: { ms: 5 },
                    checkpoint: false
                }
            ]
        };
        const firstTaskResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(taskPayload)
        });
        const secondTaskResponse = await fetch(`${server.baseUrl}/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...taskPayload, goal: "Use the same persistent workspace again" })
        });
        const firstTask = (await firstTaskResponse.json()).task;
        const secondTask = (await secondTaskResponse.json()).task;
        await waitForTask(server.baseUrl, firstTask.id, (task) => task.status === "completed");
        await waitForTask(server.baseUrl, secondTask.id, (task) => task.status === "completed");
        const firstWorkspace = server.app.controlPlane.store.getWorkspaceByTask(firstTask.id);
        const secondWorkspace = server.app.controlPlane.store.getWorkspaceByTask(secondTask.id);
        assert.equal(firstWorkspace.rootPath, secondWorkspace.rootPath);
        assert.equal(firstWorkspace.profilePath, secondWorkspace.profilePath);
        const profileListResponse = await fetch(`${server.baseUrl}/workspace-profiles`);
        const profileListPayload = await profileListResponse.json();
        assert.ok(profileListPayload.profiles.some((profile) => profile.name === "main"));
    }
    finally {
        await server.close();
    }
});
test("file inbox connector can ingest task files", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const inboxFile = path.join(dataDir, "inbox", "queued-task.json");
        await fs.mkdir(path.dirname(inboxFile), { recursive: true });
        await fs.writeFile(inboxFile, JSON.stringify({
            goal: "Run from the file inbox connector",
            preferredSurface: "desktop",
            steps: [
                {
                    label: "Wait quickly",
                    surface: "desktop",
                    action: "wait",
                    params: { ms: 20 },
                    checkpoint: false
                }
            ]
        }));
        const connectedTask = await (async () => {
            const started = Date.now();
            while (Date.now() - started < 8000) {
                const response = await fetch(`${server.baseUrl}/tasks`);
                const payload = await response.json();
                const found = payload.tasks.find((task) => task.goal === "Run from the file inbox connector");
                if (found) {
                    return found;
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
            throw new Error("Timed out waiting for connector task.");
        })();
        const completed = await waitForTask(server.baseUrl, connectedTask.id, (task) => task.status === "completed");
        assert.equal(completed.status, "completed");
        const connectorsResponse = await fetch(`${server.baseUrl}/connectors`);
        const connectorsPayload = await connectorsResponse.json();
        assert.equal(connectorsPayload.connectors[0].name, "file-inbox");
        assert.ok(connectorsPayload.connectors[0].processedCount >= 1);
    }
    finally {
        await server.close();
    }
});
test("vault secrets can be stored, listed, and revealed locally", async () => {
    const dataDir = await createTempDir();
    const server = await startAgentServer({ dataDir });
    try {
        const putResponse = await fetch(`${server.baseUrl}/vault/secrets/demo_token`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                scope: "default",
                value: "super-secret-value",
                metadata: { provider: "demo" }
            })
        });
        const putPayload = await putResponse.json();
        assert.equal(putPayload.secret.secretKey, "demo_token");
        const listResponse = await fetch(`${server.baseUrl}/vault/secrets`);
        const listPayload = await listResponse.json();
        assert.equal(listPayload.secrets[0].secretKey, "demo_token");
        assert.equal(listPayload.secrets[0].metadata.provider, "demo");
        assert.equal("value" in listPayload.secrets[0], false);
        const getResponse = await fetch(`${server.baseUrl}/vault/secrets/demo_token`);
        const getPayload = await getResponse.json();
        assert.equal(getPayload.secret.value, "super-secret-value");
    }
    finally {
        await server.close();
    }
});
