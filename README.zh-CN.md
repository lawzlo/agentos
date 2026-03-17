# AgentOS

语言: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS 是一个本地优先的 agent 控制平面，用来代表用户操作浏览器和桌面应用。它不是裸机操作系统，而是运行在 macOS 或 Windows 之上的 agent operating layer，把任务入口、工作区、trace、artifact、policy 和长期值守整合到一个本地 runtime 中。

## 已实现内容

- 本地 HTTP + WebSocket control plane
- `agentos` CLI，用于 daemon 生命周期、任务、接管控制、watch rule 和 skills
- `Sentinel / Planner / Operator / Verifier / Recovery` 多 agent 执行链
- 浏览器和桌面的统一 `WorldState`
- 自然语言目标 grounding 到可执行 UI target
- 浏览器和桌面的 target-based actions，如 `clickTarget`、`typeIntoTarget`、`waitForTarget`
- Playwright 驱动的托管浏览器 workspace
- macOS / Windows 桌面 surface abstraction
- Rust sidecar 驱动的本地 native 能力
- 本地 skill registry、workspace profile、watch rule、credential vault
- Teach recording、teach mode、watch teach
- SQLite 持久化任务、事件、trace、workspace、memory 和 artifacts

## 快速开始

```bash
npm install
npm run build:ts
node dist/bin/agentos.js daemon start
```

默认监听 `http://localhost:3017`。Web console 仍可用于 trace/debug，但主入口是 CLI。

## TypeScript 与 Rust

- `TypeScript` 是应用/runtime 源码主线，覆盖 `src/`、`bin/`、`public/`、`test/`
- `Rust` 负责 native/runtime-heavy 部分，位于 [`rust/agentos-native`](./rust/agentos-native)
- macOS native path 现在通过 Rust sidecar 和内嵌 native bridge 提供截图、OCR、窗口枚举、权限状态等能力
- Windows bridge 现在支持截图、窗口发现、输入注入和 OCR / 文本查找

常用命令：

```bash
npm run typecheck
npm run build:ts
npm run native:build
```

说明：

- 构建 Rust sidecar 需要本机安装 `cargo`
- `dist/` 是构建产物，不应提交到 git
- 可以通过 `AGENTOS_NATIVE_SIDECAR=/path/to/agentos-native` 指向预编译 sidecar

## CLI 用法

启动或查看 daemon：

```bash
node dist/bin/agentos.js daemon start
node dist/bin/agentos.js daemon status
```

执行一次性任务：

```bash
node dist/bin/agentos.js run "打开 example.com，点击 More information，然后截图" --surface browser
```

查看任务或 trace：

```bash
node dist/bin/agentos.js ps
node dist/bin/agentos.js inspect <task-id>
node dist/bin/agentos.js logs <task-id>
```

暂停或接管运行中的任务：

```bash
node dist/bin/agentos.js control <task-id> pause
node dist/bin/agentos.js control <task-id> request_takeover
node dist/bin/agentos.js control <task-id> return_to_agent --note "我已经修正窗口焦点"
```

创建长期 watch rule：

```bash
node dist/bin/agentos.js watch add "一直盯 Slack，有新消息就按我的风格回复" --skill slack-reply --workspace personal-main
node dist/bin/agentos.js watch ls
```

把一个完成过的任务教成可复用 watch profile：

```bash
node dist/bin/agentos.js watch teach <task-id> "一直盯这个收件箱，看到同类消息就按刚才的流程处理" --pack generic-mail-desktop --workspace personal-main
```

## Runtime 说明

- 所有本地状态保存在 `.agentos/`
- daemon 运行时状态保存在 `.agentos/daemon/`
- 浏览器自动化默认寻找 Chrome-compatible executable，可用 `AGENTOS_BROWSER_EXECUTABLE` 指定
- 浏览器默认 headless，可设 `AGENTOS_HEADLESS=false` 观看实际执行
- 桌面自动化在 macOS 上可能需要 Accessibility 和 Screen Recording 权限
- 桌面 watch 现在支持 context extraction、backoff/retry metadata 和 teach-based live hints
- 任务完成后会自动生成 teach recording，skill/watch 学习链会直接复用这份 recording

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
- `GET /watches`
- `POST /watches`
- `POST /watches/from-task`
- `GET /watches/:id`
- `POST /watches/:id/enable`
- `POST /watches/:id/disable`
- `DELETE /watches/:id`
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

## 示例：target-based task

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

## 示例：task control

```json
{
  "action": "request_takeover"
}
```

支持的 control actions：

- `pause`
- `resume`
- `request_takeover`
- `return_to_agent`
- `stop`

`return_to_agent` 可以带一个可选的 `note` 字段。AgentOS 会把这条修正备注保存到任务结果中，并作为 recovery hint 带入后续学习出的 skill。
