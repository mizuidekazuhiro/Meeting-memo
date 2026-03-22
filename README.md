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
