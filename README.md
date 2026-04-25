# Meeting-memo

Meeting-memo は **同一レポ（monorepo）運用のまま**、
**Shortcut -> Workers -> Dropbox** を維持して動かす構成です。

## このリポジトリで維持する設計（重要）

- レポは分離しない（Workers と Python API を同一レポで管理）
- ユーザー導線は変更しない（Shortcut -> Workers -> Dropbox）
- 主処理起点は Dropbox 保存成功時 metadata（scan 依存にしない）
- 長時間 `.m4a` を Workers で unsafe chunking しない
- mp4-rewrapped を使わない
- 後段 Python サービスが `ffprobe` / `ffmpeg` / OpenAI diarized transcription を担当
- Workers は callback を受けて Notion 保存

---

## 現在のエラーと原因

エラー:

`Python transcribe API URL is not configured.`

原因:

- Workers 側 `PYTHON_TRANSCRIBE_API_URL` が未設定
- または Python API 実体が未起動 / 未デプロイ

本リポジトリではエラーメッセージを次に統一しています。

`Python transcribe API URL is not configured. Set PYTHON_TRANSCRIBE_API_URL to the base URL of the Python service, for example https://your-service.example.com`

> `PYTHON_TRANSCRIBE_API_URL` は **ベースURL**（例: `https://your-service.example.com`）を設定します。Workers 側が `/jobs/transcribe` を付与します。

---

## 全体フロー

1. Shortcut が `POST /api/interviews/upload` を呼ぶ
2. Workers が Dropbox に保存
3. Dropbox upload 成功 metadata（`dropboxFileId`, `dropboxPathLower`, `fileName`, `size` など）で recording job を作成
4. `POST /api/interviews/upload` は受付専用で **202 Accepted (`action: queued`)** を即時返却（文字起こし完了は意味しない）
5. iPhone アップロード経由の文字起こしは duration に関係なく Python API（Railway Python service）へ委譲
6. Python API が Dropbox から直接取得、`ffprobe` / `ffmpeg` で安全分割
7. Python API が `gpt-4o-transcribe-diarize` へ `chunking_strategy` を指定して chunkIndex 順に送信
8. Python API が transcript を chunkIndex 順で結合して Workers callback
9. Workers が transcript 完了後に要約（summary / tasks）を生成
10. Workers が Notion に保存（Interview Memo 本体。`Record Type=Interview Memo`）
11. Workers が `My Tasks` のみを同一 DB（`INBOX_DB_ID`）へ 1件ずつ追加（`Record Type=Task`）
12. Workers が Gmail API（OAuth refresh token）で完了通知メール送信

### Notion My Tasks の任意プロパティ（別ページ化する場合）

`My Tasks` を Interview Memo 本体と別ページで管理する場合、以下の追加プロパティがあると関連付けに便利です（任意）。

- `Source Recording ID`: `rich_text`
- `Source Interview Page ID`: `rich_text`
- `Source Interview URL`: `url`

### iPhone Shortcut 側の成功判定

- `/api/interviews/upload` の `action: queued` は成功扱いにしてください
- upload レスポンスは「受付完了」であり、文字起こし完了ではありません
- 文字起こし完了は Notion ページ作成または通知メールで確認します

### 重複防止ポリシー

- 同一録音判定キー: `recordingId` / `dropboxFileId` / `dropboxPathLower`
- 既存 job が `queued` / `transcoding` / `transcribing` / `transcribed` / `persisted` の場合は再処理しない
- `failed` のみ再実行を許可
- upload / callback の両経路で重複反映を防ぐ（skip reason をログ出力）
- task dedupe key: `meeting-task:${recordingId}:${sha256(normalizedTaskText)}`
- completion email は `notificationSentAt` を job に保存し、同一 recordingId で再送しない

---

## Python API（同一レポ内）

実体は `python-transcribe-service/` 配下です。

- `GET /health`
- `POST /jobs/transcribe`（Bearer token 対応）

`POST /jobs/transcribe` 必須:

- `recordingId`
- `dropboxFileId` または `dropboxPathLower` の少なくとも片方

---

## セットアップ手順（初心者向け）

1. **python-transcribe-service を起動**
   - `cd python-transcribe-service`
   - `cp .env.example .env`
   - 必須 env を埋める（OpenAI / Dropbox / callback / token）
   - `uvicorn main:app --host 0.0.0.0 --port 8000`
2. **公開 URL を取得**（Cloud Run / Railway / Fly.io / ngrok など）
3. **Workers に `PYTHON_TRANSCRIBE_API_URL` を設定**
   - 例: `https://your-service.example.com`
4. 必要なら **Workers に `PYTHON_TRANSCRIBE_API_TOKEN` を設定**
5. Python 側 `API_TOKEN` と Workers 側 `PYTHON_TRANSCRIBE_API_TOKEN` を一致させる

---

## 環境変数

### Workers 側

- `PYTHON_TRANSCRIBE_API_URL`（ベースURL）
- `PYTHON_TRANSCRIBE_API_TOKEN`
- `RECORDING_JOB_KV`（**本番必須**。recording job 永続化用 KV バインディング）
- `ALLOW_IN_MEMORY_RECORDING_JOB_STORE`（テスト専用。`true` の時だけ in-memory fallback を許可）
- `CALLBACK_JOB_LOOKUP_MAX_ATTEMPTS`（callback lookup 最大試行回数。既定: `6`）
- `CALLBACK_JOB_LOOKUP_BASE_DELAY_MS`（指数 backoff の基準遅延。既定: `200`）
- `CALLBACK_JOB_LOOKUP_MAX_DELAY_MS`（指数 backoff の最大遅延。既定: `1600`）
- `GMAIL_NOTIFY_ENABLED`（`true` の時だけ通知）
- `GMAIL_TO`
- `GMAIL_FROM`
- `GMAIL_OAUTH_CLIENT_ID`
- `GMAIL_OAUTH_CLIENT_SECRET`
- `GMAIL_OAUTH_REFRESH_TOKEN`
- 既存 Dropbox / OpenAI / Notion 関連 env

> 重要: 本番/preview/deployed Workers runtime では fallback store を使いません。`RECORDING_JOB_KV` 未設定時は 500 を返します。

## Recording callback の lookup 仕様

- job 保存は `recordingId` を主キーに KV 永続化
- secondary index:
  - `dropboxFileId -> recordingId`
  - `dropboxPathLower -> recordingId`（trim + lower-case 正規化）
- callback lookup 順序:
  1. `recordingId`
  2. `dropboxFileId`
  3. `dropboxPathLower`
- callback lookup は bounded retry（既定6回, short backoff）を実装し、KV 即時可視化不足に耐える設計

全 retry 後も lookup miss の場合のみ `Recording job not found for callback.` を返し、
`attempts` / `totalWaitMs` / lookup key 群を 404 details とログへ出力します。

### Python API 側

- `API_TOKEN`
- `OPENAI_API_KEY`
- `DROPBOX_ACCESS_TOKEN`
- `DROPBOX_REFRESH_TOKEN`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `WORKERS_CALLBACK_URL`
- `WORKERS_CALLBACK_TOKEN`
- `TARGET_CHUNK_DURATION_SEC`
- `MAX_TRANSCRIBE_DURATION_SEC`
- `PRIMARY_AUDIO_FORMAT`
- `FALLBACK_AUDIO_FORMAT`
- `ENABLE_AUDIO_FALLBACK`
- `FFMPEG_PATH`
- `FFPROBE_PATH`
- `TMP_DIR`
- `DIARIZATION_CHUNKING_STRATEGY`（diarization transcription 呼び出し時に必須）

---

## ffmpeg / ffprobe について

Python API 実行環境には `ffmpeg` と `ffprobe` が必要です。

- 見つからない場合: `ffmpeg not found` / `ffprobe not found`
- PATH が異なる場合は `FFMPEG_PATH` / `FFPROBE_PATH` を明示

---

## よくある失敗

- Python API URL 未設定
- token 不一致
- ffmpeg not found
- Dropbox auth failed
- OpenAI auth failed

---

## テスト観点

- Workers:
  - `PYTHON_TRANSCRIBE_API_URL` 未設定時のエラーが明確
- Python API:
  - `/health`
  - auth
  - chunk plan
  - merge order
