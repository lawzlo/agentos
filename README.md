# AgentOS

Languages: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS is a local-first runtime for personal agents that operate browsers and desktop apps on behalf of a user. It is not a bare-metal operating system. It is an always-on agent layer that runs on top of macOS or Windows and keeps tasks, workspaces, traces, learning, and watch rules in one local runtime.

## A real personal agent, not just a chat box

- Works the browser and desktop apps you already use
- Keeps standing watch over inboxes, docs, and recurring routines
- Starts with drafts and approvals, then earns more autonomy over time
- Leaves behind traces, memory, and artifacts instead of disappearing after the chat ends

## Recommended deployment

AgentOS is powerful enough to operate browsers, desktop apps, local files, and long-running watch rules. Treat it like a real operator, not a small helper script.

- Recommended first deployment: a dedicated machine, mini PC, VM, or a separate OS user account
- Avoid attaching it to your primary daily browser profile on day one
- Start with low-risk apps and draft-first reply policies before expanding autonomy
- Keep sensitive accounts, payments, deletions, signing flows, and high-risk submissions behind human approval
- Run `doctor` before trusting always-on workflows

## What AgentOS does

- Runs a local daemon and CLI for task execution, watch rules, takeover, and diagnostics
- Operates browser and desktop surfaces through a shared `WorldState`
- Resolves natural-language targets into executable UI actions
- Keeps local traces, artifacts, workspaces, skills, watch profiles, and credentials
- Learns from task outcomes, watch detections, manual corrections, and selected local files
- Proposes follow-up tasks from learned information instead of auto-running them by default

## Why people use it

- Replace repetitive browser and inbox chores with standing local workflows instead of one-off scripts
- Keep a low-risk digital operator online all day without granting full autonomy on day one
- Draft replies, summaries, and follow-ups first, then let trust expand gradually
- Reuse a successful task as a watch profile or recurring job instead of starting from zero tomorrow
- Keep traces, memory, credentials, and operating context local instead of shipping everything to a hosted SaaS control plane

## A typical day with AgentOS

- Morning: run a browser scan, sweep inboxes, and collect what needs attention
- Midday: draft email, Slack, WeChat, or recruiting follow-ups while leaving risky items queued for approval
- Afternoon: upload files, update docs, capture screenshots, and save outputs into workspaces
- Evening: generate a digest, remember what changed, and queue the next proposals

## Current capability summary

- Local HTTP + WebSocket control plane
- `agentos` CLI for daemon lifecycle, tasks, drafts, watch rules, memory search, and proposals
- Multi-agent execution chain with `Sentinel`, `Planner`, `Operator`, `Verifier`, and `Recovery`
- Browser automation through a managed Playwright-driven Chrome profile
- Desktop automation through shared browser/desktop abstractions plus a Rust native sidecar
- Target-based actions such as `clickTarget`, `typeIntoTarget`, `waitForTarget`, and `extractFromTarget`
- Built-in live packs for Slack, WeChat desktop, browser/desktop mail, BOSS, Google Drive, Google Docs, and Feishu Docs
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
- `~/.agentos/` by default: local runtime state, database, logs, workspaces, and artifacts

## Quick start

Most users should start with natural-language CLI commands. You do not need to write JSON to get value from AgentOS.

1. Install dependencies, build the runtime, and expose the local `agentos` command:

```bash
npm install
npm run cli:link
```

2. Run the first-time setup check. This verifies the daemon, browser, model config, native sidecar, packs, and next steps:

```bash
agentos setup
```

3. If AgentOS reports low-risk local fixes such as runtime directories or auto-start, let it apply them:

```bash
agentos setup --fix --dry-run
agentos setup --fix
```

`setup --fix` only applies low-risk local fixes. Browser sign-in, model credentials, and desktop permissions remain explicit human steps, and `agentos setup` will list them under manual steps.

4. Start the interactive shell or run a first one-off task:

```bash
agentos

agentos "Open example.com, click More information, then capture a screenshot" --surface browser
```

5. Add a first always-on watch rule:

```bash
agentos watch add \
  "Always watch Slack and reply to low-risk unread threads in my style" \
  --surface browser \
  --workspace personal-main
```

The daemon listens on `http://127.0.0.1:3017` by default. The web console remains available for trace and debug use, but the primary entrypoint is the CLI.

If `agentos` is not on your PATH yet, run `npm run cli:link` from the source checkout first.

## What setup fixes automatically and what it does not

- `agentos setup --fix` can create missing runtime directories and install daemon auto-start for the current user
- It does not log into Slack, email, BOSS, Drive, or Docs for you
- It does not inject model credentials for you
- It does not bypass Accessibility or Screen Recording permissions on desktop platforms
- After `setup --fix`, rerun `agentos setup` and then start with one smoke test plus one low-risk always-on workflow

## Best first 10 minutes

If you want the fastest path to value, try these in order:

```bash
agentos "Open example.com, click More information, then capture a screenshot" --surface browser
agentos "Open a local text editor, type a short note, and wait for me" --surface desktop
agentos jobs add daily_digest --hour 18
agentos watch add "Always watch my email, draft replies for new customer messages, and leave risky replies for approval" --surface browser --workspace personal-main
```

## Common personal agent scenarios

These are the kinds of workflows AgentOS is meant to handle without forcing users to hand-author JSON.

### 1. Browser research and capture

Use it like a web researcher that leaves behind artifacts and a reusable workspace.

```bash
agentos run \
  "Open the target site, gather the key points, and save a short summary in the workspace" \
  --surface browser \
  --wait
```

### 2. Pricing, FAQ, or competitor page summarization

Good for fast market scans or collecting talking points before a meeting.

```bash
agentos run \
  "Open the pricing and FAQ pages, summarize the differences, and save the notes in the workspace" \
  --surface browser \
  --wait
```

### 3. Email triage with drafts first

Keep the inbox moving without auto-sending risky replies.

```bash
agentos watch add \
  "Always watch my email, draft replies for new customer messages, and leave risky replies for approval" \
  --surface browser \
  --workspace personal-main
```

### 4. Slack low-risk reply automation

Let AgentOS clear low-risk threads while leaving the sharp edges to humans.

```bash
agentos watch add \
  "Always watch Slack and reply to low-risk unread threads in my style" \
  --surface browser \
  --workspace personal-main
```

### 5. WeChat desktop inbox assistance

Useful when the important inbox is not exposed by a public API.

```bash
agentos watch add \
  "Always watch WeChat desktop and draft replies to unread customer messages" \
  --surface desktop \
  --workspace personal-main
```

### 6. Recruiting follow-up on BOSS

Review new candidates, open context, and prepare polite outreach without manually redoing the same clicks.

```bash
agentos watch add \
  "Always watch BOSS直聘, review new candidates, and draft polite follow-ups" \
  --surface browser \
  --workspace recruiting-main
```

### 7. Download, rename, and file local documents

This is useful for invoices, contracts, receipts, or PDFs that need consistent filing.

```bash
agentos run \
  "Find the newest PDF in Downloads, move it into the contracts workspace, and tell me where it was saved" \
  --surface desktop \
  --wait
```

### 8. Google Drive and document workflows

Use the browser as the operator for upload, edit, and save loops.

```bash
agentos run \
  "Open Google Drive, upload the latest file from Downloads, and confirm the upload finished" \
  --surface browser \
  --wait

agentos run \
  "Open Google Docs, update the weekly report, and save it" \
  --surface browser \
  --wait
```

### 9. Morning scan and inbox sweep jobs

Turn AgentOS into a routine operator instead of a one-off task runner.

```bash
agentos jobs add morning_scan --workspace personal-main --surface browser --hour 9
agentos jobs add inbox_sweep --workspace personal-main --surface browser --hour 10
agentos jobs add follow_up_sweep --workspace personal-main --surface auto --interval-minutes 180
```

### 10. End-of-day digest and proposal review

This is a safe way to stay proactive without auto-sending work into the world.

```bash
agentos jobs add daily_digest --hour 18
agentos jobs add proposal_sweep --workspace personal-main --hour 19
```

### 11. Daily memory, digest, and follow-up proposals

Search what AgentOS learned instead of manually reconstructing context.

```bash
agentos learn status
agentos memory search "pricing"
agentos digest run
agentos proposals ls
```

### 12. Teach a repeated workflow after doing it once

Do it once carefully, then turn that pattern into a standing workflow.

```bash
agentos watch teach \
  <task-id> \
  "Keep watching this inbox and handle similar messages the same way" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

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
agentos run \
  "Open example.com, click More information, then capture a screenshot" \
  --surface browser \
  --wait
```

### 2. Run a desktop task

```bash
agentos run \
  "Open TextEdit, type a short note, and wait for me" \
  --surface desktop
```

### 3. Inspect tasks and traces

```bash
agentos ps
agentos inspect <task-id>
agentos logs <task-id>
```

### 4. Pause or take over a task

```bash
agentos control <task-id> pause
agentos control <task-id> request_takeover
agentos control <task-id> return_to_agent --note "I fixed the window focus"
agentos control <task-id> stop
```

### 5. Create a standing watch rule

```bash
agentos watch add \
  "Always watch Slack and reply to low-risk unread threads in my style" \
  --surface browser \
  --workspace personal-main
```

Inspect watch health:

```bash
agentos watch ls
agentos watch inspect <watch-id>
agentos watch health <watch-id>
agentos watch retry <watch-id>
```

### 6. Review or approve drafts

```bash
agentos drafts ls
agentos drafts inspect <draft-id>
agentos drafts approve <draft-id>
agentos drafts reject <draft-id> --reason "Need a human reply"
```

### 7. Teach a completed task into a watch profile

```bash
agentos watch teach \
  <task-id> \
  "Keep watching this inbox and handle similar messages the same way" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

### 8. Inspect learning and proposals

```bash
agentos learn status
agentos learn sources ls
agentos memory search "contract renewal"
agentos digest run
agentos proposals ls
agentos proposals accept <proposal-id>
```

### 9. Manage recurring jobs

```bash
agentos jobs ls
agentos jobs inspect <job-id>
agentos jobs run <job-id>
agentos jobs disable <job-id>
agentos jobs enable <job-id>
```

### 10. Repair setup or uninstall the local install

```bash
agentos setup --fix --dry-run
agentos setup --fix
agentos uninstall --dry-run
agentos uninstall --purge
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
agentos memory search "pricing"
agentos proposals ls
agentos proposals accept <proposal-id>
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

- By default, local runtime state lives under `~/.agentos/` unless `AGENTOS_DATA_DIR` is set.
- Daemon state lives under `~/.agentos/daemon/` by default.
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
agentos daemon restart
```

Prepare release artifacts:

```bash
npm run package:release -- --platform darwin
ALLOW_UNSIGNED_PACKAGE=1 npm run package:macos
npm run package:windows
```

GitHub Release automation:

- The workflow lives at [.github/workflows/release.yml](./.github/workflows/release.yml).
- On `release.published`, GitHub Actions now builds:
  - a signed macOS `.pkg`
  - a signed Windows `.msi`
- The workflow then uploads both installers directly to the GitHub Release, not just as transient workflow artifacts.
- You can also trigger it manually through `workflow_dispatch`.

Required GitHub secrets for signed builds:

- `AGENTOS_MACOS_SIGN_IDENTITY`
- `AGENTOS_WINDOWS_SIGN_PFX_BASE64`
- `AGENTOS_WINDOWS_SIGN_PFX_PASSWORD`

Manual publishing options:

- `publish_to_release=true`: create or update a GitHub Release and attach the installers
- `release_tag`: optional tag override, otherwise the workflow uses `v<package.json version>`
- `release_name`: optional release title override

## License

MIT. See [LICENSE](./LICENSE).
