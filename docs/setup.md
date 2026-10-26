# セットアップ手順（自宅 Windows + WSL2 + Cloudflare）

完成すると、スマホのブラウザで `https://gemini.<自分のドメイン>` を開くと、Cloudflare のログインを経て GeminiCode の画面が出ます。スマホには何もインストールしません。

```
スマホ ─HTTPS→ Cloudflare（Access で本人確認）─トンネル→ WSL2 の cloudflared → GeminiCode :8080 → gemini --acp
```

所要時間の目安は 1〜2 時間です。上から順に進めてください。

---

## 1. ドメインを取る（Cloudflare Registrar）

1. https://dash.cloudflare.com でアカウントを作る（無料）。
2. 左メニュー **Domain Registration → Register Domains** で好きな名前を検索して購入する。`.com` なら年 10 ドル前後です（`.jp` は扱っていません）。
3. 購入すると、そのドメインは自動で Cloudflare の管理下に入ります。DNS の設定は不要です。

以降、例として `example.com` を使います。GeminiCode は `gemini.example.com` で公開します。

## 2. Cloudflare Zero Trust を有効にする

1. ダッシュボード左メニューの **Zero Trust** を開く。
2. チーム名を決める（例: `myteam`）。これが `myteam.cloudflareaccess.com` になります。後で `CF_ACCESS_TEAM_DOMAIN` に使います。
3. プランは **Free** を選ぶ（50 ユーザーまで無料）。支払い方法の登録を求められることがありますが、Free なら請求は発生しません。

## 3. WSL2 の準備（Windows 側）

PowerShell（管理者）で次を実行します。

```powershell
wsl --install -d Ubuntu      # 既に WSL がある場合は不要
wsl --update
```

Ubuntu を開き、systemd を有効にします。

```bash
sudo tee -a /etc/wsl.conf <<'EOF'
[boot]
systemd=true
EOF
```

PowerShell で `wsl --shutdown` を実行してから、Ubuntu を開き直します。`ps -p 1 -o comm=` の結果が `systemd` なら成功です。

## 4. Node.js・Gemini CLI・git を入れる（WSL 内）

```bash
# Node.js 24 LTS（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Gemini CLI
sudo npm install -g @google/gemini-cli
gemini --version
```

> nvm で入れた Node は systemd から見えません。上の手順のように `/usr/bin/node` に入れてください。

## 5. Gemini の認証方法を決め、GitHub トークンを用意する

**Gemini の認証（どちらか）**
- **Google アカウントでログイン（おすすめ）**: Google AI Pro / Ultra を契約していれば、その利用枠（1 日 1,500 回程度）が使われ、追加料金はかかりません。env に `GEMINICODE_AUTH=google` と書き、手順 9 のあとで `./deploy/login-google.sh` を実行してログインします。
- **API キー**: env に `GEMINICODE_AUTH=api-key` と `GEMINI_API_KEY` を書きます。キーは https://aistudio.google.com/apikey で作成します。Pro 契約の枠はキーには付かず、課金を有効にしていないキーは無料枠（1 日 250 回程度・Flash のみ）です。Gemini CLI は 1 回の指示で何度も API を呼ぶので、すぐ上限に達します。課金を有効にする場合は、Google Cloud コンソールの **お支払い → 予算とアラート** で上限アラートを設定してください。

**GitHub fine-grained personal access token**
1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token。
2. Repository access: **Only select repositories** で、使うリポジトリを選ぶ。
3. Repository permissions:
   - Contents: **Read and write**
   - Pull requests: **Read and write**
   - Metadata: Read（自動で付きます）
4. 有効期限は最長 1 年です。期限が切れたら作り直して env を更新します。

## 6. GeminiCode を入れる（WSL 内）

clone 先は WSL 側のホーム（ext4）にします。`/mnt/c` 配下は遅いので避けてください。

```bash
cd ~
git clone https://github.com/cool0707/GeminiCode.git
cd GeminiCode
./deploy/install.sh          # 1 回目: ビルドして /etc/geminicode/env の雛形を作る
sudo nano /etc/geminicode/env
```

env の項目は `deploy/env.example` のコメントを参照してください。`CF_ACCESS_AUD` は手順 8 で取得するので、いったん空のまま進めて構いません。

## 7. Cloudflare Tunnel を作る

1. Zero Trust → **Networks → Tunnels → Create a tunnel** → **Cloudflared** を選ぶ。
2. 名前（例: `home-wsl`）を付ける。
3. 「Choose your environment」で **Debian**・**64-bit** を選び、表示されるコマンドを WSL で実行する。
   - 上の枠: cloudflared のインストール
   - 下の枠: `sudo cloudflared service install <トークン>`（systemd サービスとして登録されます）
4. トンネルの Overview で Status が **Healthy**、Replicas に自分の PC が出ていれば接続できています。
5. 公開するホスト名を追加する（旧画面の「Public Hostname」は、新しい画面では **Routes** になりました）:
   - トンネルの Overview にある **Add route**（または上部の **Routes** タブ → Add route）を押す。
   - 種類は **Published application** を選ぶ。
   - Hostname: Subdomain `gemini`、Domain `example.com`（ドロップダウンから選ぶ）
   - Service URL: `http://localhost:8080`
6. **Add route** で保存する。`gemini.example.com` の DNS レコードは自動で作られます。

## 8. Cloudflare Access でアクセスを自分だけに絞る

1. Zero Trust → **Access controls → Applications → Add an application → Self-hosted**。
2. Destination（Application domain）: `gemini.example.com`。
3. Policy を追加: Action **Allow**、Include → **Emails** → 自分のメールアドレス。ポリシー側の Session duration は「Same as application session timeout」のままにする（ポリシー側で値を入れると、アプリ側の設定より優先されます）。
4. **Authentication**:
   - Accept all available identity providers: オンのまま。2026 年 6 月以降に作った Zero Trust 組織では、ログイン方法の既定が **Cloudflare**（Cloudflare アカウントでログイン）だけになっています。これで問題ありません。ポリシーのメールアドレスを Cloudflare アカウントのメールアドレスと同じにしてください。Cloudflare アカウントの 2 段階認証も有効にしておくと安心です。
     - メールに届くコードでログインしたい場合は、Zero Trust → **Integrations → Identity providers** で **One-time PIN** を追加します。
   - Apply instant authentication: **オン**（ログイン方法が 1 つだけのとき、ログイン方法の選択画面を飛ばします）。
   - Authenticate with Cloudflare One Client: オフのまま。
5. **Details**: Name は任意（例: `GeminiCode`）、Session Duration は **1 month**（スマホで何度もログインしなくて済むように）。
6. **Create** で保存する。
7. 作成したアプリを開き、**Application Audience (AUD) Tag**（64 文字の英数字）をコピーし、`/etc/geminicode/env` の `CF_ACCESS_AUD` に貼る。
   - 画面上で見つからない場合は、ゲートウェイのログから取得できます。まず `CF_ACCESS_AUD=unknown` のまま手順 9 まで進めて起動し、ブラウザで `https://gemini.example.com` にログインします。画面には `invalid Cloudflare Access token` と出ますが、`journalctl -u geminicode -n 20` に `"aud":["…"]` が記録されているので、その値を `CF_ACCESS_AUD` に入れて `sudo systemctl restart geminicode` します（署名の検証に通ったトークンの値だけを記録するので、そのまま信用して構いません）。`CF_ACCESS_TEAM_DOMAIN` には `myteam.cloudflareaccess.com` を入れる。`ALLOWED_EMAILS` にも同じメールアドレスを入れる。

## 9. サービスを起動する（WSL 内）

```bash
cd ~/GeminiCode
./deploy/install.sh          # 2 回目: systemd に登録して起動
journalctl -u geminicode -f  # ログを見る（Ctrl+C で抜ける）
```

`Server listening at http://127.0.0.1:8080` と出れば OK です。

**Google アカウントでログインする場合（`GEMINICODE_AUTH=google`）**

サービスを動かすユーザー（`root` ではない普段のユーザー）で実行します。

```bash
cd ~/GeminiCode
./deploy/login-google.sh
```

1. 表示される URL を PC のブラウザで開き、Pro を契約している Google アカウントでログインする
2. 画面に出た認証コードを WSL に貼り付けて Enter
3. Gemini CLI の入力欄が出たら `/quit` で終了
4. `sudo systemctl restart geminicode`

ログイン情報は GeminiCode 専用のフォルダに保存され、普段使う `gemini` のログインとは別です。数か月使わなかったり、Google アカウント側でアクセスを取り消したりすると、再ログインが必要になります。そのときは画面のエラーに案内が出るので、同じ手順をやり直してください。

## 10. WSL を止まらないようにする（Windows 側）

WSL は、Windows 側から使われていないと数十秒〜数分で止まります。ログオン時に裏で WSL を動かし続けるタスクを登録します。

```powershell
# リポジトリは WSL 内にあるので、\\wsl$ 経由で実行する
powershell -ExecutionPolicy Bypass -File \\wsl$\Ubuntu\home\<WSLのユーザー名>\GeminiCode\deploy\windows\register-keepalive.ps1
```

あわせて Windows の設定を変えます。

- **設定 → システム → 電源**: 電源接続時に「スリープしない」。
- **設定 → アカウント → サインイン オプション**: 「更新後にサインイン情報を使ってセットアップを自動的に完了する」をオン（Windows Update の再起動後も自動でログオンし、タスクが動くように）。

確認方法: PowerShell で `wsl -l -v` を実行し、Ubuntu が `Running` のままになっていること。

## 11. スマホで開く

1. スマホのブラウザで `https://gemini.example.com` を開く。
2. メールアドレスを入力 → 届いたコードを入力 → GeminiCode の画面が出ます。
3. ホーム画面に追加すると、アプリのように全画面で使えます。
   - iPhone: Safari の共有ボタン → 「ホーム画面に追加」
   - Android: Chrome のメニュー → 「ホーム画面に追加」 / 「アプリをインストール」
   - iPhone では、ホーム画面のアプリは Safari と Cookie が別なので、初回だけもう一度ログインが必要です。

---

## 使い方

- **新規**: リポジトリと指示を入力して「開始」。リポジトリを clone し、`gemini/...` ブランチを作ってから Gemini CLI に指示を渡します。
- **承認モード**（入力欄の左上のボタンで切り替え）
  - 毎回確認: ファイル編集やコマンド実行のたびに、画面下に許可ボタンが出ます。
  - 編集は自動: ファイル編集は自動で許可し、コマンド実行だけ確認します。
  - すべて自動: 確認しません（YOLO）。
  - 計画のみ: 読み取り専用で計画を立てます。
- **モデル**: 新規作成の画面と、入力欄の左上のボタンで選べます。「Auto」は Pro 系を選ぶことが多く、混雑時は応答が遅れます。止まったら停止して Flash 系に切り替え、送り直してください。
- **⋯ メニュー**: 差分を見る / コミットして push / PR を作成 / Gemini CLI を終了 / セッションを削除。
- ブラウザを閉じても処理は続きます。開き直すと、そこまでの経過がすべて表示されます。
- 指示が無いまま 30 分たつと Gemini CLI のプロセスを止めてメモリを空けます。次に指示を送ると、会話を引き継いだ状態で自動的に再開します。

## トラブルシューティング

| 症状 | 確認すること |
|---|---|
| ブラウザに Cloudflare のエラー 1033 / 502 が出る | `systemctl status cloudflared geminicode`。WSL が止まっていないか（`wsl -l -v`） |
| `missing Cloudflare Access token` / `invalid Cloudflare Access token` | env の `CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` が正しいか。Access アプリのドメインがトンネルの Public Hostname と一致しているか |
| `forbidden` | `ALLOWED_EMAILS` にログインしたメールアドレスが入っているか |
| リポジトリ一覧が空 / `GitHub API ... 401` | `GITHUB_TOKEN` の有効期限と、対象リポジトリが選ばれているか |
| `API key not valid` | `GEMINI_API_KEY` |
| 「Google アカウントでのログインが済んでいません」 | `./deploy/login-google.sh` を実行してから `sudo systemctl restart geminicode` |
| 「daily quota」「上限に達しました」 | API キーの無料枠を使い切っています。`GEMINICODE_AUTH=google` に切り替えると Pro 契約の枠が使えます |
| 「リトライしています」と出たまま進まない | Gemini API が混雑（503）または上限（429）です。■ で停止し、入力欄の左上のボタンでモデルを Flash 系に切り替えてから送り直してください。停止して 5 秒たっても終わらないときは、Gemini CLI を終了させて止めます |
| 「考えています…」のまま進まない | `journalctl -u geminicode -n 40` に `[session …] initialized` と `ACP session … ready` が出ているか。出ていなければ、Gemini CLI の起動で止まっています。2 分で時間切れのエラーになり、そのとき Gemini CLI の出力が画面に表示されます |
| セッションがエラーになる | 画面のエラー表示と、`~/.local/share/geminicode/logs/<セッションID>.log`（Gemini CLI の stderr） |

設定を変えたら `sudo systemctl restart geminicode` で反映します。更新は `git pull && ./deploy/install.sh` です。

## Gemini CLI の設定について

GeminiCode から起動する Gemini CLI は、`~/.local/share/geminicode/gemini-home/.gemini/` を設定フォルダとして使います。WSL で対話的に使う `gemini` の `~/.gemini` とは別です。
- 理由: 普段使う設定に何が選ばれていても影響を受けないようにするためです。例えば「Google でログイン」を選んだままログインしていないと、Gemini CLI はブラウザでのログインを待って止まってしまいます。専用フォルダでは、認証方法を env の `GEMINICODE_AUTH` どおりに固定します。
- `~/.gemini/GEMINI.md`（全体のメモリ）や、`~/.gemini` に設定した MCP サーバー・拡張機能は使われません。必要なものは専用フォルダ側に置いてください。リポジトリ内の `GEMINI.md` はこれまでどおり読まれます。

## セキュリティ上の注意

- ゲートウェイは `127.0.0.1` だけで待ち受けます。外からは Cloudflare Tunnel 経由でしか届きません。
- Cloudflare Access に加えて、ゲートウェイ自身も Access の JWT を検証します。
- Gemini CLI のプロセスには `GITHUB_TOKEN` を渡していません。clone と push はゲートウェイが行います。
- ただし Gemini CLI はゲートウェイと同じ Linux ユーザーで動きます。そのため、シェルコマンドを実行できれば、`/proc/<ゲートウェイのPID>/environ` から `GITHUB_TOKEN` や `GEMINI_API_KEY` を読めてしまいます。同じユーザーで読めるファイルも同様です。
  - 「すべて自動」モードは、信頼できるリポジトリと指示のときだけ使ってください。「毎回確認」なら、コマンドは実行前に必ず画面で確認できます。
  - GitHub トークンは対象リポジトリだけに絞っておけば、漏れたときの被害もそのリポジトリに限られます。
  - セッションごとのコンテナ隔離は P3 で対応する予定です。
