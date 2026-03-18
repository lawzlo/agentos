# AgentOS 路线图

## 总览

AgentOS 已经不再是原型验证。现在本地 daemon、CLI、浏览器和桌面执行、watch rules、draft、reply policy、定时任务、learning loop，以及几条高价值 app pack 主线都已经跑通了。

下一阶段的重点，不是“再随便加几个功能”，而是把 AgentOS 做成一个用户愿意长期开着、敢长期信任的产品：本地优先、24 小时待命、审批可控、每天都能产生价值。

这份路线图就是围绕这个目标来排的。

## 产品原则

- 默认本地优先
- 默认 CLI-first，Web 只作为调试和观测工具
- 以真实浏览器 / 桌面 / 视觉 grounding 为主，不走纯 API 自动化路线
- 默认 draft-first，自治必须带审批边界
- 通过 trace、memory、artifacts 保证可审计
- 第一天就有价值，但最终目标是成长为 24x7 的个人数字执行者

## 当前状态

### 已经具备的能力

- 本地 daemon 和 `agentos` CLI
- 浏览器与桌面任务执行
- watch、draft、approval、reply policy
- `daily_digest`、`morning_scan` 这类 recurring jobs
- learning sources、memory search、digest、proposal
- 已内置 Slack、微信桌面版、浏览器/桌面邮箱、BOSS、Google Drive、Google Docs、飞书文档等 live packs
- release packaging、setup、setup fix、uninstall，以及比较完整的自动化测试

### 仍然不够完整的部分

- 真正产品级的 always-on 恢复能力和长期运行稳定性
- 最高价值 app pack 的深度仍然不够
- learning loop 还没有足够明显地改善后续行为
- 安装和 onboarding 还没到完全开箱即用
- 对外定位和与云端 AI 员工产品的差异化表达还不够强

## 必须做

这些是 AgentOS v2 最关键的工作。

### 1. Always-on 硬化

目标：长时间无人值守时，不出现静默漂移、重复执行、或绕过策略的问题。

工作内容：

- 更强的 daemon 重启与 crash recovery
- 更完整的 tasks、drafts、jobs、watches 启动恢复
- 更强的 backoff、retry、degraded-state 处理
- 更清晰的 daemon、packs、watches、jobs 健康状态观测
- 更扎实的自启动校验

验收标准：

- 重启、重开机、临时故障后，standing workflows 仍然能对上状态
- degraded 的 watches 和 jobs 可见、可恢复
- 长期运行不会悄悄积累卡死状态

### 2. 做深最高价值 packs

目标：把日常最常用的 packs 做到用户愿意一直开着。

优先 pack：

- Mail
- Slack
- WeChat desktop
- BOSS

工作内容：

- 更强的上下文提取
- 更好的 draft 质量
- 更清晰的线程级状态与 escalation
- 更扎实的 pack 健康诊断
- 更多贴近真实消息流的端到端测试

验收标准：

- 这些 packs 在 detect、context、draft、approve、retry、recover 上都能稳定运作
- 用户能看懂一个 pack 为什么是 ready、blocked、degraded 或 paused

### 3. 让 learning loop 真正有用

目标：learning 不只是收集数据，而是真的改善后续工作。

工作内容：

- 更强的偏好记忆和修正记忆
- proposal 质量提升
- learned suggestion 的来源追踪
- 让 learning 结果改善未来 draft 和 follow-up
- 更强的学习源权限控制，明确哪些来源可以影响后续行为

验收标准：

- 用户能看懂学到了什么、来自哪里、如何影响了下一次动作
- learning 可以改善后续 draft 和 proposal，但不能绕过 policy

## 应该做

这些也重要，但优先级应该排在 v2 核心稳定性工作之后。

### 4. 安装和 onboarding 打磨

目标：安装体验更像产品，而不是开发环境。

工作内容：

- 更自包含的打包安装
- 更清晰的浏览器登录态、模型配置、桌面权限说明
- 更好的首次启动引导
- 更友好的诊断与修复提示

验收标准：

- 新用户能快速安装、完成 setup、看懂阻塞项，并在短时间内完成第一条 smoke test

### 5. 更清晰的自治控制

目标：让用户非常清楚 AgentOS 什么会自己做，什么不会。

工作内容：

- packs、watches、jobs 的 policy 摘要
- 更强的时间窗口、预算、风险控制
- 更清晰的 thread-level lease 可见性
- 更明确解释为什么某件事进入了 draft、被 block、或者被 auto-send

验收标准：

- 用户不用猜，就能回答“AgentOS 现在会不会自己把这条消息发出去”

### 6. 更强的产品表达

目标：让外部用户理解 AgentOS 是一种产品类别，而不是一个技术仓库。

工作内容：

- 更强的 README 和 landing 文案
- 更清晰地解释它和 cloud-first agent 产品的区别
- 更多真实案例、demo、使用指南

验收标准：

- 新用户能快速理解 AgentOS 是什么、为什么 local-first 重要、它最适合解决哪些问题

## 可以以后做

这些值得做，但不应该压过上面的核心工作。

### 7. 更多 app packs

可以扩展的方向：

- 更多聊天应用
- 更多文档与协作工具
- 更多个人效率类 surface

原则：

- 不要在核心 packs 还没做深之前，先做很多浅层 pack

### 8. 更丰富的 UI

可以扩展的方向：

- 更好的本地 dashboard
- 更丰富的 trace 查看器
- 更强的 pack / autonomy 检查器

原则：

- UI 是运行时的辅助面，不是要取代 CLI-first 的产品模型

### 9. 团队协作能力

可以扩展的方向：

- 共享 workspace
- 共享 watch policy
- 团队级审批队列

原则：

- 不要过早让团队特性把 local-first 的个人产品核心带偏

## 建议实施顺序

1. Always-on 硬化
2. 做深 Mail、Slack、WeChat desktop、BOSS
3. 提升 learning 的可用性与可审计性
4. 持续打磨 installer 和 onboarding
5. 再往外扩更多 packs 或更重的 UI

## 成功后的样子

AgentOS v2 做成以后，应该给人这样的感受：

- 用户安装后，能快速完成 setup，几分钟内拿到第一条真实结果
- agent 可以全天在线，稳定运行 watches 和 jobs，并且能从正常故障中恢复
- 消息类 app 的 draft、approval、retry、escalation 都是可理解、可信任的
- learning 会帮助明天的工作，而不是变成一团不可控的后台行为
- 这个产品和 cloud-first 的“AI 员工”明显不同，因为 runtime、memory 和控制权都在用户自己手里
