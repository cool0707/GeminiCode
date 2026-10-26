#!/usr/bin/env bash
# GeminiCode をビルドし、systemd サービスとして登録する。WSL の Ubuntu で実行する。
#   ./deploy/install.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$USER}"

if [ "$(ps -p 1 -o comm=)" != "systemd" ]; then
  echo "systemd が有効になっていません。deploy/wsl.conf を /etc/wsl.conf に追記し、wsl --shutdown してください。" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22.13 以上が必要です（推奨: 24 LTS）。docs/setup.md の手順でインストールしてください。" >&2
  exit 1
fi
command -v gemini >/dev/null || { echo "gemini が見つかりません: sudo npm install -g @google/gemini-cli" >&2; exit 1; }

echo "==> ビルド"
cd "$REPO"
npm ci
npm run build

echo "==> 設定ファイル"
if [ ! -f /etc/geminicode/env ]; then
  sudo install -d -m 755 /etc/geminicode
  sudo install -m 600 deploy/env.example /etc/geminicode/env
  echo "/etc/geminicode/env を作成しました。値を入れてから再度このスクリプトを実行してください:"
  echo "  sudo nano /etc/geminicode/env"
  exit 0
fi

echo "==> systemd サービス"
sed -e "s#__USER__#${USER_NAME}#" -e "s#__REPO__#${REPO}#" deploy/geminicode.service |
  sudo tee /etc/systemd/system/geminicode.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable geminicode
sudo systemctl restart geminicode
sleep 2
systemctl --no-pager --lines=5 status geminicode || true
echo
echo "完了。ログ: journalctl -u geminicode -f"
