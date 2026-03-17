function byId(id) {
    return document.getElementById(id);
}
const taskList = byId("taskList");
const liveList = byId("liveList");
const skillList = byId("skillList");
const taskTemplate = byId("taskTemplate");
const liveTemplate = byId("liveTemplate");
const skillTemplate = byId("skillTemplate");
const form = byId("taskForm");
const healthBadge = byId("healthBadge");
const socketBadge = byId("socketBadge");
const connectorBadge = byId("connectorBadge");
const previewButton = byId("previewButton");
const previewSummary = byId("previewSummary");
const previewList = byId("previewList");
const previewBadges = byId("previewBadges");
const exampleButtons = Array.from(document.querySelectorAll("[data-example]"));
const goalInput = byId("goalInput");
const surfaceInput = byId("surfaceInput");
const skillInput = byId("skillInput");
const teachModeInput = byId("teachModeInput");
const teachSkillNameInput = byId("teachSkillNameInput");
const state = {
    tasks: [],
    skills: [],
    preview: null,
    previewSequence: 0,
    previewTimer: null
};
function pretty(value) {
    return JSON.stringify(value, null, 2);
}
function suggestSkillName(goal = "") {
    const normalized = String(goal ?? "")
        .toLowerCase()
        .replaceAll(/https?:\/\/(www\.)?/g, "")
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, "")
        .slice(0, 48);
    if (normalized) {
        return normalized;
    }
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-").replace("T", "-");
    return `learned-skill-${stamp}`;
}
function summarizeTask(task) {
    if (task.status === "paused") {
        return task.runtimeControl?.reason ?? "Paused. Resume when you want the agent to continue.";
    }
    if (task.status === "takeover") {
        return task.runtimeControl?.reason ?? "Manual takeover requested.";
    }
    if (task.status === "failed" || task.status === "blocked") {
        return task.error ?? "Task stopped before completion.";
    }
    if (task.result?.summary) {
        return task.result.summary;
    }
    if (task.result?.verification?.ok) {
        return "Finished and verified.";
    }
    if (task.status === "running" || task.status === "planning" || task.status === "verifying") {
        const latest = task.trace?.events?.at(-1);
        return latest?.message ?? "Working on it now.";
    }
    return "Waiting in the queue.";
}
async function api(path, options = {}) {
    const response = await fetch(path, {
        headers: {
            "content-type": "application/json"
        },
        ...options
    });
    if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `Request failed: ${response.status}`);
    }
    return response.json();
}
async function sendTaskControl(taskId, action, reason = null, note = null) {
    await api(`/tasks/${taskId}/control`, {
        method: "POST",
        body: JSON.stringify({ action, reason, note })
    });
    await refresh();
}
async function recordTeachStep(taskId, step) {
    await api(`/tasks/${taskId}/teach-steps`, {
        method: "POST",
        body: JSON.stringify({ step })
    });
    await refresh();
}
function readFields() {
    return {
        goal: byId("goalInput").value.trim(),
        preferredSurface: byId("surfaceInput").value,
        executionMode: byId("modeInput").value,
        maxSteps: Number(byId("maxStepsInput").value || 8),
        workspaceName: byId("workspaceInput").value.trim(),
        skillName: byId("skillInput").value.trim(),
        startUrl: byId("urlInput").value.trim(),
        desktopApp: byId("appInput").value.trim(),
        clickTarget: byId("clickTargetInput").value.trim(),
        typeTarget: byId("typeTargetInput").value.trim(),
        typeText: byId("typeTextInput").value.trim(),
        waitText: byId("waitTextInput").value.trim(),
        waitUrl: byId("waitUrlInput").value.trim(),
        captureLabel: byId("captureInput").value.trim(),
        stepsRaw: byId("stepsInput").value.trim(),
        teachMode: teachModeInput.checked,
        teachSkillName: teachSkillNameInput.value.trim()
    };
}
function buildTaskPayload() {
    const fields = readFields();
    const inputs = {};
    if (fields.startUrl) {
        inputs.startUrl = fields.startUrl;
    }
    if (fields.desktopApp) {
        inputs.desktopApp = fields.desktopApp;
    }
    if (fields.clickTarget) {
        inputs.clickTarget = fields.clickTarget;
    }
    if (fields.typeTarget) {
        inputs.typeTarget = fields.typeTarget;
    }
    if (fields.typeText) {
        inputs.typeText = fields.typeText;
    }
    if (fields.waitText) {
        inputs.waitText = fields.waitText;
    }
    if (fields.waitUrl) {
        inputs.waitUrl = fields.waitUrl;
    }
    if (fields.captureLabel) {
        inputs.capture = true;
        inputs.captureLabel = fields.captureLabel;
    }
    const payload = {
        goal: fields.goal,
        preferredSurface: fields.preferredSurface,
        inputs
    };
    if (fields.workspaceName) {
        payload.workspaceName = fields.workspaceName;
    }
    if (fields.skillName) {
        payload.skillName = fields.skillName;
    }
    if (fields.teachMode) {
        payload.saveSkillAs = fields.teachSkillName || suggestSkillName(fields.goal);
    }
    if (fields.executionMode === "autonomous") {
        payload.executionMode = "autonomous";
        payload.autonomy = { enabled: true, maxSteps: fields.maxSteps };
    }
    if (fields.stepsRaw) {
        payload.steps = JSON.parse(fields.stepsRaw);
    }
    return payload;
}
function renderPreview(preview) {
    previewBadges.innerHTML = "";
    previewList.innerHTML = "";
    if (!preview) {
        previewSummary.textContent = "输入目标后，这里会显示系统将自动执行的结果路径。";
        previewList.innerHTML = '<li class="empty-state">还没有可预览的计划。</li>';
        return;
    }
    const sourceBadge = document.createElement("span");
    sourceBadge.className = "badge badge-muted";
    sourceBadge.textContent = preview.source.replaceAll("_", " ");
    previewBadges.append(sourceBadge);
    const riskBadge = document.createElement("span");
    riskBadge.className = `badge ${preview.evaluation?.riskLevel === "high" ? "badge-warn" : "badge-muted"}`;
    riskBadge.textContent = `risk: ${preview.evaluation?.riskLevel ?? "normal"}`;
    previewBadges.append(riskBadge);
    const fields = readFields();
    if (fields.teachMode) {
        const teachBadge = document.createElement("span");
        teachBadge.className = "badge";
        teachBadge.textContent = `learn: ${fields.teachSkillName || suggestSkillName(fields.goal)}`;
        previewBadges.append(teachBadge);
    }
    previewSummary.textContent = preview.summary ?? "这是系统即将自动执行的计划。";
    for (const line of preview.humanPlan ?? []) {
        const item = document.createElement("li");
        item.textContent = line;
        previewList.append(item);
    }
}
async function refreshPreview() {
    const sequence = ++state.previewSequence;
    let payload;
    try {
        payload = buildTaskPayload();
        if (!payload.goal) {
            state.preview = null;
            renderPreview(null);
            return;
        }
        previewSummary.textContent = "正在生成自动执行计划...";
        const { preview } = await api("/tasks/preview", {
            method: "POST",
            body: JSON.stringify(payload)
        });
        if (sequence !== state.previewSequence) {
            return;
        }
        state.preview = preview;
        renderPreview(preview);
    }
    catch (error) {
        if (sequence !== state.previewSequence) {
            return;
        }
        state.preview = null;
        previewBadges.innerHTML = "";
        previewSummary.textContent = "当前还没法生成自动计划。补充一点上下文，或者切到高级模式。";
        previewList.innerHTML = `<li class="empty-state">${error.message}</li>`;
    }
}
function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(() => {
        void refreshPreview();
    }, 320);
}
function fillExample(kind) {
    const examples = {
        browser: {
            goal: "打开 example.com，点击 More information，然后截图给我",
            preferredSurface: "auto",
            startUrl: "https://example.com",
            desktopApp: "",
            clickTarget: "More information",
            typeTarget: "",
            typeText: "",
            waitText: "",
            waitUrl: "iana.org",
            captureLabel: "after-navigation"
        },
        desktop: {
            goal: "打开 TextEdit，输入一句话，然后截图",
            preferredSurface: "desktop",
            startUrl: "",
            desktopApp: "TextEdit",
            clickTarget: "",
            typeTarget: "",
            typeText: "Hello from AgentOS",
            waitText: "",
            waitUrl: "",
            captureLabel: "desktop-note"
        },
        message: {
            goal: "打开微信，找到发送按钮，输入一段话并等待已发送提示",
            preferredSurface: "desktop",
            startUrl: "",
            desktopApp: "WeChat",
            clickTarget: "发送",
            typeTarget: "message",
            typeText: "你好，这是 AgentOS 发送的测试消息",
            waitText: "已发送",
            waitUrl: "",
            captureLabel: "message-proof"
        }
    };
    const example = examples[kind];
    if (!example) {
        return;
    }
    byId("goalInput").value = example.goal;
    byId("surfaceInput").value = example.preferredSurface;
    byId("urlInput").value = example.startUrl;
    byId("appInput").value = example.desktopApp;
    byId("clickTargetInput").value = example.clickTarget;
    byId("typeTargetInput").value = example.typeTarget;
    byId("typeTextInput").value = example.typeText;
    byId("waitTextInput").value = example.waitText;
    byId("waitUrlInput").value = example.waitUrl;
    byId("captureInput").value = example.captureLabel;
    byId("stepsInput").value = "";
    skillInput.value = "";
    teachModeInput.checked = false;
    teachSkillNameInput.value = "";
    syncTeachMode();
    schedulePreview();
}
function useSkill(skill) {
    goalInput.value = skill.triggerTerms?.[0] ?? skill.name;
    skillInput.value = skill.name;
    if (skill.surfaceScope && skill.surfaceScope !== "any") {
        surfaceInput.value = skill.surfaceScope;
    }
    for (const field of skill.metadata?.skillInputs ?? []) {
        const element = byId({
            startUrl: "urlInput",
            desktopApp: "appInput",
            clickTarget: "clickTargetInput",
            typeTarget: "typeTargetInput",
            typeText: "typeTextInput",
            waitText: "waitTextInput",
            waitUrl: "waitUrlInput",
            captureLabel: "captureInput"
        }[field.key] ?? "goalInput");
        if (element && !element.value) {
            element.value = field.defaultValue ?? "";
        }
    }
    teachModeInput.checked = false;
    teachSkillNameInput.value = "";
    syncTeachMode();
    schedulePreview();
}
async function saveTaskAsSkill(taskId, name) {
    await api("/skills/from-task", {
        method: "POST",
        body: JSON.stringify({ taskId, name })
    });
    await refreshSkills();
    await refresh();
}
function renderTask(task) {
    const fragment = taskTemplate.content.cloneNode(true);
    fragment.querySelector(".task-goal").textContent = task.goal;
    fragment.querySelector(".task-brief").textContent = summarizeTask(task);
    fragment.querySelector(".task-id").textContent = `${task.id} · ${task.traceId ?? "no trace yet"}`;
    fragment.querySelector(".task-status").textContent = task.status;
    fragment.querySelector(".task-result").textContent = pretty(task.result ?? task.plan ?? {});
    const traceNode = fragment.querySelector(".task-trace");
    const events = task.trace?.events ?? [];
    for (const event of events.slice(-3).reverse()) {
        const block = document.createElement("div");
        block.className = "trace-item";
        block.innerHTML = `<strong>${event.role} · ${event.type}</strong><p>${event.message}</p>`;
        traceNode.append(block);
    }
    const actionsNode = fragment.querySelector(".task-actions");
    if (task.result?.manualCorrections?.length) {
        const correctionSummary = document.createElement("div");
        correctionSummary.className = "task-corrections";
        correctionSummary.innerHTML = `<span class="badge badge-muted">人工修正 ${task.result.manualCorrections.length}</span><p>${task.result.manualCorrections.at(-1).note}</p>`;
        actionsNode.append(correctionSummary);
    }
    if (task.result?.manualTeachSteps?.length) {
        const teachSummary = document.createElement("div");
        teachSummary.className = "task-corrections";
        teachSummary.innerHTML = `<span class="badge badge-muted">示教动作 ${task.result.manualTeachSteps.length}</span><p>${task.result.manualTeachSteps.at(-1).label}</p>`;
        actionsNode.append(teachSummary);
    }
    if (task.status === "completed") {
        const learnedSkillName = task.taskSpec?.saveSkillAs;
        if (learnedSkillName) {
            const learned = document.createElement("div");
            learned.className = "task-learned";
            learned.innerHTML = `<span class="badge">已学会</span><strong>${learnedSkillName}</strong>`;
            const useButton = document.createElement("button");
            useButton.type = "button";
            useButton.className = "ghost-button task-action-button";
            useButton.textContent = "直接复用";
            useButton.addEventListener("click", () => {
                const skill = state.skills.find((entry) => entry.name === learnedSkillName);
                useSkill(skill ?? { name: learnedSkillName, triggerTerms: [task.goal], surfaceScope: task.preferredSurface });
            });
            actionsNode.append(learned, useButton);
        }
        else {
            const teachForm = document.createElement("form");
            teachForm.className = "task-skill-form";
            const input = document.createElement("input");
            input.type = "text";
            input.name = "skillName";
            input.value = suggestSkillName(task.goal);
            input.placeholder = "skill name";
            const button = document.createElement("button");
            button.type = "submit";
            button.className = "ghost-button task-action-button";
            button.textContent = "保存成技能";
            teachForm.append(input, button);
            teachForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                button.disabled = true;
                try {
                    await saveTaskAsSkill(task.id, input.value.trim() || suggestSkillName(task.goal));
                }
                catch (error) {
                    previewBadges.innerHTML = "";
                    previewSummary.textContent = "保存技能失败。";
                    previewList.innerHTML = `<li class="empty-state">${error.message}</li>`;
                }
                finally {
                    button.disabled = false;
                }
            });
            actionsNode.append(teachForm);
        }
    }
    return fragment;
}
function renderLive(tasks) {
    liveList.innerHTML = "";
    if (!tasks.length) {
        liveList.innerHTML = '<p class="empty-state">当前没有运行中的任务。</p>';
        return;
    }
    for (const task of tasks) {
        const fragment = liveTemplate.content.cloneNode(true);
        fragment.querySelector(".live-goal").textContent = task.goal;
        const liveStatus = fragment.querySelector(".live-status");
        liveStatus.textContent = `${task.status} · ${task.preferredSurface}`;
        const latest = task.trace?.events?.at(-1);
        const liveEvent = fragment.querySelector(".live-event");
        liveEvent.textContent =
            task.runtimeControl?.reason && ["paused", "takeover"].includes(task.status)
                ? task.runtimeControl.reason
                : latest?.message ?? "Agent is working.";
        const controls = fragment.querySelector(".live-controls");
        const buildButton = (label, action, className = "ghost-button", noteProvider = null) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = className;
            button.textContent = label;
            button.addEventListener("click", async () => {
                button.disabled = true;
                try {
                    await sendTaskControl(task.id, action, null, noteProvider?.() ?? null);
                }
                catch (error) {
                    previewBadges.innerHTML = "";
                    previewSummary.textContent = "任务控制失败。";
                    previewList.innerHTML = `<li class="empty-state">${error.message}</li>`;
                }
                finally {
                    button.disabled = false;
                }
            });
            return button;
        };
        if (["running", "planning", "verifying"].includes(task.status)) {
            controls.append(buildButton("暂停", "pause"), buildButton("接管", "request_takeover"), buildButton("停止", "stop"));
        }
        else if (task.status === "paused") {
            controls.append(buildButton("继续执行", "resume"), buildButton("接管", "request_takeover"), buildButton("停止", "stop"));
        }
        else if (task.status === "takeover") {
            const noteBox = document.createElement("textarea");
            noteBox.className = "live-note";
            noteBox.rows = 3;
            noteBox.placeholder = "写一句你刚刚怎么修正的，例如：把窗口切回 WeChat，并确认发送按钮已经出现";
            controls.append(noteBox);
            const teachBuilder = document.createElement("div");
            teachBuilder.className = "teach-builder";
            const actionSelect = document.createElement("select");
            actionSelect.innerHTML = `
        <option value="clickTarget">记录点击目标</option>
        <option value="typeIntoTarget">记录输入到目标</option>
        <option value="typeText">记录直接输入</option>
        <option value="waitForText">记录等待文字</option>
        <option value="launchApp">记录打开 App</option>
        <option value="focusApp">记录切到 App</option>
        <option value="goto">记录打开网址</option>
        <option value="capture">记录截图</option>
      `;
            const primaryInput = document.createElement("input");
            primaryInput.placeholder = "目标 / App / 网址 / 文本";
            const secondaryInput = document.createElement("input");
            secondaryInput.placeholder = "补充文本，例如要输入的内容";
            const recordButton = document.createElement("button");
            recordButton.type = "button";
            recordButton.className = "ghost-button";
            recordButton.textContent = "记录示教动作";
            recordButton.addEventListener("click", async () => {
                const action = actionSelect.value;
                const primary = primaryInput.value.trim();
                const secondary = secondaryInput.value.trim();
                const stepFactories = {
                    clickTarget: () => ({
                        label: `Click ${primary}`,
                        surface: task.preferredSurface,
                        action: "clickTarget",
                        params: { targetQuery: primary }
                    }),
                    typeIntoTarget: () => ({
                        label: `Type into ${primary}`,
                        surface: task.preferredSurface,
                        action: "typeIntoTarget",
                        params: { targetQuery: primary, text: secondary }
                    }),
                    typeText: () => ({
                        label: "Type text",
                        surface: task.preferredSurface,
                        action: task.preferredSurface === "browser" ? "typeIntoTarget" : "typeText",
                        params: task.preferredSurface === "browser"
                            ? { targetQuery: primary || "textbox", text: secondary || primary }
                            : { text: secondary || primary }
                    }),
                    waitForText: () => ({
                        label: `Wait for ${primary}`,
                        surface: task.preferredSurface,
                        action: task.preferredSurface === "browser" ? "waitFor" : "waitForText",
                        params: task.preferredSurface === "browser" ? { text: primary } : { text: primary, timeoutMs: 5000 }
                    }),
                    launchApp: () => ({
                        label: `Open ${primary}`,
                        surface: "desktop",
                        action: "launchApp",
                        params: { name: primary }
                    }),
                    focusApp: () => ({
                        label: `Focus ${primary}`,
                        surface: "desktop",
                        action: "focusApp",
                        params: { name: primary }
                    }),
                    goto: () => ({
                        label: `Open ${primary}`,
                        surface: "browser",
                        action: "goto",
                        params: { url: primary }
                    }),
                    capture: () => ({
                        label: "Capture screen",
                        surface: task.preferredSurface,
                        action: "capture",
                        params: { label: primary || "capture" },
                        saveAs: "capture"
                    })
                };
                const step = stepFactories[action]?.();
                if (!step) {
                    return;
                }
                recordButton.disabled = true;
                try {
                    await recordTeachStep(task.id, step);
                    primaryInput.value = "";
                    secondaryInput.value = "";
                }
                catch (error) {
                    previewBadges.innerHTML = "";
                    previewSummary.textContent = "记录示教动作失败。";
                    previewList.innerHTML = `<li class="empty-state">${error.message}</li>`;
                }
                finally {
                    recordButton.disabled = false;
                }
            });
            teachBuilder.append(actionSelect, primaryInput, secondaryInput, recordButton);
            controls.append(teachBuilder);
            controls.append(buildButton("记录修正并交还", "return_to_agent", "ghost-button", () => noteBox.value.trim()), buildButton("直接交还", "return_to_agent"), buildButton("停止", "stop"));
        }
        liveList.append(fragment);
    }
}
function renderSkills() {
    skillList.innerHTML = "";
    const learnedSkills = state.skills.filter((skill) => skill.metadata?.generatedFromExecution);
    if (!learnedSkills.length) {
        skillList.innerHTML = '<p class="empty-state">还没有学会新的技能。</p>';
        return;
    }
    for (const skill of learnedSkills) {
        const fragment = skillTemplate.content.cloneNode(true);
        fragment.querySelector(".skill-name").textContent = skill.name;
        fragment.querySelector(".skill-surface").textContent = skill.surfaceScope;
        const inputs = skill.metadata?.skillInputs ?? [];
        fragment.querySelector(".skill-brief").textContent =
            inputs.length
                ? `参数: ${inputs.map((entry) => entry.key).join(", ")}`
                : skill.recoveryHints?.[0] ??
                    skill.triggerTerms?.[0] ??
                    skill.anchors?.[0]?.text ??
                    `包含 ${skill.actionTemplate?.length ?? 0} 个动作`;
        fragment.querySelector(".skill-use").addEventListener("click", () => {
            useSkill(skill);
        });
        skillList.append(fragment);
    }
}
function render() {
    taskList.innerHTML = "";
    const running = state.tasks.filter((task) => ["planning", "running", "verifying", "paused", "takeover"].includes(task.status));
    renderLive(running);
    for (const task of state.tasks.filter((task) => !running.includes(task))) {
        taskList.append(renderTask(task));
    }
}
async function refresh() {
    const { tasks } = await api("/tasks");
    const detailed = await Promise.all(tasks.map(async (task) => {
        const payload = await api(`/tasks/${task.id}`);
        return payload.task;
    }));
    state.tasks = detailed;
    render();
}
async function refreshSkills() {
    const { skills } = await api("/skills");
    state.skills = skills;
    renderSkills();
}
async function refreshHealth() {
    const { ok, browserExecutable, modelConfigured } = await api("/health");
    healthBadge.textContent = ok ? "Local worker ready" : "Worker unavailable";
    socketBadge.textContent = browserExecutable ? "Managed browser wired" : "No browser executable";
    connectorBadge.textContent = modelConfigured ? "Model planner ready" : "Heuristic mode";
}
async function refreshConnectors() {
    const { connectors } = await api("/connectors");
    const fileInbox = connectors.find((connector) => connector.name === "file-inbox");
    if (fileInbox) {
        connectorBadge.textContent = `Inbox ${fileInbox.processedCount}/${fileInbox.failedCount}`;
    }
}
function syncTeachMode() {
    teachSkillNameInput.disabled = !teachModeInput.checked;
    teachSkillNameInput.placeholder = teachModeInput.checked
        ? suggestSkillName(goalInput.value)
        : "例如 example-open-and-capture";
}
function connectSocket() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    socket.addEventListener("open", () => {
        socketBadge.textContent = "Socket live";
    });
    socket.addEventListener("close", () => {
        socketBadge.textContent = "Socket offline";
        setTimeout(connectSocket, 1500);
    });
    socket.addEventListener("message", async (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === "bootstrap") {
            await refresh();
            return;
        }
        if (payload.type.startsWith("task.") || payload.type.startsWith("trace.")) {
            await refresh();
        }
        if (payload.type === "skill.saved") {
            await refreshSkills();
            await refresh();
        }
    });
}
previewButton.addEventListener("click", async () => {
    await refreshPreview();
});
for (const button of exampleButtons) {
    button.addEventListener("click", () => {
        fillExample(button.dataset.example);
    });
}
for (const input of Array.from(form.querySelectorAll("input, textarea, select"))) {
    input.addEventListener("input", () => {
        if (input === goalInput || input === teachModeInput || input === teachSkillNameInput) {
            syncTeachMode();
        }
        schedulePreview();
    });
    input.addEventListener("change", () => {
        if (input === goalInput || input === teachModeInput || input === teachSkillNameInput) {
            syncTeachMode();
        }
        schedulePreview();
    });
}
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        const payload = buildTaskPayload();
        if (!payload.goal) {
            return;
        }
        if (!payload.steps && state.preview?.plan?.length && payload.executionMode !== "autonomous" && !payload.skillName) {
            payload.steps = state.preview.plan.map((step) => ({
                label: step.label,
                surface: step.surface,
                action: step.action,
                params: step.params,
                expect: step.expect,
                saveAs: step.saveAs,
                checkpoint: step.checkpoint
            }));
        }
        await api("/tasks", {
            method: "POST",
            body: JSON.stringify(payload)
        });
        form.reset();
        syncTeachMode();
        state.preview = null;
        renderPreview(null);
        await refresh();
    }
    catch (error) {
        previewBadges.innerHTML = "";
        previewSummary.textContent = "当前输入还不能直接自动执行。";
        previewList.innerHTML = `<li class="empty-state">${error.message}</li>`;
    }
});
syncTeachMode();
await refreshHealth();
await refreshConnectors();
await refresh();
await refreshSkills();
connectSocket();
export {};
