# AgentOS

Languages: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS is a local-first runtime for personal agents that operate browsers and desktop apps on behalf of a user. It is not a bare-metal operating system. It is an always-on agent layer that runs on top of macOS or Windows and keeps tasks, workspaces, traces, learning, and watch rules in one local runtime.

## What AgentOS does

- Runs a local daemon and CLI for task execution, watch rules, takeover, and diagnostics
- Operates browser and desktop surfaces through a shared `WorldState`
- Resolves natural-language targets into executable UI actions
- Keeps local traces, artifacts, workspaces, skills, watch profiles, and credentials
- Learns from task outcomes, watch detections, manual corrections, and selected local files
- Proposes follow-up tasks from learned information instead of auto-running them by default

## Current capability summary

- Local HTTP + WebSocket control plane
- `agentos` CLI for daemon lifecycle, tasks, drafts, watch rules, memory search, and proposals
- Multi-agent execution chain with `Sentinel`, `Planner`, `Operator`, `Verifier`, and `Recovery`
- Browser automation through a managed Playwright-driven Chrome profile
- Desktop automation through shared browser/desktop abstractions plus a Rust native sidecar
- Target-based actions such as `clickTarget`, `typeIntoTarget`, `waitForTarget`, and `extractFromTarget`
- Persistent workspace profiles and watch rules
- Conservative live automation with draft/approval flow
- Local learning loop with observations, entities, searchable knowledge chunks, daily digests, and proposals
- SQLite-backed local state

## Repository layout

- `src/`: runtime, server, adapters, services, and shared schemas
- `bin/`: CLI entrypoint and subcommands
- `rust/agentos-native/`: Rust native sidecar
- `public/`: optional local debug console
- `test/`: integration and runtime tests
- `.agentos/`: local runtime state, database, logs, workspaces, and artifacts

## Quick start

Install dependencies, build the TypeScript runtime, and start the daemon:

```bash
npm install
npm run build:ts
node dist/bin/agentos.js daemon start
```

Check that the daemon is healthy:

```bash
node dist/bin/agentos.js daemon status --json
node dist/bin/agentos.js doctor --json
node dist/bin/agentos.js version --json
```

The daemon listens on `http://127.0.0.1:3017` by default. The web console remains available for trace and debug use, but the primary entrypoint is the CLI.

## Build requirements

Type check the TypeScript source:

```bash
npm run typecheck
```

Build the runtime into `dist/`:

```bash
npm run build:ts
```

Build the Rust native sidecar:

```bash
npm run native:build
```

Notes:

- Building the Rust sidecar requires `cargo`.
- `dist/` is generated output and should not be committed.
- If browser detection fails, set `AGENTOS_BROWSER_EXECUTABLE`.
- If you want to watch browser execution, set `AGENTOS_HEADLESS=false`.

## Core runtime model

AgentOS currently centers around these parts:

- `Task`: a one-off unit of work
- `Workspace`: persistent local browser/app state
- `Watch rule`: an always-on standing rule that detects new items and creates tasks or drafts
- `Draft`: a pending action that requires approval
- `Skill`: a reusable learned workflow
- `Learning source`: an input stream such as filesystem scans, watch events, task results, or manual corrections
- `Proposal`: a suggested follow-up task created by the learning loop

## Common CLI workflows

### 1. Run a browser task

```bash
node dist/bin/agentos.js run \
  "Open example.com, click More information, then capture a screenshot" \
  --surface browser \
  --wait
```

### 2. Run a desktop task

```bash
node dist/bin/agentos.js run \
  "Open TextEdit, type a short note, and wait for me" \
  --surface desktop
```

### 3. Inspect tasks and traces

```bash
node dist/bin/agentos.js ps
node dist/bin/agentos.js inspect <task-id>
node dist/bin/agentos.js logs <task-id>
```

### 4. Pause or take over a task

```bash
node dist/bin/agentos.js control <task-id> pause
node dist/bin/agentos.js control <task-id> request_takeover
node dist/bin/agentos.js control <task-id> return_to_agent --note "I fixed the window focus"
node dist/bin/agentos.js control <task-id> stop
```

### 5. Create a standing watch rule

```bash
node dist/bin/agentos.js watch add \
  "Always watch Slack and reply to low-risk unread threads in my style" \
  --surface browser \
  --workspace personal-main
```

Inspect watch health:

```bash
node dist/bin/agentos.js watch ls
node dist/bin/agentos.js watch inspect <watch-id>
node dist/bin/agentos.js watch health <watch-id>
node dist/bin/agentos.js watch retry <watch-id>
```

### 6. Review or approve drafts

```bash
node dist/bin/agentos.js drafts ls
node dist/bin/agentos.js drafts inspect <draft-id>
node dist/bin/agentos.js drafts approve <draft-id>
node dist/bin/agentos.js drafts reject <draft-id> --reason "Need a human reply"
```

### 7. Teach a completed task into a watch profile

```bash
node dist/bin/agentos.js watch teach \
  <task-id> \
  "Keep watching this inbox and handle similar messages the same way" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

### 8. Inspect learning and proposals

```bash
node dist/bin/agentos.js learn status
node dist/bin/agentos.js learn sources ls
node dist/bin/agentos.js memory search "contract renewal"
node dist/bin/agentos.js digest run
node dist/bin/agentos.js proposals ls
node dist/bin/agentos.js proposals accept <proposal-id>
```

## Learning loop

AgentOS now includes a continuous local learning layer.

By default it:

- scans broad filesystem metadata under the user environment
- selectively reads file content from managed workspaces, Downloads, Documents, Desktop, and recent text-like files
- learns from watch detections, task results, and manual corrections
- stores structured memory and searchable knowledge locally
- creates silent background proposals instead of auto-running learned actions

Learning source kinds:

- `filesystem-metadata`
- `filesystem-content`
- `watch-events`
- `task-results`
- `user-corrections`

Search and proposal flow:

```bash
node dist/bin/agentos.js memory search "pricing"
node dist/bin/agentos.js proposals ls
node dist/bin/agentos.js proposals accept <proposal-id>
```

## JSON examples

### Example: target-based browser task

```json
{
  "goal": "Fill the form and capture the result",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "steps": [
    {
      "label": "Open the page",
      "surface": "browser",
      "action": "goto",
      "params": { "url": "https://example.com" }
    },
    {
      "label": "Type the email address",
      "surface": "browser",
      "action": "typeIntoTarget",
      "params": {
        "targetQuery": "email",
        "text": "tan@example.com",
        "clear": true
      }
    },
    {
      "label": "Submit the form",
      "surface": "browser",
      "action": "clickTarget",
      "params": { "targetQuery": "submit" }
    },
    {
      "label": "Capture the final state",
      "surface": "browser",
      "action": "capture",
      "params": { "label": "done" }
    }
  ]
}
```

### Example: desktop task

```json
{
  "goal": "Open TextEdit and type a note",
  "preferredSurface": "desktop",
  "inputs": {
    "desktopApp": "TextEdit",
    "typeText": "Daily note from AgentOS"
  },
  "steps": [
    {
      "label": "Open TextEdit",
      "surface": "desktop",
      "action": "openApp",
      "params": { "name": "TextEdit" }
    },
    {
      "label": "Wait for the editor",
      "surface": "desktop",
      "action": "waitForText",
      "params": { "text": "TextEdit", "timeoutMs": 5000 }
    },
    {
      "label": "Type the note",
      "surface": "desktop",
      "action": "type",
      "params": { "text": "Daily note from AgentOS" }
    }
  ]
}
```

### Example: watch rule payload

```json
{
  "goal": "Always watch Slack and reply to low-risk unread threads in my style",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "livePack": "slack-browser",
  "pollIntervalMs": 15000
}
```

### Example: task control payload

```json
{
  "action": "request_takeover"
}
```

Supported task control actions:

- `pause`
- `resume`
- `request_takeover`
- `return_to_agent`
- `stop`

## Runtime notes

- All local runtime state lives under `.agentos/`.
- Daemon state lives under `.agentos/daemon/`.
- Browser automation expects a Chrome-compatible executable.
- Browser automation runs headless by default.
- Desktop automation on macOS may require Accessibility and Screen Recording permissions.
- Desktop automation on Windows uses native PowerShell and Win32 automation paths through the sidecar.
- Built-in live packs currently include:
  - `slack-browser`
  - `slack-desktop`
  - `wechat-desktop`
  - `generic-mail-desktop`
  - `generic-desktop`
- Learning data, digests, and proposals are local only.

## API overview

System:

- `GET /health`
- `GET /doctor`
- `POST /doctor/bundle`
- `GET /version`
- `GET /daemon/status`

Tasks:

- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/control`
- `POST /tasks/:id/teach-steps`
- `GET /traces/:id`
- `POST /events`
- `GET /events`
- `POST /policy/evaluate`

Watch and drafts:

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

Skills, workspace, vault:

- `GET /skills`
- `POST /skills/from-task`
- `GET /skills/:name`
- `PUT /skills/:name`
- `GET /workspace-profiles`
- `PUT /workspace-profiles/:name`
- `GET /vault/secrets`
- `PUT /vault/secrets/:key`
- `GET /vault/secrets/:key`

Learning:

- `GET /learning/status`
- `GET /learning/sources`
- `GET /memory/search`
- `GET /memory/entities/:id`
- `GET /digests`
- `POST /digests/run`
- `GET /proposals`
- `POST /proposals/:id/accept`
- `POST /proposals/:id/reject`

## Development and release

Run the full test suite:

```bash
npm test
```

Restart the daemon after a local rebuild:

```bash
node dist/bin/agentos.js daemon restart
```

Prepare release artifacts:

```bash
npm run package:release -- --platform darwin
ALLOW_UNSIGNED_PACKAGE=1 npm run package:macos
npm run package:windows
```

## License

MIT. See [LICENSE](./LICENSE).
