# Meeting-memo

Cloudflare Workers ベースの Meeting-memo です。iPhoneショートカットから音声を **`POST /api/interviews/upload`** に直接送り、Dropbox 保存 → Notion 面談メモ upsert → OpenAI 文字起こし（話者分離あり）→ 要約、までを一気通貫で処理します。

従来の `POST /api/interviews/intake` と `POST /api/interviews/scan` は残していますが、**推奨導線は `/api/interviews/upload`** です。

---

## 推奨導線

1. iPhoneショートカットで録音ファイルを取得する。
2. ショートカットから `POST /api/interviews/upload` に `multipart/form-data` で音声を直接送る。
3. Worker が受信した音声を Dropbox App Folder 内の `DROPBOX_UPLOAD_FOLDER` に保存する。
4. Worker が Dropbox から保存済みファイルを取得する。
5. OpenAI Audio API へ **話者分離つき transcription** を実行する。
   - 24MB 以下ならそのまま送信
   - 24MB 超なら Worker 側で自動分割して順番に送信
6. 分割結果を再結合して 1 つの transcript にまとめる。
7. 要約を生成し、Notion ページを dedup / upsert しつつ本文の Transcript ブロックも更新する。

> Dropbox scan 方式では「ショートカットが置いた場所」と「Workers が App Folder として見えている場所」がズレると失敗しやすいため、direct upload を推奨します。

---

## エンドポイント一覧

### `GET /`
ヘルスチェックです。`200 OK` と `{ "ok": true, "service": "meeting-memo" }` を返します。

### `GET /health`
既存どおりのヘルスチェックです。

### `POST /api/interviews/upload` ← 推奨

iPhoneショートカットからの direct upload 用 endpoint です。`X-Webhook-Secret` が必須です。

- Content-Type: `multipart/form-data`
- 必須フィールド:
  - `file` または `audio`: `audio/*` のファイル本体
- 推奨フィールド:
  - `recordedAt`
  - `languageHint`
  - `participants` (JSON 配列文字列)
  - `notes`
  - `idempotencyKey`
  - `metadata` (JSON オブジェクト文字列)
- 認証ヘッダ:
  - `X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>`

### `POST /api/interviews/intake`
既存の 1 件指定取り込み endpoint です。`X-Webhook-Secret` が必須です。

### `POST /api/interviews/scan`
既存の Dropbox フォルダ探索取り込み endpoint です。`X-Webhook-Secret` が必須です。

### `GET /api/interviews/debug-dropbox`
Dropbox App Folder の root を `path: ""` で列挙する切り分け用 endpoint です。`X-Webhook-Secret` が必須です。

---

## 話者分離あり文字起こし仕様

この Worker は OpenAI Audio API の diarization モデルを前提にしています。

- デフォルト model: `gpt-4o-transcribe-diarize`
- 推奨環境変数: `OPENAI_MODEL_TRANSCRIBE=gpt-4o-transcribe-diarize`
- `response_format`: `diarized_json`
- `chunking_strategy`: `auto`
- `languageHint` があれば OpenAI に渡します

返却された diarization payload は Worker 内で次の形に正規化します。

- `fullText`
- `segments[]`
  - `speaker`
  - `startMs`
  - `endMs`
  - `text`
- `raw`

`fullText` が空のときは `segments` から `[speaker] text` 形式で補完します。

---

## 25MB 超ファイル時の分割戦略

OpenAI 側のサイズ制限を超える音声でも落ちないように、Worker では **24MB を安全上限** として扱います。

### 基本方針

- `24MB 以下`: そのまま 1 回で transcription
- `24MB 超`: 自動分割して chunk 単位で順番に transcription
- chunk の transcript / segments を再結合して、最終的に **1 つの `TranscriptResult`** にまとめる

### 分割の優先順位

1. **fragmented MP4 / M4A を top-level box 単位で分割**
   - `ftyp` / `moov` を初期化セクションとして保持
   - `moof` / `mdat` などの media boxes を 24MB 以内でまとめる
   - 可能な限りコンテナ境界を壊さない方針
2. **通常 MP4 / M4A の `mdat` 再ラップ分割**
   - `ftyp` + `moov` を保持し、`mdat` payload を安全サイズに分割
   - Cloudflare Workers 上で ffmpeg 非依存で実装できる現実的なフォールバック
3. **最終フォールバックとして `Blob.slice()`**
   - MP4/M4A 以外や、コンテナ解析が難しいファイルで使用

### 注意点

- Cloudflare Workers 上では ffmpeg のような本格的なメディア再エンコードを前提にしていません。
- そのため **「まず壊れにくい方法を試し、難しいケースではサイズ優先のフォールバックに落とす」** 実装です。
- 各 chunk の処理では `chunkIndex`, `chunkCount`, `bytes`, `strategy`, `fileName` を Workers Logs に出します。

---

## Notion 反映仕様

Notion には dedup / upsert の既存思想を維持したまま反映します。

- `Source` → `rich_text`
- `Speaker Separation` → `select`
- `Raw JSON` → `rich_text`
- `Transcript` → ページ本文ブロックとして追記 / 更新
- 既存ページ更新時は、管理対象の Transcript ブロック群を置換

Transcript 本文は、segment がある場合は `[speaker] text` 単位で段落化します。

---

## 必要な Cloudflare Workers 環境変数

### Secrets

- `INTERVIEW_WEBHOOK_SECRET`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `OPENAI_API_KEY`
- `DROPBOX_ACCESS_TOKEN`

refresh token 方式を使う場合は、代わりに以下を設定します。

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

### Optional secrets / vars

- `OPENAI_MODEL_TRANSCRIBE`
  - 推奨値: `gpt-4o-transcribe-diarize`
- `OPENAI_MODEL_SUMMARIZE`
  - 既定値: `gpt-4.1-mini`
- `DROPBOX_INTERVIEW_SCAN_FOLDER`
- `DROPBOX_INTERVIEW_SCAN_RECURSIVE`
- `INTERVIEW_SCAN_MAX_FILES`
- `DROPBOX_UPLOAD_FOLDER`
  - 例: `/Apps/MeetingMemo/inbox`
- `APP_ENV`

> GitHub push → Cloudflare Workers deploy 前提で動く構成を維持しています。ローカル CLI 常駐は不要です。

---

## Cloudflare Logs で確認できること

Workers Logs では主に以下のイベント名で追えます。

- `interviews.upload.received`
- `interviews.upload.persist_failed`
- `interviews.upload.processing_failed`
- `interviews.process.processing_failed`
- `interviews.process.notion_failed`
- `openai.transcription.chunk`
- `openai.transcription.failed`
- `openai.summary.failed`
- `worker.http_error`
- `worker.unhandled_error`

### ログの見方

Cloudflare Dashboard の Worker から **Logs** を開き、以下を確認してください。

- どの段階で落ちたか
  - Dropbox 保存
  - OpenAI transcription
  - OpenAI summary
  - Notion upsert
- `details.responseText` が残っているか
- transcription chunk ログの `strategy` と `bytes`
- 失敗した場合の `chunkIndex` / `chunkCount`

OpenAI の失敗時は、レスポンス本文を `responseText` として残す実装にしています。

---

## 想定される失敗パターンと確認方法

### 1. Dropbox 保存で失敗する

確認ポイント:
- `interviews.upload.persist_failed`
- Dropbox 認証情報が不足していないか
- App Folder 配下に書き込み権限があるか

### 2. OpenAI transcription で失敗する

確認ポイント:
- `openai.transcription.failed`
- `responseText` に model / response_format / chunking_strategy の不整合が出ていないか
- `OPENAI_MODEL_TRANSCRIBE` が diarization モデルになっているか
- chunk ログでどの chunk が失敗したか

### 3. 25MB 超ファイルが途中で失敗する

確認ポイント:
- `openai.transcription.chunk`
- `strategy` が `mp4-fragmented`, `mp4-rewrapped`, `blob-slice` のどれになったか
- 特定 chunk の `bytes` が安全上限を超えていないか

### 4. Notion にはページができるが Transcript が本文に出ない

確認ポイント:
- `interviews.process.notion_failed`
- Notion DB の property type が以下と一致しているか
  - `Source`: rich_text
  - `Speaker Separation`: select
  - `Raw JSON`: rich_text
- 既存ページ更新時に Transcript 見出し配下が置換されているか

### 5. dedup により処理されない

確認ポイント:
- upload レスポンスの `action=skipped`
- `dedupCandidates`
- 同じ Dropbox file id / path / idempotencyKey で既存ページが存在しないか

---

## iPhoneショートカット設定例

### 1. 音声ファイルを取得

- 「ファイルを取得」または録音結果を受け取るアクションを使う
- `.m4a` 出力を推奨

### 2. URL を指定

- 例: `https://<your-worker-domain>/api/interviews/upload`

### 3. `URL の内容を取得`

- 方法: `POST`
- 本文: `フォーム`
- ヘッダ:
  - `X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>`

### 4. フォーム項目

- `file`: 音声ファイル本体
- `recordedAt`: 例 `2026-03-22T09:30:00+09:00`
- `languageHint`: `ja`
- `participants`: `[
  "me",
  "customer"
]`
- `notes`: 任意
- `idempotencyKey`: 例 `shortcut-{{現在日時}}-{{ファイルサイズ}}`
- `metadata`: 必要なら JSON で補足メタデータをまとめる

### curl 相当例

```bash
curl -X POST "https://<your-worker-domain>/api/interviews/upload" \
  -H "X-Webhook-Secret: <INTERVIEW_WEBHOOK_SECRET>" \
  -F "file=@./interview-001.m4a;type=audio/mp4" \
  -F "recordedAt=2026-03-22T09:30:00+09:00" \
  -F "languageHint=ja" \
  -F 'participants=["me","customer"]' \
  -F "notes=Weekly follow-up" \
  -F "idempotencyKey=shortcut-2026-03-22T09-30-00-18374652"
```

### 成功時に確認するレスポンス例

```json
{
  "ok": true,
  "action": "processed",
  "reason": "Processed and upserted into Notion.",
  "pageId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "created": true,
  "dropboxFileId": "id:abc123",
  "dropboxPathLower": "/apps/meetingmemo/inbox/interview-001.m4a",
  "storedFileName": "interview-001.m4a",
  "fileSizeBytes": 18374652,
  "dedupCandidates": [
    "dropbox:id:id:abc123",
    "dropbox:path:/apps/meetingmemo/inbox/interview-001.m4a"
  ]
}
```

エラー時は `details` に stage ごとの情報が入り、OpenAI / Dropbox / Notion の切り分けに使えます。

---

## scan 方式との違い

| 項目 | direct upload (`/api/interviews/upload`) | scan (`/api/interviews/scan`) |
| --- | --- | --- |
| 起点 | iPhoneショートカットが Worker に直接送信 | Worker が Dropbox を後から探索 |
| Dropbox 可視性問題 | 起こりにくい | 保存先と App Folder 可視範囲がズレると失敗しやすい |
| メタデータ伝達 | multipart フィールドで一緒に送れる | Dropbox metadata 依存 |
| 大容量音声 | 保存後に Worker 側で自動分割 transcription | scan 対象でも同じ分割ロジックを利用 |
| 推奨度 | **推奨** | 互換用途・再処理用途 |

---

## 動作確認の基本手順

1. GitHub に push して Cloudflare Workers をデプロイする。
2. 必要 secrets / vars が反映されていることを確認する。
3. `/health` で疎通確認する。
4. 10MB 前後の `.m4a` を `/api/interviews/upload` に送って 1 chunk で成功することを確認する。
5. 25MB 超の `.m4a` / `.mp4` を送って chunk ログが出ることを確認する。
6. Notion に以下が反映されることを確認する。
   - ページ作成または既存ページ更新
   - `Source` rich_text
   - `Speaker Separation` select
   - `Raw JSON` rich_text
   - 本文の Transcript ブロック更新
7. Cloudflare Logs で `openai.transcription.chunk` と成功 / 失敗ログを確認する。

---

## 補足

- `/api/interviews/scan` は残しています。
- `/api/interviews/intake` も互換維持のため残しています。
- dedup / upsert の基本思想は維持しています。
- 大きい音声は、Cloudflare Workers 上で現実的に実装できる範囲で安全側に自動分割して処理します。
