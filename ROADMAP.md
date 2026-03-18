# AgentOS Roadmap

## Summary

AgentOS is already past the prototype stage. The local daemon, CLI, browser and desktop execution, watch rules, drafts, reply policy, recurring jobs, learning loop, and several high-value app packs are working.

The next goal is not "add random new features." The goal is to turn AgentOS into a product people can trust to keep running: local-first, always-on, approval-aware, and useful every day.

This roadmap is organized around that goal.

## Product principles

- Local-first by default
- CLI-first, with web debug surfaces as optional tooling
- Visual and app-grounded operation, not API-only automation
- Draft-first and approval-aware autonomy
- Strong auditability through traces, memory, and local artifacts
- Useful on day one, but able to grow into a 24x7 personal operator

## Current state

### Already in place

- Local daemon and `agentos` CLI
- Browser and desktop task execution
- Watch rules, drafts, approvals, and reply policy controls
- Recurring jobs such as `daily_digest` and `morning_scan`
- Learning sources, memory search, digests, and proposals
- Built-in live packs for Slack, WeChat desktop, browser/desktop mail, BOSS, Google Drive, Google Docs, and Feishu Docs
- Release packaging, setup, setup fix flow, uninstall flow, and broad automated test coverage

### Still incomplete

- Truly product-grade always-on recovery and long-run resilience
- Deeper pack behavior in the highest-value daily apps
- A more useful learning loop that changes future behavior in auditable ways
- Fully self-contained onboarding and installer experience
- Clearer public positioning versus cloud-first AI employee products

## Must do

These are the tasks that matter most for AgentOS v2.

### 1. Always-on hardening

Goal: run unattended for long periods without silent drift, task duplication, or policy bypass.

Work:

- stronger daemon restart and crash recovery
- better restart reconciliation for tasks, drafts, jobs, and watches
- stronger backoff, retry, and degraded-state handling
- clearer long-run health reporting for daemon, packs, watches, and jobs
- stronger autostart validation across supported platforms

Exit criteria:

- AgentOS can survive restart, reboot, or transient failures without losing track of standing workflows
- degraded watches and jobs are visible and recoverable
- long-running operation does not silently accumulate stuck state

### 2. Deepen the highest-value packs

Goal: make the daily-use packs feel reliable enough to keep enabled.

Priority packs:

- Mail
- Slack
- WeChat desktop
- BOSS

Work:

- better context extraction
- stronger draft quality
- clearer per-thread state and escalation
- more robust pack health diagnostics
- more end-to-end fixtures around real message-like flows

Exit criteria:

- these packs can detect, context-build, draft, approve, retry, and recover consistently
- a user can understand why a pack is ready, blocked, degraded, or paused

### 3. Make the learning loop actually useful

Goal: learning should improve later work, not just collect data.

Work:

- stronger preference memory and correction memory
- proposal quality improvements
- clearer provenance for learned suggestions
- learning outputs that improve future drafts and follow-ups
- better controls for what sources are allowed to influence future behavior

Exit criteria:

- users can see what was learned, where it came from, and how it affected the next action
- learning improves future drafts and proposals without bypassing policy

## Should do

These are important product steps, but they should follow the core v2 stability work.

### 4. Installer and onboarding polish

Goal: installation should feel like a product, not a developer environment.

Work:

- more self-contained packaged installs
- clearer setup guidance for browser sessions, model configuration, and desktop permissions
- better first-run education inside `agentos`
- friendlier diagnostics and recovery suggestions

Exit criteria:

- a new user can install, run setup, understand blockers, and complete a first smoke test quickly

### 5. Better autonomy controls

Goal: let users understand exactly what the agent may or may not do.

Work:

- clearer policy summaries for packs, watches, and jobs
- stronger time-window, budget, and risk controls
- clearer thread-level lease visibility
- better explanation for why something became a draft, was blocked, or auto-sent

Exit criteria:

- users can answer "what will AgentOS send by itself?" without guessing

### 6. Better product communication

Goal: explain AgentOS as a category, not just a repo.

Work:

- stronger README and landing copy
- clearer differentiation from cloud-first agent products
- more concrete public examples, demos, and usage guides

Exit criteria:

- a new user can understand what AgentOS is, why local-first matters, and what it is good at

## Can do later

These are good opportunities, but they should not outrank the core work above.

### 7. More app packs

Possible expansions:

- additional chat apps
- more docs and workspace tools
- more personal productivity surfaces

Rule:

- do not add many shallow packs before the core packs feel strong

### 8. Richer UI surfaces

Possible expansions:

- better local dashboards
- richer trace viewers
- stronger pack and autonomy inspectors

Rule:

- UI should support the runtime, not replace the CLI-first product model

### 9. Team or shared workflows

Possible expansions:

- shared workspaces
- shared watch policies
- team-level review queues

Rule:

- do not let team features distort the local-first personal product core too early

## Suggested implementation order

1. Always-on hardening
2. Deepen Mail, Slack, WeChat desktop, and BOSS
3. Improve learning usefulness and auditability
4. Keep product onboarding and installer polishing
5. Expand outward to more packs or richer UI

## What success looks like

AgentOS v2 should feel like this:

- a user installs it, understands setup quickly, and gets a first useful result in minutes
- the agent can stay online all day, keep watches and jobs running, and recover from normal failures
- message apps feel trustworthy because drafts, approval, retries, and escalation are understandable
- learning helps tomorrow's work instead of becoming silent, untrusted background behavior
- the product is clearly different from cloud-first "AI employee" tools because the runtime, memory, and control stay with the user
