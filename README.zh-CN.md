# AgentOS

语言: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS 是一个本地优先的个人 Agent runtime，用来代表用户操作浏览器和桌面应用。它不是裸机操作系统，而是运行在 macOS 或 Windows 之上的常驻 agent 层，把任务、工作区、trace、学习、watch rule 和本地执行统一在一个 runtime 里。

## 推荐部署方式

AgentOS 的能力足够强，可以操作浏览器、桌面应用、本地文件和长期运行的 watch rule。应该把它当成一个真正的执行者，而不是一个小脚本。

- 推荐第一阶段部署在独立设备、迷你主机、虚拟机，或者单独的系统账号里
- 不要一上来就接入你日常主力浏览器 profile
- 先从低风险应用和 `draft-first` 策略开始，再逐步放开自治边界
- 支付、删除、签署、提交这类高风险动作始终建议保留人工审批
- 在开启长期值守前先跑一遍 `doctor`

## AgentOS 现在能做什么

- 启动本地 daemon 和 CLI，长期值守
- 操作浏览器与桌面，并共享统一 `WorldState`
- 把自然语言目标定位成可执行 UI target
- 记录本地 traces、artifacts、workspace、skills、watch profile 和凭据
- 从任务结果、watch 检测、人工修正和部分本地文件中持续学习
- 基于学到的信息生成建议任务，默认不自动执行

## 当前已实现能力

- 本地 HTTP + WebSocket control plane
- `agentos` CLI：daemon、任务、draft、watch rule、memory search、proposal
- `Sentinel / Planner / Operator / Verifier / Recovery` 执行链
- Playwright 驱动的托管浏览器 workspace
- 通过 Rust sidecar 驱动的本地桌面能力
- `clickTarget`、`typeIntoTarget`、`waitForTarget`、`extractFromTarget` 等 target-based action
- 持久化 workspace profile、watch rule、draft 审批流
- 本地 learning loop：observations、entities、knowledge chunks、daily digest、proposals
- SQLite 本地存储

## 目录结构

- `src/`：runtime、server、adapter、service、schema
- `bin/`：CLI 入口和子命令
- `rust/agentos-native/`：Rust native sidecar
- `public/`：本地调试用 console
- `test/`：集成测试与 runtime 测试
- `.agentos/`：本地数据库、日志、workspace、artifact 和 daemon 状态

## 快速开始

大多数用户应该先用自然语言 CLI 命令开始。上手阶段不需要写 JSON。

1. 先安装依赖、构建 runtime，然后启动 daemon：

```bash
npm install
npm run build:ts
node dist/bin/agentos.js daemon start
```

2. 检查当前 runtime 是否正常：

```bash
node dist/bin/agentos.js daemon status
node dist/bin/agentos.js doctor
```

3. 先执行一个一次性任务：

```bash
node dist/bin/agentos.js run \
  "打开 example.com，点击 More information，然后截图" \
  --surface browser \
  --wait
```

4. 再加一个长期 watch rule：

```bash
node dist/bin/agentos.js watch add \
  "一直盯 Slack，把低风险未读消息按我的风格自动回复" \
  --surface browser \
  --workspace personal-main
```

默认监听 `http://127.0.0.1:3017`。Web console 仍可用于 trace/debug，但主入口是 CLI。

## 常见个人 Agent 场景

下面这些都是 AgentOS 设计时优先考虑的真实使用场景，正常情况下不需要用户手写 JSON。

### 1. 浏览器调研与信息整理

```bash
node dist/bin/agentos.js run \
  "打开目标网站，整理关键要点，并把简短总结保存到 workspace" \
  --surface browser \
  --wait
```

### 2. 邮件分拣与草稿回复

```bash
node dist/bin/agentos.js watch add \
  "一直盯我的邮箱，给新的客户邮件先起草回复，高风险内容保留审批" \
  --surface browser \
  --workspace personal-main
```

### 3. Slack 低风险自动回复

```bash
node dist/bin/agentos.js watch add \
  "一直盯 Slack，把低风险未读消息按我的风格自动回复" \
  --surface browser \
  --workspace personal-main
```

### 4. 微信桌面消息辅助

```bash
node dist/bin/agentos.js watch add \
  "一直盯微信桌面版，给未读客户消息先起草回复" \
  --surface desktop \
  --workspace personal-main
```

### 5. BOSS 直聘候选人跟进

```bash
node dist/bin/agentos.js watch add \
  "一直盯 BOSS直聘，查看新候选人，并起草礼貌的后续沟通" \
  --surface browser \
  --workspace recruiting-main
```

### 6. Google Drive 和文档工作流

```bash
node dist/bin/agentos.js run \
  "打开 Google Drive，把 Downloads 里最新的文件上传，并确认上传完成" \
  --surface browser \
  --wait

node dist/bin/agentos.js run \
  "打开 Google Docs，更新周报并保存" \
  --surface browser \
  --wait
```

### 7. 每日学习、摘要和后续建议

```bash
node dist/bin/agentos.js learn status
node dist/bin/agentos.js memory search "报价"
node dist/bin/agentos.js digest run
node dist/bin/agentos.js proposals ls
```

### 8. 先做一次，再教成长期流程

```bash
node dist/bin/agentos.js watch teach \
  <task-id> \
  "一直盯这个收件箱，遇到类似消息就照刚才的流程处理" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

## 构建要求

类型检查：

```bash
npm run typecheck
```

构建到 `dist/`：

```bash
npm run build:ts
```

构建 Rust sidecar：

```bash
npm run native:build
```

说明：

- 构建 Rust sidecar 需要本机安装 `cargo`
- `dist/` 是构建产物，不应该提交到 git
- 如果浏览器路径自动探测失败，可以设置 `AGENTOS_BROWSER_EXECUTABLE`
- 如果想看浏览器真实执行，可以设置 `AGENTOS_HEADLESS=false`

## 核心运行模型

AgentOS 目前围绕这些对象工作：

- `Task`：一次性任务
- `Workspace`：持久化浏览器或应用状态
- `Watch rule`：持续监听并触发任务或 draft 的长期规则
- `Draft`：等待批准的保守动作
- `Skill`：复用型工作流
- `Learning source`：学习来源，例如文件系统、watch 事件、任务结果、人工修正
- `Proposal`：学习层生成的建议任务

## 常见 CLI 流程

### 1. 执行一次浏览器任务

```bash
node dist/bin/agentos.js run \
  "打开 example.com，点击 More information，然后截图" \
  --surface browser \
  --wait
```

### 2. 执行一次桌面任务

```bash
node dist/bin/agentos.js run \
  "打开 TextEdit，输入一段短笔记，然后等待我接管" \
  --surface desktop
```

### 3. 查看任务和 trace

```bash
node dist/bin/agentos.js ps
node dist/bin/agentos.js inspect <task-id>
node dist/bin/agentos.js logs <task-id>
```

### 4. 暂停或接管运行中的任务

```bash
node dist/bin/agentos.js control <task-id> pause
node dist/bin/agentos.js control <task-id> request_takeover
node dist/bin/agentos.js control <task-id> return_to_agent --note "我已经修正窗口焦点"
node dist/bin/agentos.js control <task-id> stop
```

### 5. 创建长期 watch rule

```bash
node dist/bin/agentos.js watch add \
  "一直盯 Slack，把低风险未读消息按我的风格自动回复" \
  --surface browser \
  --workspace personal-main
```

查看 watch 健康状态：

```bash
node dist/bin/agentos.js watch ls
node dist/bin/agentos.js watch inspect <watch-id>
node dist/bin/agentos.js watch health <watch-id>
node dist/bin/agentos.js watch retry <watch-id>
```

### 6. 查看或批准 draft

```bash
node dist/bin/agentos.js drafts ls
node dist/bin/agentos.js drafts inspect <draft-id>
node dist/bin/agentos.js drafts approve <draft-id>
node dist/bin/agentos.js drafts reject <draft-id> --reason "这条需要人工回复"
```

### 7. 把完成过的任务教成 watch profile

```bash
node dist/bin/agentos.js watch teach \
  <task-id> \
  "一直盯这个收件箱，遇到类似消息就照刚才的流程处理" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

### 8. 查看学习层和建议任务

```bash
node dist/bin/agentos.js learn status
node dist/bin/agentos.js learn sources ls
node dist/bin/agentos.js memory search "合同续签"
node dist/bin/agentos.js digest run
node dist/bin/agentos.js proposals ls
node dist/bin/agentos.js proposals accept <proposal-id>
```

## 学习系统

AgentOS 现在包含一层持续学习系统。

默认行为：

- 对用户环境做广泛的文件 metadata 扫描
- 对受控目录和文本类文件做选择性内容读取
- 从 watch 检测、任务结果、人工修正中学习
- 本地保存结构化记忆和可搜索知识
- 静默生成 proposal，不默认自动执行

学习源类型：

- `filesystem-metadata`
- `filesystem-content`
- `watch-events`
- `task-results`
- `user-corrections`

常见使用方式：

```bash
node dist/bin/agentos.js memory search "报价"
node dist/bin/agentos.js proposals ls
node dist/bin/agentos.js proposals accept <proposal-id>
```

## JSON 示例

### 示例：target-based 浏览器任务

```json
{
  "goal": "填写表单并截图结果",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "steps": [
    {
      "label": "打开页面",
      "surface": "browser",
      "action": "goto",
      "params": { "url": "https://example.com" }
    },
    {
      "label": "输入邮箱",
      "surface": "browser",
      "action": "typeIntoTarget",
      "params": {
        "targetQuery": "email",
        "text": "tan@example.com",
        "clear": true
      }
    },
    {
      "label": "点击提交",
      "surface": "browser",
      "action": "clickTarget",
      "params": { "targetQuery": "submit" }
    },
    {
      "label": "截图",
      "surface": "browser",
      "action": "capture",
      "params": { "label": "done" }
    }
  ]
}
```

### 示例：桌面任务

```json
{
  "goal": "打开 TextEdit 并输入一条笔记",
  "preferredSurface": "desktop",
  "inputs": {
    "desktopApp": "TextEdit",
    "typeText": "这是 AgentOS 写入的每日笔记"
  },
  "steps": [
    {
      "label": "打开 TextEdit",
      "surface": "desktop",
      "action": "openApp",
      "params": { "name": "TextEdit" }
    },
    {
      "label": "等待编辑器出现",
      "surface": "desktop",
      "action": "waitForText",
      "params": { "text": "TextEdit", "timeoutMs": 5000 }
    },
    {
      "label": "输入内容",
      "surface": "desktop",
      "action": "type",
      "params": { "text": "这是 AgentOS 写入的每日笔记" }
    }
  ]
}
```

### 示例：watch rule

```json
{
  "goal": "一直盯 Slack，把低风险未读消息按我的风格自动回复",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "livePack": "slack-browser",
  "pollIntervalMs": 15000
}
```

### 示例：task control

```json
{
  "action": "request_takeover"
}
```

支持的 task control：

- `pause`
- `resume`
- `request_takeover`
- `return_to_agent`
- `stop`

## Runtime 说明

- 所有本地状态都在 `.agentos/`
- daemon 状态在 `.agentos/daemon/`
- 浏览器自动化需要 Chrome-compatible executable
- 浏览器默认 headless
- macOS 桌面自动化可能需要 Accessibility 和 Screen Recording 权限
- Windows 桌面自动化通过 sidecar 使用本地 PowerShell / Win32 路径
- 当前内置 live packs 包括：
  - `slack-browser`
  - `slack-desktop`
  - `wechat-desktop`
  - `generic-mail-desktop`
  - `generic-desktop`
- 学习数据、digest、proposal 都只保存在本地

## API 概览

系统：

- `GET /health`
- `GET /doctor`
- `POST /doctor/bundle`
- `GET /version`
- `GET /daemon/status`

任务：

- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/control`
- `POST /tasks/:id/teach-steps`
- `GET /traces/:id`
- `POST /events`
- `GET /events`
- `POST /policy/evaluate`

Watch / draft：

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

Skill / workspace / vault：

- `GET /skills`
- `POST /skills/from-task`
- `GET /skills/:name`
- `PUT /skills/:name`
- `GET /workspace-profiles`
- `PUT /workspace-profiles/:name`
- `GET /vault/secrets`
- `PUT /vault/secrets/:key`
- `GET /vault/secrets/:key`

Learning：

- `GET /learning/status`
- `GET /learning/sources`
- `GET /memory/search`
- `GET /memory/entities/:id`
- `GET /digests`
- `POST /digests/run`
- `GET /proposals`
- `POST /proposals/:id/accept`
- `POST /proposals/:id/reject`

## 开发与发布

运行全量测试：

```bash
npm test
```

本地重建后重启 daemon：

```bash
node dist/bin/agentos.js daemon restart
```

准备发布产物：

```bash
npm run package:release -- --platform darwin
ALLOW_UNSIGNED_PACKAGE=1 npm run package:macos
npm run package:windows
```

GitHub Release 自动发布：

- workflow 在 [.github/workflows/release.yml](./.github/workflows/release.yml)
- 当触发 `release.published` 时，GitHub Actions 现在会自动构建：
  - 已签名的 macOS `.pkg`
  - 已签名的 Windows `.msi`
- 构建完成后会直接上传到 GitHub Release，不只是保存在 Actions artifact 里
- 也可以通过 `workflow_dispatch` 手动触发

签名构建需要的 GitHub secrets：

- `AGENTOS_MACOS_SIGN_IDENTITY`
- `AGENTOS_WINDOWS_SIGN_PFX_BASE64`
- `AGENTOS_WINDOWS_SIGN_PFX_PASSWORD`

手动触发时可用参数：

- `publish_to_release=true`：创建或更新 GitHub Release，并挂上安装包
- `release_tag`：可选，覆盖默认 tag；不填时使用 `v<package.json version>`
- `release_name`：可选，覆盖默认 release 标题

## License

MIT，见 [LICENSE](./LICENSE)。
