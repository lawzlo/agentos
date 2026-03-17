# AgentOS

Languages: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS は、ユーザーの代わりにブラウザやデスクトップアプリを操作するためのローカルファーストな agent control plane です。ベアメタル OS ではなく、macOS / Windows 上で動く agent operating layer であり、タスク入力、workspace、trace、artifact、policy、常駐 watch を 1 つのローカル runtime にまとめます。

## 実装済みの内容

- ローカル HTTP + WebSocket control plane
- daemon、タスク、takeover、watch rule、skill を扱う `agentos` CLI
- `Sentinel / Planner / Operator / Verifier / Recovery` 実行パイプライン
- ブラウザとデスクトップで共通の `WorldState`
- 自然言語ターゲットの grounding
- `clickTarget`、`typeIntoTarget`、`waitForTarget` などの target-based action
- Playwright ベースの managed browser workspace
- macOS / Windows desktop surface abstraction
- Rust sidecar による native runtime
- skill registry、workspace profile、watch rule、credential vault
- Teach recording、teach mode、watch teach
- SQLite ベースの永続化

## クイックスタート

```bash
npm install
npm run build:ts
node dist/bin/agentos.js daemon start
```

デフォルトでは `http://localhost:3017` で待ち受けます。Web console は trace / debug 用として残っていますが、主な入口は CLI です。

## TypeScript と Rust

- `TypeScript` が `src/`、`bin/`、`public/`、`test/` のアプリ/runtime ソースを担当
- `Rust` が native / runtime-heavy 部分を担当し、[`rust/agentos-native`](./rust/agentos-native) に配置
- macOS native path は Rust sidecar と内蔵 native bridge を通して screenshot、OCR、window listing、permission status を提供
- Windows bridge は capture、window discovery、input injection、OCR / text lookup を提供

よく使うコマンド:

```bash
npm run typecheck
npm run build:ts
npm run native:build
```

## CLI 利用例

daemon の起動と確認:

```bash
node dist/bin/agentos.js daemon start
node dist/bin/agentos.js daemon status
```

単発タスクの実行:

```bash
node dist/bin/agentos.js run "打开 example.com，点击 More information，然后截图" --surface browser
```

タスクや trace の確認:

```bash
node dist/bin/agentos.js ps
node dist/bin/agentos.js inspect <task-id>
node dist/bin/agentos.js logs <task-id>
```

実行中タスクの pause / takeover:

```bash
node dist/bin/agentos.js control <task-id> pause
node dist/bin/agentos.js control <task-id> request_takeover
node dist/bin/agentos.js control <task-id> return_to_agent --note "I fixed the window focus"
```

常駐 watch rule の作成:

```bash
node dist/bin/agentos.js watch add "一直盯 Slack，有新消息就按我的风格回复" --skill slack-reply --workspace personal-main
node dist/bin/agentos.js watch ls
```

完了済みタスクを watch profile として学習:

```bash
node dist/bin/agentos.js watch teach <task-id> "一直盯这个收件箱，看到同类消息就按刚才的流程处理" --pack generic-mail-desktop --workspace personal-main
```

## Runtime メモ

- ローカル状態は `.agentos/` 以下に保存されます
- daemon 状態は `.agentos/daemon/` に保存されます
- ブラウザ実行には Chrome 系 executable が必要です
- デスクトップ watch は context extraction、backoff / retry metadata、teach-based live hints をサポートします
- タスク完了後、自動で teach recording が生成され、skill / watch 学習時に再利用されます

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

## 例: target-based task

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
