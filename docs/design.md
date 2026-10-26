# GeminiCode 検討メモ：スマホのブラウザから Gemini CLI を「Claude Code on the web」のように使う

## 1. ゴール（Claude アプリの Code の使い心地を分解する）

Claude アプリの Code（claude.ai/code）の体験を要素に分けると、次のとおり。

| # | 体験要素 | 中身 |
|---|---|---|
| U1 | チャット UI | ターミナルではなく、スマホで読みやすいメッセージ形式。ツール実行はカードとして折りたたむ |
| U2 | 非同期実行 | ブラウザを閉じてもタスクは走り続ける。戻ると途中経過が全部見える |
| U3 | セッション一覧 | リポジトリ × タスク単位で複数セッションを並行して持てる |
| U4 | 隔離環境 | セッションごとにクリーンなワークスペースがあり、本体 PC を汚さない |
| U5 | Git 連携 | セッションごとにブランチを作り、commit / push / PR 作成まで行う |
| U6 | 差分レビュー | 変更ファイルと diff をスマホで確認できる |
| U7 | 権限確認 | 危険な操作はボタンで承認 / 拒否できる |
| U8 | 通知 | 完了・承認待ちをプッシュ通知で知らせる |
| U9 | 認証 | 自分だけがアクセスできる |

この表の要素を、どの方式でどこまで満たせるかで比較する。

## 2. Gemini CLI 側で使える口

| 口 | 概要 | 向き不向き |
|---|---|---|
| 対話 TUI | 通常の `gemini` | スマホの画面幅とソフトキーボードでは厳しい |
| Headless | `gemini -p "..." --output-format stream-json`（JSONL で `init` / `message` / `tool_use` / `tool_result` / `result` イベント）。`--resume <session_id>` で継続 | 単発実行と非同期ジョブには十分。途中で対話的に権限を確認する仕組みはなく、`--yolo` か許可ツールの事前指定が必要 |
| ACP（Agent Client Protocol） | stdio 上の JSON-RPC。Zed などのエディタ連携用。セッション、ストリーミング差分、ツール呼び出しの進捗、**権限リクエスト**（`session/request_permission`）を構造化して扱える | UI を自作するなら最も適している。U1・U7 をそのまま実装できる |
| GitHub Actions（run-gemini-cli） | Issue / PR のコメントをきっかけに実行 | 非同期で Git 連携も済むが、チャットのような使い心地にはならない |

> 確認済み（Gemini CLI 0.65.0）: 起動フラグは `--acp`（`--experimental-acp` は非推奨の別名）。`initialize` で `loadSession: true` を返し、承認モード `default` / `autoEdit` / `yolo` / `plan` を `session/set_mode` で切り替えられる。`GEMINI_API_KEY` が環境変数にあれば `authenticate` を呼ばなくても `session/new` が通る。

## 3. 方式の比較

### A. Web ターミナル（ttyd / tmux + Tailscale）
- 手間：最小（半日程度）。tmux を使えば U2 も満たせる。
- 欠点：結局は TUI なので、U1・U6・U7・U8 は満たせない。スマホでの入力がつらい。
- 位置付け：**すぐ試すための暫定策**。

### B. 既存 OSS の Web UI（Gemini-CLI-UI、gemini-cli-desktop の Web 版など）
- 利点：導入するだけでチャット UI が手に入る。レスポンシブ対応をうたうものもある。
- 欠点：認証が無い / 弱い、メンテナンスが止まり気味、モバイルでは閲覧のみといった制限がある。U4・U5（隔離環境 + ブランチ + PR）は基本的に持っていない。
- 位置付け：使い心地の確認と、UI の参考。

### C. 自作：PWA + ゲートウェイ + ACP ワーカー（推奨）
- 利点：表の U1〜U9 をすべて設計に入れられる。Gemini CLI 本体には手を入れず、外側で包むだけなので、CLI の更新に追随しやすい。
- 欠点：開発が必要（MVP で数日〜2 週間規模）。

### D. GitHub Issue 駆動（run-gemini-cli）
- 利点：サーバーが不要で、U4・U5 は GitHub が担う。GitHub アプリからも操作できる。
- 欠点：返事が遅く、チャットのやり取りにならない。
- 位置付け：C の「放置タスク」モードの代わりや補完として有用。

**結論：C を本命にする。立ち上げ期は A で凌ぎ、B は UI の参考にする。**

## 4. 推奨構成（方式 C）

```
[スマホ PWA] ──HTTPS(REST + SSE)──> [ゲートウェイ] ──spawn/stdio(ACP)──> [ワーカー: gemini (ACP モード)]
     │                                │                                  │
     │ Web Push                       ├─ SQLite: セッション / イベントログ   └─ ワークスペース（git clone / worktree）
     └────────────────────────────────┤                                      ※ セッションごとにコンテナ or ディレクトリ
                                      └─ GitHub App / PAT（clone・push・PR）
前段: Cloudflare Access / Tailscale / IAP（U9）
```

### 4.1 コンポーネント
- **フロントエンド（PWA）**：React + Vite。チャット画面、ツールカード（展開すると引数と出力を表示）、権限確認のボトムシート、diff ビューア（`diff2html` など）、セッション一覧。ホーム画面に追加すればアプリのように使え、Web Push も受け取れる（iOS は 16.4 以降で PWA の Push に対応）。
- **ゲートウェイ**：Node.js / TypeScript。役割は次の 3 つ。
  - ブラウザとの接続と、ワーカーのプロセスを**切り離す**（U2）。ACP のイベントはすべて SQLite に追記し、再接続したら続きから再生する。
  - 実装メモ：ブラウザへの配信は WebSocket ではなく **SSE（Server-Sent Events）** にした。ブラウザの `EventSource` は切断されると自動で再接続し、最後に受け取った ID を `Last-Event-ID` で送ってくるので、「続きから再生」がそのまま実現できる。送信は通常の POST で行う。
  - 実装メモ：ACP は改行区切りの JSON-RPC で、使うメソッドも少ないため、SDK（API の変化が速い）には依存せず自前で約 200 行で実装した。
  - 権限リクエストを保留状態として保存し、Push で通知して、ブラウザからの応答を ACP に返す（U7・U8）。
  - Git 操作（clone → `gemini/<session-id>` ブランチ作成 → commit / push → PR 作成）（U5）。
- **ワーカー**：セッションごとに ACP モードの `gemini` を 1 プロセス起動する。作業ディレクトリはセッション専用。Docker で隔離すると U4 に近づく（Gemini CLI 自身のサンドボックス `--sandbox` と併用してもよい）。

### 4.2 ホスティングの選択肢
| 置き場所 | 長所 | 短所 |
|---|---|---|
| 自宅 PC / ミニ PC + Tailscale | 無料。手元のリポジトリや資格情報をそのまま使える | PC を起動しておく必要がある |
| GCE e2-small 程度の VM + Cloudflare Access | 常時稼働、安価 | 月数百〜千円台 |
| Cloud Run | サーバー管理が不要 | 長時間のプロセスと WebSocket に制約がある。セッション状態を外部に出す必要があり、今回の用途には不向き |

→ **自宅 Windows の WSL2 に決定**（§7 を参照）。ワーカーのコンテナ化は後から入れる。

### 4.3 Gemini の認証
- 個人の Google ログイン（OAuth）：無料枠が使えるが、サーバー上では初回にブラウザでのログインが必要。一度ログインした `~/.gemini` の資格情報をサーバーに置く形になる。
- `GEMINI_API_KEY` または Vertex AI：サーバー運用ならこちらが素直。

### 4.4 セキュリティ
- アプリに独自のログインは作らず、**前段のゼロトラスト（Cloudflare Access / Tailscale）で守る**。
- `--yolo` は既定で無効にする。セッションごとに「自動承認するツール」を UI で選べるようにする（Claude Code の permission mode に相当）。
- GitHub の資格情報は、対象リポジトリだけに絞った fine-grained PAT か GitHub App を使う。

## 5. 段階的な計画

| フェーズ | 内容 | 満たす要素 |
|---|---|---|
| P0（半日） | ttyd + tmux + Tailscale で、スマホから既存の TUI を使えるようにする | U2・U9（暫定） |
| P1（MVP） | ゲートウェイ + ACP ワーカー 1 本 + チャット PWA。単一リポジトリ、ローカルディレクトリ | U1・U2・U7・U9 |
| P2 | セッション一覧、ブランチと PR の自動化、diff ビュー | U3・U5・U6 |
| P3 | Web Push、ワーカーのコンテナ隔離、Headless による「投げっぱなし」モード | U4・U8 |
| P4（任意） | GitHub Issue 駆動（run-gemini-cli）との連携、音声入力、画像添付 | — |

## 6. 決定事項
| 項目 | 決定 |
|---|---|
| ホスティング | 自宅 Windows の WSL2 |
| Gemini の認証 | `GEMINI_API_KEY` |
| スマホからの経路 | Tailscale は挟まない（スマホ側でアプリを常駐させず、バッテリー消費を避けるため） |
| 対象リポジトリ | GitHub のみ |

## 7. 決定事項を反映した具体構成

```
[スマホ PWA] ─HTTPS/WSS─> [Cloudflare Edge + Access（認証）] ─(外向きトンネル)─> [WSL2: cloudflared] ─> [ゲートウェイ :8080] ─ACP─> [gemini]
                                                                                   ※ Windows 側のポート開放・ルーター設定は不要
```

### 7.1 外部公開：Cloudflare Tunnel + Cloudflare Access（推奨）
- WSL 内の `cloudflared` から Cloudflare へ**外向き**に接続するため、ポート開放も固定 IP も不要。スマホ側にアプリを入れる必要もない。
- Cloudflare Access（無料枠は 50 ユーザーまで）で、`gemini.<自分のドメイン>` へのアクセスを、自分のメールアドレス（ワンタイム PIN か Google ログイン）に限定する。セッション有効期間を長め（例：1 か月）にすれば、スマホでの再ログインはほとんど発生しない。
- WebSocket と Web Push（HTTPS が必須）はどちらもトンネル越しに動く。
- 前提：Cloudflare で管理するドメインが 1 つ必要。**Cloudflare Registrar で `.com` などを新規に取得する**（年 10 ドル前後、原価販売）。
- ゲートウェイ側でも `Cf-Access-Jwt-Assertion` ヘッダーの JWT を検証し、トンネルを経由しない直接アクセスを拒否する（多層防御）。ゲートウェイは `127.0.0.1` だけで待ち受ける。

代替案：**Tailscale Funnel**（`*.ts.net` を公開 HTTPS にする機能で、スマホ側に Tailscale は不要）。ドメインは要らないが認証層が無いため、アプリ側でパスキー（WebAuthn）か GitHub OAuth のログインを自作する必要がある。ドメインを用意しない場合の選択肢として残す。

### 7.2 WSL2 を常時稼働させる
WSL2 はクライアントプロセスがいなくなると停止するため、次の対策をとる。
1. `/etc/wsl.conf` に `[boot] systemd=true` を書き、`cloudflared` とゲートウェイを systemd サービスとして登録する。
2. Windows の**タスクスケジューラ**に、ログオン時（またはスタートアップ時）に `wsl.exe -d Ubuntu --exec sleep infinity` を非表示で実行するタスクを登録し、ディストリビューションを生かし続ける。
3. Windows の電源設定で「スリープしない」にする（電源接続時のみでも可）。Windows Update による再起動にも備え、2. のタスクで自動復帰させる。
4. ゲートウェイは起動時に「実行中だったセッション」を検知し、中断した状態として UI に表示する。`--resume` か ACP の `session/load` で再開できるようにする。

### 7.3 API キーと課金
- API キーは `/etc/geminicode/env`（パーミッション 600）に置き、systemd の `EnvironmentFile=` でワーカーに渡す。リポジトリにもフロントエンドにも出さない。
- Google Cloud の予算アラートを設定する。ゲートウェイ側でもセッションごとのトークン使用量を表示し、1 日あたりの上限（ソフトリミット）を設ける。

### 7.4 GitHub 連携
- 認証は **fine-grained PAT**（対象リポジトリだけに限定し、Contents: Read/Write と Pull requests: Read/Write を付与）から始める。複数人で使うことや細かい権限管理が必要になれば GitHub App に移行する。
- clone 先は WSL の ext4 側（`~/geminicode/workspaces/<session-id>`）にする。`/mnt/c` 配下は I/O が遅いので使わない。
- 1 セッション = 1 ブランチ（`gemini/<短い説明>-<id>`）。PR の作成は REST API（Octokit）で行う。
- 新規セッション画面のリポジトリ選択肢は、PAT で取得できるリポジトリ一覧から作る。

### 7.5 隔離（P3）
- WSL 内に Docker Engine を直接入れる（Docker Desktop は不要）。ワーカーはセッションごとのコンテナ内で `gemini` を ACP モードで起動し、ワークスペースだけをマウントする。
- ゲートウェイとコンテナの間は、`docker exec -i` の stdio に ACP をそのまま流す。

## 8. 実装状況

### P1（実装済み）
- `gateway/`：Node.js + TypeScript（Fastify、jose、`node:sqlite`）。ACP クライアント、セッション管理（アイドル時のプロセス停止と `session/load` による再開）、clone / ブランチ作成 / 差分 / push / PR 作成、Cloudflare Access の JWT 検証、SSE 配信、1 日あたりのトークン上限
- `web/`：React + Vite の PWA。セッション一覧、新規作成、チャット画面（ツールカード、思考の折りたたみ、許可のボトムシート、承認モードの切り替え）、差分ビュー
- `deploy/`：systemd ユニット、env の雛形、`install.sh`、`wsl.conf`、Windows のタスク登録スクリプト
- テスト：偽の ACP エージェントとローカルの bare リポジトリを使った E2E テスト（`npm test`）
- 手順書：[setup.md](setup.md)

### 残り
- P2：セッション一覧の絞り込み、PR のレビューコメントを取り込む機能
- P3：Web Push（承認待ち・完了の通知）、セッションごとのコンテナ隔離、Headless による投げっぱなしモード
