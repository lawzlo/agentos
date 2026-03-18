# AgentOS

Languages: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS は、ユーザーの代わりにブラウザやデスクトップアプリを操作するためのローカルファーストな personal agent runtime です。ベアメタル OS ではなく、macOS / Windows 上で動作する常駐 agent layer であり、タスク、workspace、trace、学習、watch rule を 1 つのローカル runtime にまとめます。

## 推奨デプロイ方法

AgentOS は、ブラウザ、デスクトップアプリ、ローカルファイル、常駐 watch rule を操作できるほど強力です。小さな補助スクリプトではなく、実際のオペレーターとして扱うべきです。

- 初期導入は専用マシン、mini PC、VM、または別 OS ユーザーで行うことを推奨します
- いきなり普段使いのメイン browser profile に接続しないでください
- まずは低リスクな app と `draft-first` の返信ポリシーから始めてください
- 支払い、削除、署名、送信などの高リスク操作は人間の承認を残すべきです
- 常時稼働を信用する前に `doctor` を実行してください

## AgentOS でできること

- ローカル daemon と CLI を起動し、継続的に常駐させる
- ブラウザとデスクトップを共通の `WorldState` で扱う
- 自然言語の指示を実行可能な UI target に grounding する
- trace、artifact、workspace、skill、watch profile、資格情報をローカル保存する
- タスク結果、watch 検出、手動修正、選択されたローカルファイルから学習する
- 学習内容から提案タスクを作るが、デフォルトでは自動実行しない

## 現在の実装範囲

- ローカル HTTP + WebSocket control plane
- daemon、task、draft、watch rule、memory search、proposal を扱う `agentos` CLI
- `Sentinel / Planner / Operator / Verifier / Recovery` 実行チェーン
- Playwright ベースの managed browser workspace
- Rust sidecar による native desktop runtime
- `clickTarget`、`typeIntoTarget`、`waitForTarget`、`extractFromTarget` などの target-based action
- 永続化された workspace profile、watch rule、draft approval flow
- observations、entities、knowledge chunks、daily digest、proposals を含む local learning loop
- SQLite ベースのローカル永続化

## ディレクトリ構成

- `src/`: runtime、server、adapter、service、schema
- `bin/`: CLI エントリポイントとサブコマンド
- `rust/agentos-native/`: Rust native sidecar
- `public/`: ローカル debug console
- `test/`: integration test と runtime test
- `.agentos/`: ローカル DB、ログ、workspace、artifact、daemon state

## クイックスタート

多くのユーザーは自然言語の CLI から始めるべきです。最初から JSON を書く必要はありません。

1. 依存関係を入れ、runtime を build して daemon を起動します。

```bash
npm install
npm run build:ts
node dist/bin/agentos.js daemon start
```

2. 起動確認:

```bash
node dist/bin/agentos.js daemon status
node dist/bin/agentos.js doctor
```

3. 最初の単発タスクを実行します。

```bash
node dist/bin/agentos.js run \
  "example.com を開き、More information をクリックして、スクリーンショットを撮る" \
  --surface browser \
  --wait
```

4. 最初の常駐 watch rule を追加します。

```bash
node dist/bin/agentos.js watch add \
  "Slack を監視し、低リスクの未読スレッドには自分の文体で返信する" \
  --surface browser \
  --workspace personal-main
```

デフォルトでは `http://127.0.0.1:3017` で待ち受けます。Web console は trace / debug 用に残っていますが、主入口は CLI です。

## よくある personal agent シナリオ

以下は AgentOS が想定している代表的な実運用シナリオです。通常はユーザーが JSON を手書きする必要はありません。

### 1. ブラウザ調査と整理

```bash
node dist/bin/agentos.js run \
  "対象サイトを開き、重要ポイントを集めて、短い要約を workspace に保存する" \
  --surface browser \
  --wait
```

### 2. メールの仕分けと草稿返信

```bash
node dist/bin/agentos.js watch add \
  "メールを監視し、新しい顧客メッセージにはまず草稿を作り、リスクの高い返信は承認待ちにする" \
  --surface browser \
  --workspace personal-main
```

### 3. Slack の低リスク自動返信

```bash
node dist/bin/agentos.js watch add \
  "Slack を監視し、低リスクの未読スレッドには自分の文体で返信する" \
  --surface browser \
  --workspace personal-main
```

### 4. WeChat desktop のメッセージ補助

```bash
node dist/bin/agentos.js watch add \
  "WeChat desktop を監視し、未読の顧客メッセージには返信草稿を作る" \
  --surface desktop \
  --workspace personal-main
```

### 5. BOSS直聘 の採用フォロー

```bash
node dist/bin/agentos.js watch add \
  "BOSS直聘 を監視し、新しい候補者を確認して、丁寧なフォローアップを草稿化する" \
  --surface browser \
  --workspace recruiting-main
```

### 6. Google Drive とドキュメント作業

```bash
node dist/bin/agentos.js run \
  "Google Drive を開き、Downloads の最新ファイルをアップロードして、完了を確認する" \
  --surface browser \
  --wait

node dist/bin/agentos.js run \
  "Google Docs を開き、週報を更新して保存する" \
  --surface browser \
  --wait
```

### 7. 毎日の学習、digest、フォローアップ候補

```bash
node dist/bin/agentos.js learn status
node dist/bin/agentos.js memory search "pricing"
node dist/bin/agentos.js digest run
node dist/bin/agentos.js proposals ls
```

### 8. 一度やった作業を常駐フローに教える

```bash
node dist/bin/agentos.js watch teach \
  <task-id> \
  "この inbox を見続け、似たメッセージは同じ流れで処理する" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

## ビルド要件

TypeScript の型チェック:

```bash
npm run typecheck
```

`dist/` への build:

```bash
npm run build:ts
```

Rust sidecar の build:

```bash
npm run native:build
```

補足:

- Rust sidecar の build には `cargo` が必要です
- `dist/` は生成物なので git に commit しません
- ブラウザ検出に失敗した場合は `AGENTOS_BROWSER_EXECUTABLE` を設定します
- ブラウザの実動作を見たい場合は `AGENTOS_HEADLESS=false` を設定します

## コアランタイムモデル

現在の AgentOS は次のオブジェクトを中心に動きます。

- `Task`: 単発の作業単位
- `Workspace`: 永続的なブラウザ / アプリ状態
- `Watch rule`: 新しい項目を監視し、task または draft を作る常駐ルール
- `Draft`: 承認待ちの保守的なアクション
- `Skill`: 再利用可能な学習済み workflow
- `Learning source`: ファイルシステム、watch event、task result、手動修正などの学習入力
- `Proposal`: learning layer が生成する提案タスク

## よく使う CLI フロー

### 1. ブラウザタスクを実行する

```bash
node dist/bin/agentos.js run \
  "example.com を開き、More information をクリックして、スクリーンショットを撮る" \
  --surface browser \
  --wait
```

### 2. デスクトップタスクを実行する

```bash
node dist/bin/agentos.js run \
  "TextEdit を開き、短いメモを入力して待機する" \
  --surface desktop
```

### 3. タスクと trace を確認する

```bash
node dist/bin/agentos.js ps
node dist/bin/agentos.js inspect <task-id>
node dist/bin/agentos.js logs <task-id>
```

### 4. 実行中タスクを pause / takeover する

```bash
node dist/bin/agentos.js control <task-id> pause
node dist/bin/agentos.js control <task-id> request_takeover
node dist/bin/agentos.js control <task-id> return_to_agent --note "Window focus was fixed manually"
node dist/bin/agentos.js control <task-id> stop
```

### 5. 常駐 watch rule を作成する

```bash
node dist/bin/agentos.js watch add \
  "Slack を監視し、低リスクの未読スレッドには自分の文体で返信する" \
  --surface browser \
  --workspace personal-main
```

状態確認:

```bash
node dist/bin/agentos.js watch ls
node dist/bin/agentos.js watch inspect <watch-id>
node dist/bin/agentos.js watch health <watch-id>
node dist/bin/agentos.js watch retry <watch-id>
```

### 6. draft を確認または承認する

```bash
node dist/bin/agentos.js drafts ls
node dist/bin/agentos.js drafts inspect <draft-id>
node dist/bin/agentos.js drafts approve <draft-id>
node dist/bin/agentos.js drafts reject <draft-id> --reason "Human reply required"
```

### 7. 完了済み task を watch profile に学習する

```bash
node dist/bin/agentos.js watch teach \
  <task-id> \
  "この inbox を見続け、似たメッセージは同じ流れで処理する" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

### 8. learning layer と proposal を確認する

```bash
node dist/bin/agentos.js learn status
node dist/bin/agentos.js learn sources ls
node dist/bin/agentos.js memory search "renewal"
node dist/bin/agentos.js digest run
node dist/bin/agentos.js proposals ls
node dist/bin/agentos.js proposals accept <proposal-id>
```

## Learning loop

AgentOS には継続学習レイヤーが含まれています。

デフォルト動作:

- ユーザー環境の広い範囲でファイル metadata を収集する
- 管理対象ディレクトリやテキスト系ファイルのみ内容を選択的に読む
- watch 検出、task 結果、手動修正から学習する
- 構造化メモリと検索可能な knowledge をローカルに保存する
- proposal を静かに生成し、デフォルトでは自動実行しない

学習ソース:

- `filesystem-metadata`
- `filesystem-content`
- `watch-events`
- `task-results`
- `user-corrections`

典型的な利用:

```bash
node dist/bin/agentos.js memory search "pricing"
node dist/bin/agentos.js proposals ls
node dist/bin/agentos.js proposals accept <proposal-id>
```

## JSON 例

### 例: target-based browser task

```json
{
  "goal": "フォームを入力して結果をキャプチャする",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "steps": [
    {
      "label": "ページを開く",
      "surface": "browser",
      "action": "goto",
      "params": { "url": "https://example.com" }
    },
    {
      "label": "メールアドレスを入力する",
      "surface": "browser",
      "action": "typeIntoTarget",
      "params": {
        "targetQuery": "email",
        "text": "tan@example.com",
        "clear": true
      }
    },
    {
      "label": "送信する",
      "surface": "browser",
      "action": "clickTarget",
      "params": { "targetQuery": "submit" }
    },
    {
      "label": "最終状態をキャプチャする",
      "surface": "browser",
      "action": "capture",
      "params": { "label": "done" }
    }
  ]
}
```

### 例: desktop task

```json
{
  "goal": "TextEdit を開いてメモを入力する",
  "preferredSurface": "desktop",
  "inputs": {
    "desktopApp": "TextEdit",
    "typeText": "AgentOS からのデイリーメモ"
  },
  "steps": [
    {
      "label": "TextEdit を開く",
      "surface": "desktop",
      "action": "openApp",
      "params": { "name": "TextEdit" }
    },
    {
      "label": "エディタが表示されるまで待つ",
      "surface": "desktop",
      "action": "waitForText",
      "params": { "text": "TextEdit", "timeoutMs": 5000 }
    },
    {
      "label": "メモを入力する",
      "surface": "desktop",
      "action": "type",
      "params": { "text": "AgentOS からのデイリーメモ" }
    }
  ]
}
```

### 例: watch rule

```json
{
  "goal": "Slack を監視し、低リスクの未読スレッドには自分の文体で返信する",
  "preferredSurface": "browser",
  "workspaceName": "personal-main",
  "livePack": "slack-browser",
  "pollIntervalMs": 15000
}
```

### 例: task control

```json
{
  "action": "request_takeover"
}
```

サポートされている task control:

- `pause`
- `resume`
- `request_takeover`
- `return_to_agent`
- `stop`

## Runtime メモ

- すべてのローカル状態は `.agentos/` 配下に保存されます
- daemon state は `.agentos/daemon/` に保存されます
- ブラウザ自動化には Chrome 系 executable が必要です
- ブラウザはデフォルトで headless 実行です
- macOS では Accessibility と Screen Recording の権限が必要な場合があります
- Windows の desktop automation は sidecar 経由で PowerShell / Win32 を利用します
- 現在の内蔵 live pack:
  - `slack-browser`
  - `slack-desktop`
  - `wechat-desktop`
  - `generic-mail-desktop`
  - `generic-desktop`
- 学習データ、digest、proposal はローカルのみで保持されます

## API 概要

システム:

- `GET /health`
- `GET /doctor`
- `POST /doctor/bundle`
- `GET /version`
- `GET /daemon/status`

タスク:

- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/:id/control`
- `POST /tasks/:id/teach-steps`
- `GET /traces/:id`
- `POST /events`
- `GET /events`
- `POST /policy/evaluate`

Watch / draft:

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

Skill / workspace / vault:

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

## 開発とリリース

フルテスト:

```bash
npm test
```

ローカル build 後に daemon を再起動:

```bash
node dist/bin/agentos.js daemon restart
```

リリース成果物の準備:

```bash
npm run package:release -- --platform darwin
ALLOW_UNSIGNED_PACKAGE=1 npm run package:macos
npm run package:windows
```

## License

MIT. 詳細は [LICENSE](./LICENSE) を参照してください。
