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

### `GET /`
簡単なヘルスチェックです。`200 OK` と `{ "ok": true, "service": "meeting-memo" }` を返します。

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

### `GET /api/interviews/debug-dropbox`
Dropbox App Folder の root を `path: ""` で列挙する切り分け用 endpoint です。`X-Webhook-Secret` が必須です。scan 系と同じ Dropbox 認証解決ロジックを使うため、access token 方式・refresh token 方式のどちらでも動作します。

---

## 4. scan の処理フロー

`POST /api/interviews/scan` では以下の順序で処理します。

1. `X-Webhook-Secret` を検証する。
2. 対象フォルダを決定する。
   - body の `folderPath`
   - なければ `DROPBOX_INTERVIEW_SCAN_FOLDER`
3. Dropbox API の `/files/list_folder` と `/files/list_folder/continue` でフォルダ内を列挙する。
   - `folderPath` に迷ったら、先に `GET /api/interviews/debug-dropbox` で App Folder 直下の実フォルダ名を確認できます。
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

> **重要:** Cloudflare Workers Secrets に入るキー名と、Worker コードが `env` から参照する名前は**完全一致**している必要があります。このリポジトリでは refresh token 方式の env 名を `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` に統一しています。

`POST /api/interviews/scan` と `GET /api/interviews/debug-dropbox` はどちらも同じ認証解決ロジックを使います。そのため、refresh token 方式だけを設定した構成でも debug endpoint をそのまま利用できます。

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

### debug-dropbox 方式

`GET /api/interviews/debug-dropbox` は、scan 系と同じ Dropbox 認証解決ロジックを使って Dropbox App Folder 直下の一覧を確認するための切り分け用 endpoint です。`DROPBOX_ACCESS_TOKEN` があれば `access_token`、なければ `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` の 3 点セットから `refresh_token` を解決して実行します。`folderPath` の解釈で迷った場合は、まずこの endpoint で `entries[].name` / `entries[].path_lower` を確認してください。不要になれば後で削除して構いません。

```bash
curl "https://<your-worker-domain>/api/interviews/debug-dropbox" \
  -H "X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>"
```

成功時は Dropbox の `/2/files/list_folder` (`path: ""`, `recursive: false`, `limit: 20`) を呼び、レスポンスに `authMode` (`access_token` または `refresh_token`) を含めて返します。失敗時は、どの認証方式を解決しようとして失敗したか分かるよう `details.attemptedAuthMode` などを返します。

---

## 10. debug-dropbox レスポンス例

```json
{
  "ok": true,
  "path": "",
  "authMode": "refresh_token",
  "entries": [
    {
      ".tag": "folder",
      "name": "inbox",
      "path_lower": "/inbox"
    }
  ],
  "cursor": "...",
  "has_more": false
}
```

エラー時の例:

```json
{
  "ok": false,
  "message": "Dropbox API call failed for /files/list_folder.",
  "status": 409,
  "details": {
    "attemptedAuthMode": "refresh_token",
    "responseBody": "Dropbox から返った本文"
  }
}
```

## 11. scan レスポンス例

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

## 12. GitHub / Cloudflare 設定

GitHub の `Settings → Secrets and variables → Actions` に以下を追加してください。

### Cloudflare 認証用
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

### アプリ用 secrets
- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `OPENAI_API_KEY`

Dropbox 認証は次の **どちらか一方** を設定します。

#### A. access token 方式
- `DROPBOX_ACCESS_TOKEN`

#### B. refresh token 方式
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

### 通常変数 (`wrangler.toml` 管理)
以下は GitHub Secrets ではなく `wrangler.toml` の `[vars]` で管理しています。

- `DROPBOX_INTERVIEW_SCAN_FOLDER`
- `DROPBOX_INTERVIEW_SCAN_RECURSIVE`
- `INTERVIEW_SCAN_MAX_FILES`

> Cloudflare Dashboard で Worker secret を手動登録・手動更新する必要はありません。GitHub Secrets と GitHub Actions のみで `meeting-memo` に反映する前提です。

---

## 13. 補足

- 既存の `/api/interviews/intake` は残っています。
- 新しい `/api/interviews/scan` は 1 件失敗しても全体継続します。
- 共有リンク生成は scan 方式では不要です。
- Notion Inbox DB の既存運用は維持します。

---

## 14. GitHub Actions で Worker deploy と secrets 反映を完結させる

### 変更後の workflow 構成

このリポジトリでは Cloudflare Dashboard 手動操作を前提にせず、以下 2 本の workflow で完結させます。

- `.github/workflows/deploy-worker.yml`
  - `push` to `main`
  - `workflow_dispatch`
  - 役割: `meeting-memo` の Worker コードを `wrangler deploy` で deploy し、その後 secrets 同期 workflow を呼び出す
- `.github/workflows/sync-worker-secrets.yml`
  - `workflow_dispatch`
  - `workflow_call`
  - 役割: GitHub Secrets から Cloudflare Workers secrets 用の新しい **version** を作成し、その version を本番 deployment として有効化する

### なぜ `wrangler secret bulk` をやめたのか

Cloudflare Workers の Versions / Deployments モデルでは、`wrangler secret bulk` は secret 更新を伴う即時反映を行います。一方で、Worker 側が versioned deploy 状態にあり、**最新 version がまだ active deployment ではない** タイミングだと、Cloudflare API が script settings の変更とみなして `code: 10214` を返すことがあります。

失敗例:

- `Script edit failed. You attempted to deploy the latest version with modified settings, but the latest version isn't currently deployed. [code: 10214]`

そのため、このリポジトリでは secret 反映を次の version-aware 手順へ変更しました。

### 新しい secrets 反映手順

1. `wrangler deployments status --name meeting-memo --json`
   - 現在の active deployment を確認
2. `wrangler versions list --name meeting-memo --json`
   - secret 同期前の version 一覧を保存
3. `wrangler versions secret bulk --name meeting-memo <payload>`
   - GitHub Secrets から secret を使った **新しい Worker version** を作成
   - ここではまだ deployment を直接いじりません
4. `wrangler versions list --name meeting-memo --json`
   - 新しく作られた version ID を特定
5. `wrangler versions deploy <version-id>@100% --name meeting-memo --yes`
   - secret を含む最新 version を active deployment に切り替え
6. `wrangler deployments status --name meeting-memo --json`
   - 反映後の deployment を確認

この方式では、`latest version isn't currently deployed` の状態で古い deployment に対して設定差分を当てにいかないため、`code 10214` を回避しやすくなります。

### deploy と secrets の実行順序

`Deploy meeting-memo worker` workflow 実行時の順序は次のとおりです。

1. `wrangler deploy --name meeting-memo`
   - Worker コードを deploy
2. `wrangler deployments status --name meeting-memo --json`
   - 最新 deployment を確認
3. `Sync meeting-memo worker secrets` workflow を呼び出し
4. `wrangler versions secret bulk --name meeting-memo ...`
   - secrets を含む新 version を作成
5. `wrangler versions deploy <new-version-id>@100% --name meeting-memo --yes`
   - secrets を含む最新 version を有効化

つまり最終的な本番反映順は **deploy → version 作成 → version 有効化** です。Cloudflare の versioned deploy 制約に合わせて、secret 更新も version として扱うのがポイントです。

### GitHub Secrets の検証ルール

必須:

- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `OPENAI_API_KEY`

Dropbox 認証は以下のどちらかが必要です。

- `DROPBOX_ACCESS_TOKEN`
- または `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` の 3 点セット

`DROPBOX_ACCESS_TOKEN` が存在する場合は access token 方式を優先し、なければ refresh token 方式を使います。どちらも満たさない場合、workflow は Cloudflare API 呼び出し前に失敗します。

### 初回セットアップ手順

1. GitHub リポジトリの `Settings → Secrets and variables → Actions` を開く。
2. 上記の GitHub Secrets を登録する。
3. `CLOUDFLARE_API_TOKEN` に `meeting-memo` を更新できる権限を付与する。
4. `Actions` タブから **Deploy meeting-memo worker** を実行する。
5. workflow 成功後、Worker コード deploy と Worker secrets 反映の両方が GitHub 上だけで完了する。

> 初回セットアップから更新まで、Cloudflare Dashboard で secret を手動登録する必要はありません。

### secret だけ再反映したい場合

GitHub Secrets の値だけを更新した場合は、`Actions` タブから **Sync meeting-memo worker secrets** を実行してください。

この workflow は以下を行います。

1. 現在の deployment 状態を表示
2. secret 同期前後の versions を比較
3. secret を含む新 version を作成
4. その version を 100% traffic に deploy
5. 反映後の deployment 状態を表示

### ログ改善について

失敗時にどの API 呼び出しで落ちたか分かるよう、workflow ログに Cloudflare API 操作の区切りを明示しています。

- `[Cloudflare API] DEPLOY worker code with wrangler deploy`
- `[Cloudflare API] GET deployment status after code deploy`
- `[Cloudflare API] LIST versions before uploading secrets`
- `[Cloudflare API] CREATE version with secrets via wrangler versions secret bulk`
- `[Cloudflare API] DEPLOY secret version to 100% traffic`
- `[Cloudflare API] GET deployment status after secret activation`

そのため、`deploy`・`versions secret bulk`・`versions deploy` のどこで失敗したかを GitHub Actions 上で追いやすくなります。

### 手動再実行方法 (`workflow_dispatch`)

#### コード + secrets をまとめて反映する場合

1. GitHub の `Actions` タブを開く。
2. `Deploy meeting-memo worker` を選ぶ。
3. `Run workflow` を押す。

#### secrets のみ再反映する場合

1. GitHub の `Actions` タブを開く。
2. `Sync meeting-memo worker secrets` を選ぶ。
3. `Run workflow` を押す。

### 反映確認手順

#### 1. Actions の成功確認

- `Deploy meeting-memo worker` または `Sync meeting-memo worker secrets` が成功していることを確認する。
- ログでは Dropbox 認証方式として `access_token` または `refresh_token` のどちらで進んだかだけを確認する。
- `versions deploy` 完了後の `deployments status` で、secret 反映後 version が active になっていることを確認する。

#### 2. Worker URL の確認方法

この repo は `workers_dev = true` なので、通常は以下の URL で確認できます。

- `https://meeting-memo.<your-subdomain>.workers.dev`

`wrangler deploy` の完了ログにも deploy 先 URL が表示されます。

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

#### 1. `Dropbox credentials are not fully configured`

症状:
- workflow が secret version 作成前に失敗する
- Worker 実行時に Dropbox 認証エラーになる

確認ポイント:
- `DROPBOX_ACCESS_TOKEN` を設定したか
- もしくは `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` を **3 つとも** 設定したか
- Worker が読む env 名と Cloudflare Secret 名が完全一致しているか（本リポジトリでは `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` を使用し、`DROPBOX_CLIENT_ID` / `DROPBOX_CLIENT_SECRET` は使用しません）

#### 2. `code: 10214`

症状:
- 旧 workflow の `wrangler secret bulk --name meeting-memo ...` で失敗する

対応:
- このリポジトリでは `wrangler secret bulk` をやめ、`wrangler versions secret bulk` → `wrangler versions deploy` へ切り替えています。
- もし古い run が残っている場合は、**Sync meeting-memo worker secrets** または **Deploy meeting-memo worker** を再実行してください。

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
- 一時ファイルは workflow 実行中のみ使用します。
- 空文字の secret は Cloudflare に送られません。
- 使わない Dropbox credential は secret payload に入れません。
