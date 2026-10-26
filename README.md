# GeminiCode

[Gemini CLI](https://github.com/google-gemini/gemini-cli) を、スマホのブラウザから Claude アプリの Code（claude.ai/code）のような使い心地で使うための Web アプリです。自宅 PC（Windows + WSL2）で動かし、Cloudflare Tunnel と Cloudflare Access 経由でスマホから使います。

- チャット形式の画面。ツール実行はカードで表示し、タップで中身を展開します
- ファイル編集やコマンド実行の許可をボタンで出せます（ACP の `session/request_permission`）
- ブラウザを閉じても処理は続きます。開き直すと経過がすべて再生されます
- セッションごとに GitHub リポジトリを clone し、専用ブランチを作ります。差分の確認、push、PR 作成まで画面から行えます

## 構成

```
web/       スマホ向け PWA（React + Vite）
gateway/   ゲートウェイ（Node.js + Fastify）: gemini --acp の起動と仲介、イベントログ（SQLite）、Git/GitHub 連携、Cloudflare Access の検証
deploy/    systemd ユニット、env の雛形、インストールスクリプト、Windows のタスク登録スクリプト
docs/      設計メモとセットアップ手順
```

## セットアップ

[docs/setup.md](docs/setup.md) を参照してください。設計の検討経緯は [docs/design.md](docs/design.md) にあります。

## 開発

```bash
npm install
npm run build
npm test                      # ゲートウェイの E2E テスト（偽の ACP エージェントとローカルの bare リポジトリを使う）

# ローカルで動かす（認証なし。外部公開しないこと）
GEMINICODE_INSECURE_NO_AUTH=1 GEMINI_API_KEY=... GITHUB_TOKEN=... npm start
npm run dev -w web            # 別ターミナルで。Vite の開発サーバーが /api を :8080 に転送する
```

必要環境: Node.js 22.13 以上（推奨 24 LTS。`node:sqlite` を使うため）、git、Gemini CLI 0.65 以上（`--acp` フラグ）。
