# AgentOS

Languages: [English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

AgentOS は、ユーザーの代わりにブラウザやデスクトップアプリを操作するためのローカルファーストな personal agent runtime です。ベアメタル OS ではなく、macOS / Windows 上で動作する常駐 agent layer であり、タスク、workspace、trace、学習、watch rule を 1 つのローカル runtime にまとめます。

## ただのチャット欄ではなく、実際に動く personal agent

- すでに使っている browser や desktop app をそのまま操作できる
- inbox、document、定期ルーチンを常時監視できる
- 最初は draft と approval から始まり、信頼に応じて自律性を広げられる
- 会話が終わっても消えず、trace、memory、artifact を残せる

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

## なぜ使うのか

- 繰り返しのブラウザ作業や inbox 対応を、その場限りのスクリプトではなく常駐ローカル workflow にできる
- 初日から完全自動化しなくても、低リスクなデジタルオペレーターを一日中待機させられる
- まず返信、要約、フォローアップを草稿として出し、信頼に応じて徐々に自律性を広げられる
- 一度うまくいった task を watch profile や定期ジョブに変えて、翌日ゼロからやり直さなくてよい
- trace、memory、資格情報、実行コンテキストをローカルに残し、ホスト型 SaaS control plane に丸ごと渡さなくてよい

## AgentOS の典型的な一日

- 朝: browser scan を走らせ、inbox を sweep し、その日の attention item を集める
- 日中: メール、Slack、WeChat、採用 follow-up を草稿化し、リスクが高いものは承認待ちに残す
- 午後: ファイルのアップロード、document 更新、スクリーンショット取得を行い、結果を workspace に保存する
- 夜: digest を生成し、何が変わったかを記録し、次の proposal を並べる

## 現在の実装範囲

- ローカル HTTP + WebSocket control plane
- daemon、task、draft、watch rule、memory search、proposal を扱う `agentos` CLI
- `Sentinel / Planner / Operator / Verifier / Recovery` 実行チェーン
- Playwright ベースの managed browser workspace
- Rust sidecar による native desktop runtime
- `clickTarget`、`typeIntoTarget`、`waitForTarget`、`extractFromTarget` などの target-based action
- Slack、WeChat desktop、browser / desktop mail、BOSS、Google Drive、Google Docs、Feishu Docs 向けの live pack を同梱
- 永続化された workspace profile、watch rule、draft approval flow
- observations、entities、knowledge chunks、daily digest、proposals を含む local learning loop
- SQLite ベースのローカル永続化

## ディレクトリ構成

- `src/`: runtime、server、adapter、service、schema
- `bin/`: CLI エントリポイントとサブコマンド
- `rust/agentos-native/`: Rust native sidecar
- `public/`: ローカル debug console
- `test/`: integration test と runtime test
- デフォルトでは `~/.agentos/`: ローカル DB、ログ、workspace、artifact、daemon state

## クイックスタート

多くのユーザーは自然言語の CLI から始めるべきです。最初から JSON を書く必要はありません。

1. 依存関係を入れ、runtime を build し、ローカルの `agentos` コマンドを有効にします。

```bash
npm install
npm run cli:link
```

2. 最初に setup チェックを実行します。daemon、browser、model 設定、native sidecar、live pack、次の手順をまとめて確認できます。

```bash
agentos setup
```

3. model は環境変数を手で書く代わりに `agentos model setup` を使います。OpenAI、Claude、Gemini、または独自の OpenAI-compatible endpoint を選んで、API key を貼り付けます。AgentOS はその key で利用できる model を取得し、短い推奨リストを表示します。

```bash
agentos model setup
```

4. runtime ディレクトリや自動起動などの低リスクなローカル修復が必要なら、先に AgentOS に適用させます。

```bash
agentos setup --fix --dry-run
agentos setup --fix
```

`setup --fix` は低リスクなローカル修復だけを適用します。browser のログインと desktop 権限は人間が行う必要があり、`agentos setup` の manual step に表示されます。model access は `agentos model setup` を使います。

5. 対話シェルを開くか、最初の単発タスクを実行します。

```bash
agentos

agentos "example.com を開き、More information をクリックして、スクリーンショットを撮る" --surface browser
```

6. 最初の常駐 watch rule を追加します。

```bash
agentos watch add \
  "Slack を監視し、低リスクの未読スレッドには自分の文体で返信する" \
  --surface browser \
  --workspace personal-main
```

デフォルトでは `http://127.0.0.1:3017` で待ち受けます。Web console は trace / debug 用に残っていますが、主入口は CLI です。

まだ `agentos` コマンドが PATH にない場合は、source checkout で先に `npm run cli:link` を実行してください。

## setup が自動で直すものと直さないもの

- `agentos setup --fix` は不足している runtime ディレクトリの作成と、現在のユーザー向け daemon 自動起動の導入ができます
- Slack、メール、BOSS、Drive、Docs へのログインは自動では行いません
- model access は `agentos model setup` で行い、`setup --fix` は API key を扱いません
- desktop の Accessibility や Screen Recording 権限を迂回しません
- `setup --fix` の後にもう一度 `agentos setup` を実行し、まず smoke test を 1 つ、その後に低リスクな常駐 workflow を 1 つ追加するのが安全です

## 最初の 10 分で試すなら

価値を最短で感じたいなら、次の順で試すのが分かりやすいです。

```bash
agentos model setup
agentos "example.com を開き、More information をクリックして、スクリーンショットを撮る" --surface browser
agentos "ローカルのテキストエディタを開き、短いメモを入力して、私に制御を返す" --surface desktop
agentos jobs add daily_digest --hour 18
agentos watch add "メールを監視し、新しい顧客メッセージにはまず草稿を作り、リスクの高い返信は承認待ちにする" --surface browser --workspace personal-main
```

## よくある personal agent シナリオ

以下は AgentOS が想定している代表的な実運用シナリオです。通常はユーザーが JSON を手書きする必要はありません。

### 1. ブラウザ調査と整理

workspace と trace を残しながら動く Web リサーチャーとして使えます。

```bash
agentos run \
  "対象サイトを開き、重要ポイントを集めて、短い要約を workspace に保存する" \
  --surface browser \
  --wait
```

### 2. 価格ページ、FAQ、競合ページの要約

会議前の整理や競合把握に向いた使い方です。

```bash
agentos run \
  "価格ページと FAQ を開いて差分を整理し、メモを workspace に保存する" \
  --surface browser \
  --wait
```

### 3. メールの仕分けと草稿返信

inbox を進めつつ、高リスクな返信は人間の承認に残します。

```bash
agentos watch add \
  "メールを監視し、新しい顧客メッセージにはまず草稿を作り、リスクの高い返信は承認待ちにする" \
  --surface browser \
  --workspace personal-main
```

### 4. Slack の低リスク自動返信

単純なスレッドは片付け、難しいものだけ人に戻せます。

```bash
agentos watch add \
  "Slack を監視し、低リスクの未読スレッドには自分の文体で返信する" \
  --surface browser \
  --workspace personal-main
```

### 5. WeChat desktop のメッセージ補助

公開 API がない desktop app でも、実際の画面を前提に扱えます。

```bash
agentos watch add \
  "WeChat desktop を監視し、未読の顧客メッセージには返信草稿を作る" \
  --surface desktop \
  --workspace personal-main
```

### 6. BOSS直聘 の採用フォロー

候補者確認、文脈収集、丁寧な follow-up 草稿までを繰り返し処理できます。

```bash
agentos watch add \
  "BOSS直聘 を監視し、新しい候補者を確認して、丁寧なフォローアップを草稿化する" \
  --surface browser \
  --workspace recruiting-main
```

### 7. ローカル文書の整理と保管

契約書、請求書、領収書、PDF などの整頓に向いています。

```bash
agentos run \
  "Downloads で最新の PDF を見つけて contracts workspace に移動し、保存先を教える" \
  --surface desktop \
  --wait
```

### 8. Google Drive とドキュメント作業

アップロード、編集、保存の繰り返しを browser 側のオペレーターとして処理できます。

```bash
agentos run \
  "Google Drive を開き、Downloads の最新ファイルをアップロードして、完了を確認する" \
  --surface browser \
  --wait

agentos run \
  "Google Docs を開き、週報を更新して保存する" \
  --surface browser \
  --wait
```

### 9. 朝のスキャンと inbox sweep job

一回限りの task 実行ではなく、毎日の定期オペレーターにできます。

```bash
agentos jobs add morning_scan --workspace personal-main --surface browser --hour 9
agentos jobs add inbox_sweep --workspace personal-main --surface browser --hour 10
agentos jobs add follow_up_sweep --workspace personal-main --surface auto --interval-minutes 180 --input staleAfterHours=24 --input awaiting=true --input priorityMode=stale_first
```

### 10. 終業時 digest と proposal の確認

危険な外部作用を自動送信せずに、能動性だけを高める安全な形です。

```bash
agentos jobs add daily_digest --hour 18
agentos jobs add proposal_sweep --workspace personal-main --hour 19
```

### 11. 毎日の学習、digest、フォローアップ候補

何を学んだかを検索し、次にやるべきことだけを受け取れます。

```bash
agentos learn status
agentos memory search "pricing"
agentos digest run
agentos proposals ls
```

### 12. 一度やった作業を常駐フローに教える

最初は人間が丁寧にやり、安定したら standing workflow に変えるやり方です。

```bash
agentos watch teach \
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
agentos run \
  "example.com を開き、More information をクリックして、スクリーンショットを撮る" \
  --surface browser \
  --wait
```

### 2. デスクトップタスクを実行する

```bash
agentos run \
  "TextEdit を開き、短いメモを入力して待機する" \
  --surface desktop
```

### 3. タスクと trace を確認する

```bash
agentos ps
agentos inspect <task-id>
agentos logs <task-id>
```

### 4. 実行中タスクを pause / takeover する

```bash
agentos control <task-id> pause
agentos control <task-id> request_takeover
agentos control <task-id> return_to_agent --note "Window focus was fixed manually"
agentos control <task-id> stop
```

### 5. 常駐 watch rule を作成する

```bash
agentos watch add \
  "Slack を監視し、低リスクの未読スレッドには自分の文体で返信する" \
  --surface browser \
  --workspace personal-main
```

状態確認:

```bash
agentos watch ls
agentos watch inspect <watch-id>
agentos watch health <watch-id>
agentos watch retry <watch-id>
```

### 6. draft を確認または承認する

```bash
agentos drafts ls
agentos drafts inspect <draft-id>
agentos drafts approve <draft-id>
agentos drafts reject <draft-id> --reason "Human reply required"
```

### 7. 完了済み task を watch profile に学習する

```bash
agentos watch teach \
  <task-id> \
  "この inbox を見続け、似たメッセージは同じ流れで処理する" \
  --pack generic-mail-desktop \
  --workspace personal-main
```

### 8. learning layer と proposal を確認する

```bash
agentos learn status
agentos learn sources ls
agentos memory search "renewal"
agentos digest run
agentos proposals ls
agentos proposals accept <proposal-id>
```

### 9. 定期ジョブを管理する

```bash
agentos jobs ls
agentos jobs inspect <job-id>
agentos jobs run <job-id>
agentos jobs disable <job-id>
agentos jobs enable <job-id>
```

### 10. setup を修復する、またはローカルインストールをアンインストールする

```bash
agentos setup --fix --dry-run
agentos setup --fix
agentos uninstall --dry-run
agentos uninstall --purge
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
agentos memory search "pricing"
agentos proposals ls
agentos proposals accept <proposal-id>
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

- デフォルトでは、すべてのローカル状態は `~/.agentos/` 配下に保存されます。`AGENTOS_DATA_DIR` を設定した場合はそちらが優先されます
- デフォルトでは、daemon state は `~/.agentos/daemon/` に保存されます
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
agentos daemon restart
```

リリース成果物の準備:

```bash
npm run package:release -- --platform darwin
ALLOW_UNSIGNED_PACKAGE=1 npm run package:macos
npm run package:windows
```

## License

MIT. 詳細は [LICENSE](./LICENSE) を参照してください。
