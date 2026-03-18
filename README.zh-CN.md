# AgentOS

语言: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS 是一个本地优先的个人 Agent runtime，用来代表用户操作浏览器和桌面应用。它不是裸机操作系统，而是运行在 macOS 或 Windows 之上的常驻 agent 层，把任务、工作区、trace、学习、watch rule 和本地执行统一在一个 runtime 里。

## 一个真正干活的个人 Agent，不只是聊天框

- 直接操作你已经在用的浏览器和桌面应用
- 可以长期盯收件箱、文档和定时流程
- 默认从 draft 和 approval 开始，信任建立后再逐步放开自治
- 会留下 trace、memory 和 artifacts，而不是对话结束就消失

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

## 为什么用户会想用它

- 把重复性的浏览器操作和消息处理，变成长期站岗的本地 workflow，而不是一次性脚本
- 在不第一天就全自动放权的前提下，先得到一个低风险、全天在线的数字执行者
- 先让它起草回复、总结和后续动作，再随着信任逐步放开自治边界
- 一次成功任务可以直接教成 watch profile 或定时任务，第二天不用从零再来
- traces、记忆、凭据和上下文都留在本地，不需要把整套工作过程交给托管式 SaaS 控制面

## AgentOS 的一天

- 早上：跑浏览器扫描、sweep inbox、收集今天需要处理的事情
- 白天：起草邮件、Slack、微信、招聘跟进，高风险消息继续排队审批
- 下午：上传文件、更新文档、截图，并把结果保存进 workspace
- 晚上：生成 digest，记住今天发生了什么，并排出下一批 proposal

## 路线图

- 中文路线图: [ROADMAP.zh-CN.md](./ROADMAP.zh-CN.md)
- English roadmap: [ROADMAP.md](./ROADMAP.md)

## 当前已实现能力

- 本地 HTTP + WebSocket control plane
- `agentos` CLI：daemon、任务、draft、watch rule、memory search、proposal
- `Sentinel / Planner / Operator / Verifier / Recovery` 执行链
- Playwright 驱动的托管浏览器 workspace
- 通过 Rust sidecar 驱动的本地桌面能力
- `clickTarget`、`typeIntoTarget`、`waitForTarget`、`extractFromTarget` 等 target-based action
- 已内置 Slack、微信桌面版、浏览器/桌面邮箱、BOSS、Google Drive、Google Docs、飞书文档等 live packs
- 持久化 workspace profile、watch rule、draft 审批流
- 本地 learning loop：observations、entities、knowledge chunks、daily digest、proposals
- SQLite 本地存储

## 目录结构

- `src/`：runtime、server、adapter、service、schema
- `bin/`：CLI 入口和子命令
- `rust/agentos-native/`：Rust native sidecar
- `public/`：本地调试用 console
- `test/`：集成测试与 runtime 测试
- 默认在 `~/.agentos/`：本地数据库、日志、workspace、artifact 和 daemon 状态

## 快速开始

大多数用户应该先用自然语言 CLI 命令开始。上手阶段不需要写 JSON。

1. 先安装依赖、构建 runtime，并把本地 `agentos` 命令暴露出来：

```bash
npm install
npm run cli:link
```

2. 先跑一次首次 setup 检查。它会统一检查 daemon、浏览器、模型配置、native sidecar、live packs 和下一步建议：

```bash
agentos setup
```

3. 如果 setup 提示有低风险本地修复项，比如 runtime 目录或自启动，就让 AgentOS 先修掉：

```bash
agentos setup --fix --dry-run
agentos setup --fix
```

`setup --fix` 只会处理低风险本地修复。浏览器登录态、模型凭据、桌面权限这些仍然需要人手完成，`agentos setup` 会把它们列在手动步骤里。

4. 然后直接进入交互模式，或者先跑一个一次性任务：

```bash
agentos

agentos "打开 example.com，点击 More information，然后截图" --surface browser
```

5. 再加一个长期 watch rule：

```bash
agentos watch add \
  "一直盯 Slack，把低风险未读消息按我的风格自动回复" \
  --surface browser \
  --workspace personal-main
```

默认监听 `http://127.0.0.1:3017`。Web console 仍可用于 trace/debug，但主入口是 CLI。

如果当前 shell 里还没有 `agentos` 命令，先在源码目录执行一次 `npm run cli:link`。

## setup 会自动修什么，不会自动修什么

- `agentos setup --fix` 可以补 runtime 目录，并为当前用户安装 daemon 自启动
- 它不会替你登录 Slack、邮箱、BOSS、Drive、Docs
- 它不会替你注入模型凭据
- 它不会绕过桌面端的辅助功能或屏幕录制权限
- 跑完 `setup --fix` 之后，建议再跑一遍 `agentos setup`，然后先做一个 smoke test，再加一个低风险长期值守 workflow

## 最适合先试的 10 分钟

如果你想最快感受到价值，可以按这个顺序试：

```bash
agentos "打开 example.com，点击 More information，然后截图" --surface browser
agentos "打开一个本地文本编辑器，输入一段短笔记，然后等待我接管" --surface desktop
agentos jobs add daily_digest --hour 18
agentos watch add "一直盯我的邮箱，给新的客户邮件先起草回复，高风险内容保留审批" --surface browser --workspace personal-main
```

## 常见个人 Agent 场景

下面这些都是 AgentOS 设计时优先考虑的真实使用场景，正常情况下不需要用户手写 JSON。

### 1. 浏览器调研与信息整理

把它当成一个会留下 workspace、trace 和总结的网页调研员。

```bash
agentos run \
  "打开目标网站，整理关键要点，并把简短总结保存到 workspace" \
  --surface browser \
  --wait
```

### 2. 价格页、FAQ、竞品页面快速总结

适合会前准备、竞品扫描或者整理 talking points。

```bash
agentos run \
  "打开价格页和 FAQ 页面，整理差异，并把笔记保存到 workspace" \
  --surface browser \
  --wait
```

### 3. 邮件分拣与草稿回复

让 inbox 先流动起来，但保留高风险回复的人工把关。

```bash
agentos watch add \
  "一直盯我的邮箱，给新的客户邮件先起草回复，高风险内容保留审批" \
  --surface browser \
  --workspace personal-main
```

### 4. Slack 低风险自动回复

让 AgentOS 先清掉低风险线程，复杂情况再交给人。

```bash
agentos watch add \
  "一直盯 Slack，把低风险未读消息按我的风格自动回复" \
  --surface browser \
  --workspace personal-main
```

### 5. 微信桌面消息辅助

适合那种没有公开 API、但必须长期盯着的桌面消息入口。

```bash
agentos watch add \
  "一直盯微信桌面版，给未读客户消息先起草回复" \
  --surface desktop \
  --workspace personal-main
```

### 6. BOSS 直聘候选人跟进

查看新候选人、拉上下文、起草礼貌 follow-up，不再每次重复同一套点击。

```bash
agentos watch add \
  "一直盯 BOSS直聘，查看新候选人，并起草礼貌的后续沟通" \
  --surface browser \
  --workspace recruiting-main
```

### 7. 下载、重命名并归档本地文档

适合合同、发票、收据、PDF 之类需要稳定归档的文件。

```bash
agentos run \
  "找到 Downloads 里最新的 PDF，把它移动到 contracts workspace，并告诉我最终保存位置" \
  --surface desktop \
  --wait
```

### 8. Google Drive 和文档工作流

让浏览器变成上传、编辑、保存的执行层。

```bash
agentos run \
  "打开 Google Drive，把 Downloads 里最新的文件上传，并确认上传完成" \
  --surface browser \
  --wait

agentos run \
  "打开 Google Docs，更新周报并保存" \
  --surface browser \
  --wait
```

### 9. 每日晨间扫描和 inbox sweep

把 AgentOS 从一次性执行器变成每天固定值守的操作员。

```bash
agentos jobs add morning_scan --workspace personal-main --surface browser --hour 9
agentos jobs add inbox_sweep --workspace personal-main --surface browser --hour 10
```

### 10. 下班前 digest 和建议任务回顾

这是更安全的主动化方式，不会直接把高风险动作发出去。

```bash
agentos jobs add daily_digest --hour 18
agentos jobs add proposal_sweep --workspace personal-main --hour 19
```

### 11. 每日学习、摘要和后续建议

需要上下文时，直接搜它学到了什么，而不是自己重新回忆。

```bash
agentos learn status
agentos memory search "报价"
agentos digest run
agentos proposals ls
```

### 12. 先做一次，再教成长期流程

先人工做稳，再把这条路径教成长期规则。

```bash
agentos watch teach \
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
agentos run \
  "打开 example.com，点击 More information，然后截图" \
  --surface browser \
  --wait
```

### 2. 执行一次桌面任务

```bash
agentos run \
  "打开 TextEdit，输入一段短笔记，然后等待我接管" \
  --surface desktop
```

### 3. 查看任务和 trace

```bash
agentos ps
agentos inspect <task-id>
agentos logs <task-id>
```

### 4. 暂停或接管运行中的任务

```bash
agentos control <task-id> pause
agentos control <task-id> request_takeover
agentos control <task-id> return_to_agent --note "我已经修正窗口焦点"
agentos control <task-id> stop
```

### 5. 创建长期 watch rule

```bash
agentos watch add \
  "一直盯 Slack，把低风险未读消息按我的风格自动回复" \
  --surface browser \
  --workspace personal-main
```

查看 watch 健康状态：

```bash
agentos watch ls
agentos watch inspect <watch-id>
agentos watch health <watch-id>
agentos watch retry <watch-id>
```

### 6. 查看或批准 draft

```bash
agentos drafts ls
agentos drafts inspect <draft-id>
agentos drafts approve <draft-id>
agentos drafts reject <draft-id> --reason "这条需要人工回复"
```

### 7. 把完成过的任务教成 watch profile

```bash
agentos watch teach \
  <task-id> \
  "一直盯这个收件箱，遇到类似消息就照刚才的流程处理" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

### 8. 查看学习层和建议任务

```bash
agentos learn status
agentos learn sources ls
agentos memory search "合同续签"
agentos digest run
agentos proposals ls
agentos proposals accept <proposal-id>
```

### 9. 管理定时任务

```bash
agentos jobs ls
agentos jobs inspect <job-id>
agentos jobs run <job-id>
agentos jobs disable <job-id>
agentos jobs enable <job-id>
```

### 10. 修复 setup 或卸载本地安装

```bash
agentos setup --fix --dry-run
agentos setup --fix
agentos uninstall --dry-run
agentos uninstall --purge
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
agentos memory search "报价"
agentos proposals ls
agentos proposals accept <proposal-id>
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

- 默认所有本地状态都在 `~/.agentos/`，除非你显式设置了 `AGENTOS_DATA_DIR`
- 默认 daemon 状态在 `~/.agentos/daemon/`
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
agentos daemon restart
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
