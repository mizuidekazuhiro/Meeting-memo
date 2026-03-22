# Meeting-memo

Apple Watch / iPhone で録音した面談音声を Dropbox に保存し、Cloudflare Workers から Notion Inbox DB へ取り込むためのリポジトリです。

既存の `POST /api/interviews/intake` による「1件指定取り込み」は維持しつつ、新たに `POST /api/interviews/scan` による「Dropbox の固定フォルダ探索取り込み」を追加しました。以後はショートカット側で毎回 Dropbox file id / path / shared link を渡さなくても、固定フォルダへ保存して scan を叩くだけで未処理ファイルを順次処理できます。

---

## 変更方針の要約

- 既存の `POST /api/interviews/intake` はそのまま残します。
- 新たに `POST /api/interviews/scan` を追加し、Worker が Dropbox フォルダを列挙して未処理ファイルだけを処理します。
- dedup は従来どおり Notion Inbox DB の `Dedup Key` を使います。
- 話者分離文字起こし、要約、`My Tasks` / `Other Tasks` / `ambiguities` 抽出の流れは維持します。
- 共有リンク生成は scan 方式では不要です。

---

## 1. intake 方式と scan 方式

### intake 方式（従来どおり利用可）

`POST /api/interviews/intake` に対して、ショートカットや外部クライアントが Dropbox file id または path を指定して 1 件だけ処理する方式です。

用途:
- 単発ファイルを明示的に取り込みたい場合
- 既存ショートカットをすぐには変えたくない場合

### scan 方式（新方式・推奨）

`POST /api/interviews/scan` が Dropbox 上の固定フォルダを Worker 側で探索し、音声ファイルだけを対象に dedup 判定して、未処理のみ順次処理する方式です。

用途:
- Apple Watch / iPhone で録音後、ショートカットは固定フォルダへ保存するだけにしたい場合
- Dropbox shared link の生成をやめたい場合
- Dropbox file id / path を毎回 webhook に含めたくない場合

### どちらを使うべきか

- 通常運用は **scan 方式を推奨** します。
- 既存連携の互換維持やピンポイント再処理には **intake 方式** を使えます。

---

## 2. 推奨運用

1. Apple Watch / iPhone で録音する。
2. iPhone ショートカットは録音ファイルを Dropbox の固定フォルダに保存する。
3. 保存後に `POST /api/interviews/scan` を叩く。
4. Worker が対象フォルダを列挙し、未処理の音声ファイルだけを順次処理する。
5. Notion Inbox DB に重複なく保存する。

この構成では Dropbox shared link は不要です。

---

## 3. エンドポイント一覧

### `GET /health`
既存どおりのヘルスチェックです。

### `POST /api/interviews/intake`
既存の 1 件指定取り込みです。`X-Webhook-Secret` が必須です。

### `POST /api/interviews/scan`
新しいフォルダ探索取り込みです。`X-Webhook-Secret` が必須です。

- body は省略可能です。
- body 省略時は `DROPBOX_INTERVIEW_SCAN_FOLDER` を使います。
- body 指定時は以下を受け付けます。

```json
{
  "folderPath": "/Apps/MeetingMemo/inbox",
  "limit": 10,
  "recursive": false,
  "dryRun": false
}
```

---

## 4. scan の処理フロー

`POST /api/interviews/scan` では以下の順序で処理します。

1. `X-Webhook-Secret` を検証する。
2. 対象フォルダを決定する。
   - body の `folderPath`
   - なければ `DROPBOX_INTERVIEW_SCAN_FOLDER`
3. Dropbox API の `/files/list_folder` と `/files/list_folder/continue` でフォルダ内を列挙する。
4. フォルダは除外し、ファイルのみ対象にする。
5. 音声拡張子だけを抽出する。
   - `.m4a`, `.mp3`, `.wav`, `.aac`, `.mp4`, `.mpeg`, `.mpga`, `.webm`
   - 大文字小文字は区別しない
6. `server_modified` の **新しい順（降順）** に安定ソートする。
   - 同一時刻の場合は `path_lower`、なければ `name` で昇順比較します。
7. `limit` 件まで処理する。
8. 各ファイルごとに dedup 判定を行う。
9. 未処理ならダウンロード → 話者分離付き文字起こし → 要約 → Notion upsert を行う。
10. 既処理なら skip する。
11. 1 件失敗しても scan 全体は継続する。

---

## 5. dedup の考え方

dedup は既存の `Dedup Key` 方針を維持します。優先順位は以下です。

1. `dropbox:id:<id>`
2. `dropbox:path:<path_lower>`
3. `dropbox:hash:<content_hash>`
4. `dropbox:recorded:<recordedAt>:size:<size>`
5. `client:idempotency:<key>`

注意点:
- `Dropbox File Id` を最優先キーにします。
- `path_lower` は補助キーであり主キーではありません。
- `content_hash` が得られる場合は候補に含めます。
- scan では Dropbox metadata から dedup 候補を作ります。

---

## 6. dryRun

`dryRun: true` の場合、以下のみ実行します。

- Dropbox フォルダ列挙
- 音声ファイル抽出
- dedup 判定

以下は行いません。

- Dropbox ダウンロード
- OpenAI 呼び出し
- Notion create / update

そのため、本番投入前に「どのファイルが処理対象になるか」をレスポンスで確認できます。

---

## 7. 必要な Notion プロパティ

### 必須
- `Name` (title)
- `Source` (select)
- `Interview Date` (date)
- `Summary` (rich_text)
- `My Tasks` (rich_text)
- `Other Tasks` (rich_text)
- `Transcript` プロパティは **不要** です。transcript 本文は Notion ページ本文の block children に保存されます。既存 DB に `Transcript` プロパティが残っていても動作に影響しません。

### 推奨
- `Transcript` プロパティを DB に残す場合は任意です。アプリはこのプロパティを更新せず、本文 block を使います。
- `Dropbox File Id` (rich_text)
- `Dropbox Link` (url)
- `Processing Status` (select)
- `Speaker Separation` (checkbox)
- `Error Message` (rich_text)
- `Record Type` (select)
- `Imported At` (date)
- `Dedup Key` (rich_text)

`ambiguities` の保存先プロパティは既存コード上では **不明** です。現状コードの扱いを維持し、要約 JSON の一部としてのみ保持しています。

### Transcript の保存方式
- transcript は Notion DB の `Transcript` rich_text プロパティには保存しません。
- 代わりにページ本文の先頭へ次の順で block children を保存します。
  1. `heading_2: Transcript`
  2. transcript 本文の `paragraph` blocks
- 話者分離 segment がある場合は各 paragraph block に `[speaker_x] 発話` 形式で格納します。
- segment がない場合のみ `fullText` を段落分割して本文に保存します。
- 長文でも Notion API で失敗しにくいよう、本文は小さめの文字数で複数 block に分割して保存します。
- 既存ページ更新時は、アプリが管理する `Transcript` セクションを一度削除してから再作成するため、同じ transcript が重複追記されません。

---

## 8. 環境変数

### Secrets
- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `OPENAI_API_KEY`
- `DROPBOX_ACCESS_TOKEN`

refresh token 方式を使う場合は以下を利用します。
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

### 新しい scan 用環境変数
- `DROPBOX_INTERVIEW_SCAN_FOLDER`
  - 例: `/Apps/MeetingMemo/inbox`
- `DROPBOX_INTERVIEW_SCAN_RECURSIVE`
  - `true` / `false`
- `INTERVIEW_SCAN_MAX_FILES`
  - 1 回の scan で処理する最大件数

---

## 9. curl 例

### intake 方式

```bash
curl -X POST "https://<your-worker-domain>/api/interviews/intake" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>" \
  -d '{
    "dropboxFileId": "id:abc123def456",
    "dropboxPathLower": "/apps/meeting-recorder/2026-03-22/interview-001.m4a",
    "dropboxSharedLink": "https://www.dropbox.com/scl/fi/...",
    "fileName": "interview-001.m4a",
    "mimeType": "audio/mp4",
    "recordedAt": "2026-03-22T09:30:00+09:00",
    "fileSizeBytes": 18374652,
    "idempotencyKey": "shortcut-2026-03-22T09:30:00+09:00-18374652",
    "source": "Interview",
    "initiatedBy": "iPhone Shortcut",
    "participants": ["me", "customer"],
    "languageHint": "ja",
    "notes": "Weekly follow-up"
  }'
```

### scan 方式（body 省略）

```bash
curl -X POST "https://<your-worker-domain>/api/interviews/scan" \
  -H "X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>"
```

### scan 方式（dryRun）

```bash
curl -X POST "https://<your-worker-domain>/api/interviews/scan" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>" \
  -d '{
    "dryRun": true,
    "limit": 5
  }'
```

### scan 方式（folderPath 指定）

```bash
curl -X POST "https://<your-worker-domain>/api/interviews/scan" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>" \
  -d '{
    "folderPath": "/Apps/MeetingMemo/inbox",
    "recursive": true,
    "limit": 20
  }'
```

---

## 10. scan レスポンス例

```json
{
  "folderPath": "/Apps/MeetingMemo/inbox",
  "scannedCount": 14,
  "audioCandidateCount": 11,
  "processedCount": 3,
  "skippedCount": 7,
  "errorCount": 1,
  "dryRun": false,
  "results": [
    {
      "pathLower": "/apps/meetingmemo/inbox/interview-003.m4a",
      "dropboxFileId": "id:a1",
      "action": "processed",
      "reason": "Processed and upserted into Notion."
    },
    {
      "pathLower": "/apps/meetingmemo/inbox/interview-002.m4a",
      "dropboxFileId": "id:a2",
      "action": "skipped",
      "reason": "Existing Notion page matched by dedup key."
    },
    {
      "pathLower": "/apps/meetingmemo/inbox/interview-001.m4a",
      "dropboxFileId": "id:a3",
      "action": "error",
      "reason": "Transcription request failed."
    }
  ]
}
```

---

## 11. GitHub / Cloudflare 設定

GitHub の `Settings → Secrets and variables → Actions` に以下を追加してください。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `OPENAI_API_KEY`
- `DROPBOX_ACCESS_TOKEN`

refresh token 方式なら代わりに以下も使えます。
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

さらに scan 用の通常環境変数として以下を設定します。
- `DROPBOX_INTERVIEW_SCAN_FOLDER`
- `DROPBOX_INTERVIEW_SCAN_RECURSIVE`
- `INTERVIEW_SCAN_MAX_FILES`

---

## 12. 補足

- 既存の `/api/interviews/intake` は残っています。
- 新しい `/api/interviews/scan` は 1 件失敗しても全体継続します。
- 共有リンク生成は scan 方式では不要です。
- Notion Inbox DB の既存運用は維持します。


---

## 13. GitHub Actions で Worker Secret を自動同期して deploy する

### なぜ GitHub に Secret を入れただけでは Worker に反映されないのか

GitHub Secrets は **GitHub Actions の実行時にだけ参照できる CI 用の保管場所** です。Cloudflare Workers の実行環境は GitHub とは別管理なので、GitHub に secret を保存しただけでは `meeting-memo` Worker の runtime secret には自動反映されません。

そのため、このリポジトリでは `.github/workflows/deploy-worker.yml` で毎回以下を行うようにします。

1. GitHub Secrets を読み込む
2. `wrangler secret bulk` で Cloudflare Worker `meeting-memo` に同期する
3. `wrangler deploy` で Worker を deploy する

この構成により、**main への push だけで secret 同期と deploy が idempotent に再実行** されます。

### 追加される workflow

- ファイル: `.github/workflows/deploy-worker.yml`
- トリガー:
  - `push` to `main`
  - `workflow_dispatch`
- 実行内容:
  1. GitHub Secrets を検証
  2. Cloudflare Workers Secrets を同期
  3. `meeting-memo` Worker を deploy

### GitHub Secrets と Cloudflare Workers Secrets の役割の違い

- **GitHub Secrets**
  - GitHub Actions が workflow 実行中に参照するための秘密情報です。
  - リポジトリに push しても、Cloudflare 側の Worker runtime には自動では入りません。
- **Cloudflare Workers Secrets**
  - 実際に Worker 実行時に `env` から参照される秘密情報です。
  - `INTERVIEW_WEBHOOK_SECRET` や `NOTION_TOKEN` など、Worker 本体が使う値はこちらに存在している必要があります。

### GitHub 側で設定する Secrets

必須:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `OPENAI_API_KEY`

Dropbox 認証は次の **どちらか** を設定してください。

#### A. access token 方式（優先）

- `DROPBOX_ACCESS_TOKEN`

この値が存在する場合、workflow は **access token 方式を優先** して Cloudflare Worker に投入します。

#### B. refresh token 方式

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

`DROPBOX_ACCESS_TOKEN` が空で、上の 3 つがすべて揃っている場合は refresh token 方式で Cloudflare Worker に投入します。

#### 失敗条件

次の場合、workflow は明示的に失敗します。

- `DROPBOX_ACCESS_TOKEN` がない
- かつ `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` が揃っていない

ログには **どの認証方式を使うか** だけを安全に出し、secret 値そのものは出しません。

### 既存 vars はそのまま維持される

`wrangler.toml` にある次の通常変数は deploy 時にそのまま使われます。

- `DROPBOX_INTERVIEW_SCAN_FOLDER="/Apps/MeetingMemo/inbox"`
- `DROPBOX_INTERVIEW_SCAN_RECURSIVE="false"`
- `INTERVIEW_SCAN_MAX_FILES="20"`

`wrangler secret bulk` は secret の同期にのみ使い、`wrangler.toml` の `[vars]` は壊しません。

### 初回設定手順

1. GitHub リポジトリの `Settings → Secrets and variables → Actions` を開く。
2. 上記の GitHub Secrets を登録する。
3. Cloudflare API Token には、対象 account の Workers を更新できる権限を付与する。
4. `main` に push するか、Actions 画面から `Deploy Cloudflare Worker` を手動実行する。
5. workflow が成功すると、GitHub Secrets が Cloudflare Workers Secrets に同期され、その直後に `meeting-memo` が deploy される。

### 手動再実行方法 (`workflow_dispatch`)

1. GitHub の `Actions` タブを開く。
2. `Deploy Cloudflare Worker` workflow を選ぶ。
3. `Run workflow` を押す。
4. 同じブランチの最新コミットに対して、secret 同期と deploy を再実行できる。

secret を更新した直後に反映したい場合も、この手順で再実行できます。

### push to main で何が自動反映されるか

`main` への push ごとに以下が自動で反映されます。

1. GitHub Secrets から Cloudflare Workers Secrets へ値を再同期
2. `meeting-memo` Worker を deploy
3. deploy 済みコードが、同期済み secret と `wrangler.toml` の既存 vars を組み合わせて起動

これにより、`/api/interviews/scan` が Dropbox 認証エラーなく動くために必要な runtime secret を毎回揃えやすくなります。

### 反映確認手順

#### 1. Actions の成功確認

- GitHub Actions の `Deploy Cloudflare Worker` が成功していることを確認する。
- ログでは Dropbox 認証方式として `access_token` または `refresh_token` のどちらで進んだかだけを確認する。

#### 2. Worker URL の確認方法

この repo は `workers_dev = true` なので、通常は以下の URL で確認できます。

- `https://meeting-memo.<your-subdomain>.workers.dev`

Cloudflare ダッシュボードの **Workers & Pages → meeting-memo** でも最終的な公開 URL を確認できます。`wrangler deploy` の完了ログにも deploy 先 URL が表示されます。

#### 3. health check

```bash
curl https://meeting-memo.<your-subdomain>.workers.dev/health
```

#### 4. scan 実行確認

```bash
curl -X POST "https://meeting-memo.<your-subdomain>.workers.dev/api/interviews/scan" \
  -H "X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>"
```

body を省略する場合は、Worker 側に `DROPBOX_INTERVIEW_SCAN_FOLDER` が設定されている必要があります。

### よくある失敗例

#### 1. `INTERVIEW_WEBHOOK_SECRET` 未反映

症状:
- `/api/interviews/intake` または `/api/interviews/scan` で認証エラーになる

確認ポイント:
- GitHub Secret `INTERVIEW_WEBHOOK_SECRET` を登録したか
- `Deploy Cloudflare Worker` workflow が成功したか
- secret 更新後に `main` へ push したか、または `workflow_dispatch` で再実行したか

#### 2. `Dropbox credentials are not fully configured`

症状:
- workflow が secret 同期前に失敗する
- Worker 実行時に Dropbox 認証エラーになる

確認ポイント:
- `DROPBOX_ACCESS_TOKEN` を設定したか
- もしくは `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` を **3 つとも** 設定したか
- refresh token 方式を使うつもりで 1 つでも欠けていないか

#### 3. body 省略時に `DROPBOX_INTERVIEW_SCAN_FOLDER` が必要

症状:
- `POST /api/interviews/scan` を body なしで呼ぶと `folderPath is required when DROPBOX_INTERVIEW_SCAN_FOLDER is not configured.` が返る

確認ポイント:
- `wrangler.toml` の `DROPBOX_INTERVIEW_SCAN_FOLDER` を維持しているか
- 別環境の設定変更で folder を空にしていないか
- body 省略で使いたい既定フォルダが `/Apps/MeetingMemo/inbox` のままでよいか

### セキュリティ上の注意

- workflow では secret 値を `echo` しません。
- `set -x` は使いません。
- 一時 JSON は workflow 内で生成し、`wrangler secret bulk` 実行後に削除します。
- 空文字の secret は Cloudflare に送られません。
- 使わない Dropbox credential は secret payload に入れません。
