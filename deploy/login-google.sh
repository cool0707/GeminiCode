#!/usr/bin/env bash
# GeminiCode が使う Gemini CLI を、Google アカウントでログインさせる（WSL で、サービスと同じユーザーで実行）。
#   ./deploy/login-google.sh
# Google AI Pro / Ultra を契約していれば、その利用枠が使われる。
# ログイン情報は GeminiCode 専用の設定フォルダに保存され、普段使う ~/.gemini には影響しない。
set -euo pipefail

if [ "$(id -u)" = 0 ]; then
  echo "root ではなく、サービスを動かしているユーザー（例: cool0707）で実行してください。" >&2
  exit 1
fi
command -v gemini >/dev/null || { echo "gemini が見つかりません: sudo npm install -g @google/gemini-cli" >&2; exit 1; }

ENV_FILE=/etc/geminicode/env
env_value() { sudo grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }

DATA_DIR="$(env_value GEMINICODE_DATA_DIR)"
DATA_DIR="${DATA_DIR:-$HOME/.local/share/geminicode}"
GEMINI_HOME="$(env_value GEMINICODE_GEMINI_HOME)"
GEMINI_HOME="${GEMINI_HOME:-$DATA_DIR/gemini-home}"

if [ "$(env_value GEMINICODE_AUTH)" != "google" ]; then
  echo "注意: $ENV_FILE に GEMINICODE_AUTH=google がまだありません。ログイン後に追記して、サービスを再起動してください。"
  echo
fi

# Select "Log in with Google" in the private settings (the gateway does the same at startup).
mkdir -p "$GEMINI_HOME/.gemini"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  s.security ??= {}; s.security.auth ??= {};
  s.security.auth.selectedType = "oauth-personal";
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
' "$GEMINI_HOME/.gemini/settings.json"

cat <<'EOF'
Gemini CLI を起動します。
  1. 表示される URL を PC のブラウザで開き、Google アカウントでログインする
  2. 表示された認証コードをこの画面に貼り付けて Enter
  3. Gemini CLI の入力欄が出たらログイン完了。/quit と入力して終了する

EOF

cd "$(mktemp -d)"
# Same storage settings as the gateway uses (see gateway/src/sessions.ts agentEnv).
env -u GEMINI_API_KEY GEMINI_CLI_HOME="$GEMINI_HOME" GEMINI_FORCE_FILE_STORAGE=true NO_BROWSER=true gemini

if [ -f "$GEMINI_HOME/.gemini/gemini-credentials.json" ] || [ -f "$GEMINI_HOME/.gemini/oauth_creds.json" ]; then
  echo
  echo "ログイン情報を保存しました: $GEMINI_HOME/.gemini/"
  echo "反映: sudo systemctl restart geminicode"
else
  echo
  echo "ログイン情報が見つかりません。もう一度実行してください。" >&2
  exit 1
fi
