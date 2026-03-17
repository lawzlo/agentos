# AgentOS

Languages: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS is a local-first control plane for autonomous agents that operate browsers and desktop apps on behalf of a user. It is not a bare-metal operating system; it is an agent operating layer that runs on top of macOS or Windows and keeps task intake, workspaces, traces, artifacts, and policy in one local runtime.

## What is implemented

- Local HTTP + WebSocket control plane
- `agentos` CLI for daemon lifecycle, tasks, takeover control, watch rules, and skills
- Task inbox, event intake, scheduler, policy evaluation, and trace replay primitives
- Multi-agent execution pipeline with `Sentinel`, `Planner`, `Operator`, `Verifier`, and `Recovery`
- Shared `WorldState` schema for browser and desktop observations
- Target grounding engine that resolves natural-language targets into executable UI candidates
- Target-based browser and desktop actions such as `clickTarget`, `typeIntoTarget`, `waitForTarget`, and `extractFromTarget`
- Managed browser workspace via Playwright-driven Chrome profile
- Desktop surface abstraction with a macOS bridge and a Windows bridge skeleton
- Native macOS helper for OCR, screenshot capture, coordinate click, mouse move, and scroll
- Autonomous execution loop for browser and desktop tasks through an OpenAI-compatible planner
- Local skill registry with built-in app-pack placeholders plus persisted custom skills
- Named workspace profiles for persistent personal browser/app state across tasks
- Local file inbox connector that turns dropped JSON files into tasks or events
- Persistent watch rules for always-on standing tasks
- Watch health, retry, and draft approval flow for conservative live automation
- Encrypted local credential vault with per-secret metadata
- Local ops console at `/` for trace/debug use
- SQLite-backed tasks, events, traces, workspaces, memory, and artifacts

## Quick start

```bash
npm install
npm run build:ts
node dist/bin/agentos.js daemon start
```

The daemon listens on `http://localhost:3017` by default. The web console remains available there, but the primary product entry is the CLI.

## TypeScript and Rust split

AgentOS is still runtime-first in Node.js, but the migration path is now explicit:

- `TypeScript` is the boundary layer for shared schemas and IPC contracts under [`src/types/`](./src/types)
- `Rust` is the native/runtime-heavy layer under [`rust/agentos-native`](./rust/agentos-native)
- `TypeScript` now owns the application/runtime source tree under `src/`, `bin/`, `public/`, and `test/`
- The macOS native path now covers capture, frontmost app, OCR, text search, window listing, and permission status through the Rust sidecar and its embedded native bridge
- The Windows bridge now covers capture, frontmost app, window listing, text input, key input, mouse input, and OCR/text lookup through PowerShell-native automation

Run type checking for the new typed boundary:

```bash
npm run typecheck
```

Build the runtime into `dist/`:

```bash
npm run build:ts
```

Build the Rust sidecar:

```bash
npm run native:build
```

Notes:

- Building the Rust sidecar requires `cargo` to be installed locally.
- `dist/` is generated and should not be committed.
- You can point AgentOS at a prebuilt sidecar with `AGENTOS_NATIVE_SIDECAR=/path/to/agentos-native`.

## CLI-first usage

Start or inspect the daemon:

```bash
node dist/bin/agentos.js daemon start
node dist/bin/agentos.js daemon status
node dist/bin/agentos.js doctor
```

Run a one-off task:

```bash
node dist/bin/agentos.js run "打开 example.com，点击 More information，然后截图" --surface browser
```

List current tasks or inspect a trace:

```bash
node dist/bin/agentos.js ps
node dist/bin/agentos.js inspect <task-id>
node dist/bin/agentos.js logs <task-id>
```

Pause or take over a running task:

```bash
node dist/bin/agentos.js control <task-id> pause
node dist/bin/agentos.js control <task-id> request_takeover
node dist/bin/agentos.js control <task-id> return_to_agent --note "I fixed the window focus"
```

Create an always-on watch rule:

```bash
node dist/bin/agentos.js watch add "一直盯 Slack，有新消息就按我的风格回复" --skill slack-reply --workspace personal-main
node dist/bin/agentos.js watch ls
node dist/bin/agentos.js watch health <watch-id>
node dist/bin/agentos.js watch retry <watch-id>
```

Teach a completed task into a reusable watch profile:

```bash
node dist/bin/agentos.js watch teach <task-id> "一直盯这个收件箱，看到同类消息就按刚才的流程处理" --pack generic-mail-desktop --workspace personal-main
```

Inspect live packs or approve pending drafts:

```bash
node dist/bin/agentos.js packs ls
node dist/bin/agentos.js drafts ls
node dist/bin/agentos.js drafts approve <draft-id>
```

## Runtime notes

- AgentOS stores all local state under `.agentos/`.
- The daemon writes runtime state under `.agentos/daemon/`.
- Browser automation expects a Chrome-compatible executable. Set `AGENTOS_BROWSER_EXECUTABLE` if auto-detection fails.
- The browser runs headless by default. Set `AGENTOS_HEADLESS=false` to watch the managed browser.
- Desktop automation on macOS uses `screencapture`, `open`, and `osascript`, which may require Accessibility and Screen Recording permissions.
- Desktop automation on Windows now uses native PowerShell and Win32 APIs for screen capture, visible-window discovery, input injection, and OCR-based text lookup.
- Desktop observation now also captures on-screen window metadata and local permission status when the macOS native path is available.
- Desktop steps can now use `clickAt`, `moveMouse`, `scroll`, `clickText`, `ocrScreen`, and `waitForText`.
- Browser and desktop tasks can now use `clickTarget`, `focusTarget`, `typeIntoTarget`, `waitForTarget`, and `extractFromTarget` with `targetQuery`.
- Model planning is optional. If `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_NAME` are set, the planner will call an OpenAI-compatible chat completions API; otherwise it falls back to explicit `steps` or heuristic browser plans.
- Autonomous tasks require model configuration and should set `executionMode: "autonomous"` or `autonomy.enabled: true`.
- Tasks can opt into a persistent named workspace with `workspaceName`.
- Saved skills can be listed or installed through the local API and invoked with `skillName`.
- Teach Mode can save a successful run into a reusable skill either during task submission with `saveSkillAs` or later through `POST /skills/from-task`.
- Standing tasks are stored as watch rules. The runtime currently ships bundled live packs for `slack-desktop`, `wechat-desktop`, `generic-mail-desktop`, and `generic-desktop`.
- Live packs now expose pack metadata through `/packs`, and `agentos doctor` summarizes degraded watches and pending drafts.
- Conservative automation is now built in: Slack and WeChat can auto-send low-risk replies, while mail and high-risk actions default to pending drafts for approval.
- JSON files dropped into `.agentos/inbox/` are ingested automatically. Task-shaped JSON creates a task; `{ "kind": "event", ... }` creates an event.

## API

- `GET /daemon/status`
- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/control`
- `POST /tasks/:id/teach-steps`
- `POST /events`
- `GET /events`
- `GET /traces/:id`
- `POST /policy/evaluate`
- `GET /connectors`
- `GET /doctor`
- `GET /packs`
- `GET /watches`
- `POST /watches`
- `POST /watches/from-task`
- `GET /watches/:id`
- `GET /watches/:id/health`
- `POST /watches/:id/enable`
- `POST /watches/:id/disable`
- `POST /watches/:id/retry`
- `DELETE /watches/:id`
- `GET /drafts`
- `GET /drafts/:id`
- `POST /drafts/:id/approve`
- `POST /drafts/:id/reject`
- `GET /skills`
- `POST /skills/from-task`
- `GET /skills/:name`
- `PUT /skills/:name`
- `GET /workspace-profiles`
- `PUT /workspace-profiles/:name`
- `GET /vault/secrets`
- `PUT /vault/secrets/:key`
- `GET /vault/secrets/:key`
- `GET /health`
- `GET /ws`

## Example target-based task

```json
{
  "goal": "Fill the target page and capture the result",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "steps": [
    {
      "label": "Open target page",
      "surface": "browser",
      "action": "goto",
      "params": { "url": "https://example.com" }
    },
    {
      "label": "Type into the email field",
      "surface": "browser",
      "action": "typeIntoTarget",
      "params": { "targetQuery": "email", "text": "tan@example.com", "clear": true }
    },
    {
      "label": "Click submit",
      "surface": "browser",
      "action": "clickTarget",
      "params": { "targetQuery": "submit" }
    }
  ]
}
```

## Example task control

```json
{
  "action": "request_takeover"
}
```

Supported control actions:

- `pause`
- `resume`
- `request_takeover`
- `return_to_agent`
- `stop`

`return_to_agent` can include an optional `note` field. AgentOS stores that correction note on the task result and carries it into learned skills as a recovery hint.

## Example teach step payload

```json
{
  "step": {
    "label": "Click Send",
    "surface": "desktop",
    "action": "clickTarget",
    "params": { "targetQuery": "发送" }
  }
}
```

## Example skill definition

```json
{
  "surfaceScope": "browser",
  "triggerTerms": ["demo fill form"],
  "anchors": [{ "text": "Submit", "role": "button" }],
  "actionTemplate": [
    {
      "label": "Open demo page",
      "surface": "browser",
      "action": "goto",
      "params": { "url": "https://example.com" }
    },
    {
      "label": "Type name",
      "surface": "browser",
      "action": "typeIntoTarget",
      "params": { "targetQuery": "name", "text": "AgentOS", "clear": true }
    }
  ],
  "successCriteria": [{ "type": "textVisible", "value": "Submitted" }],
  "recoveryHints": ["reload page"]
}
```

Learned skills may contain parameter placeholders such as `{{typeText}}`. At run time, AgentOS resolves them from `taskSpec.inputs` and falls back to the defaults captured during teaching.

## Example watch-teach payload

```json
{
  "taskId": "task_123",
  "goal": "Always watch the same inbox and react with the taught flow",
  "livePack": "generic-mail-desktop",
  "workspaceName": "personal-main",
  "triggerTexts": ["New message", "未读"]
}
```

## Teach Mode example

```json
{
  "goal": "Open example.com, click More information, and capture the result",
  "preferredSurface": "browser",
  "saveSkillAs": "example-open-and-capture"
}
```

## Example desktop task

```json
{
  "goal": "Focus a native app and click the visible Submit button",
  "preferredSurface": "desktop",
  "steps": [
    {
      "label": "Focus the app",
      "surface": "desktop",
      "action": "focusApp",
      "params": { "name": "Notes" }
    },
    {
      "label": "Wait for Submit text",
      "surface": "desktop",
      "action": "waitForText",
      "params": { "text": "Submit", "timeoutMs": 5000 }
    },
    {
      "label": "Click the Submit button",
      "surface": "desktop",
      "action": "clickText",
      "params": { "text": "Submit" }
    }
  ]
}
```

## Example autonomous task

```json
{
  "goal": "Autonomously complete the visible browser workflow",
  "preferredSurface": "browser",
  "executionMode": "autonomous",
  "autonomy": {
    "enabled": true,
    "maxSteps": 8
  }
}
```

## Example file inbox payload

```json
{
  "goal": "Run from the inbox connector",
  "preferredSurface": "desktop",
  "steps": [
    {
      "label": "Pause briefly",
      "surface": "desktop",
      "action": "wait",
      "params": { "ms": 250 },
      "checkpoint": false
    }
  ]
}
```
