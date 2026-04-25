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
9. Workers callback (`/api/interviews/transcription-callback`) は transcript と callback state を保存し、`FINALIZE_QUEUE` に `recordingId` を投入して `202 Accepted` を返す（軽量受信専用）
10. Cloudflare Queue Consumer が重い finalize（summary / 二次レビュー / Notion追記 / My Tasks登録 / メール送信）を実行
11. `/api/interviews/job-status` の `finalizeStatus=completed` を最終完了判定とする（callback成功だけでは完了ではない）

### 二次レビュー機能（重要）

- 使用モデル: `gpt-5.4-mini`（`OPENAI_MODEL_REVIEW`。未設定時は `OPENAI_MODEL_SUMMARIZE`、さらに未設定時は `gpt-5.4-mini`）
- Notion DB プロパティの追加は不要です。既存プロパティ（`Summary` / `My Tasks` / `Other Tasks` / `Raw JSON` / `Error Message`）のみ更新します。
- レビュー結果は Notion の**ページ本文**と完了通知メール本文の両方に出力されます。
- 長い Transcript は Notion 本文へ全文展開せず、Dropbox `.txt` に保存し、Notion には抜粋と全文リンクのみを記録します。
- Web検索結果は補助情報です。低確度/不明は人間確認が必要です。
- `humanCheckRequired=true` の主な条件:
  - 低確度または不明項目が1つでもある
  - 金額 / 株式比率 / 株主間協定 / 会計処理 / 法務論点が含まれる
  - 誤変換が多い
  - Web検索結果と transcript が矛盾する可能性がある
  - 固有名詞補正をしているのに根拠URLが空
- 二次レビューが失敗しても、一次要約 + Transcript 保存 + メール通知は継続します。
- `wrangler.toml` の `[limits]`（`subrequests=50000`, `cpu_ms=300000`）は暫定対策です。根本対策は Notion への大量ブロック書き込み削減です。

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
- `FINALIZE_QUEUE`（Cloudflare Queues producer binding）
- Queue名: `meeting-memo-finalize`
- Dead Letter Queue名: `meeting-memo-finalize-dlq`
- `ALLOW_IN_MEMORY_RECORDING_JOB_STORE`（テスト専用。`true` の時だけ in-memory fallback を許可）
- `CALLBACK_JOB_LOOKUP_MAX_ATTEMPTS`（callback lookup 最大試行回数。既定: `6`）
- `CALLBACK_JOB_LOOKUP_BASE_DELAY_MS`（指数 backoff の基準遅延。既定: `200`）
- `CALLBACK_JOB_LOOKUP_MAX_DELAY_MS`（指数 backoff の最大遅延。既定: `1600`）
- `GMAIL_NOTIFY_ENABLED`（`true` の時だけ通知）
- `INTERVIEW_REVIEW_ENABLED`（未設定は有効。`false` の時のみ二次レビュー無効）
- `INTERVIEW_REVIEW_WEB_SEARCH_ENABLED`（未設定は有効。`false` の時のみWeb検索無効）
- `OPENAI_MODEL_REVIEW`（既定: `gpt-5.4-mini`）
- `NOTION_TRANSCRIPT_EXCERPT_CHARS`（任意。既定: `4000`）
- `TRANSCRIPT_STORAGE_MODE`（任意。`dropbox_txt` 推奨）
- `MAIL_FROM`（送信元 Gmail アドレス）
- `MAIL_PASSWORD`（Google アプリパスワード）
- `MAIL_TO`（通知先。カンマ/セミコロン/改行区切り可）
- `MAIL_CC`（任意）
- `MAIL_BCC`（任意。ヘッダーには出さず RCPT TO のみ）
- `MAIL_SUBJECT_PREFIX`（任意。既定: `Interview Memo 完了`）
- `SMTP_HOST`（任意。既定: `smtp.gmail.com`）
- `SMTP_PORT`（任意。既定: `587`）
- `INBOX_TRIAGE_BASE_URL`（任意。例: `https://notion-inbox-triage.example.com`）
- `INBOX_TRIAGE_ACTION_SECRET`（任意。`notion-inbox-triage` 側の `ACTION_SECRET` と同じ値）
- 旧方式（非推奨 / 互換メモ）: `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN`
- 既存 Dropbox / OpenAI / Notion 関連 env

> `OPENAI_API_KEY` は `wrangler.toml` には書かず、Wrangler Secret / GitHub Secrets で管理してください。

> 重要: 本番/preview/deployed Workers runtime では fallback store を使いません。`RECORDING_JOB_KV` 未設定時は 500 を返します。

## Gmail 完了通知の設定手順

Interview Memo の Notion 保存完了後に、Gmail SMTP（submission: 587 + STARTTLS）で完了通知メールを送る設定です。

Workers に下記 env を設定します。

必須:

- `GMAIL_NOTIFY_ENABLED=true`
- `MAIL_FROM`（送信元 Gmail アドレス）
- `MAIL_PASSWORD`（Google アプリパスワード）
- `MAIL_TO`（送信先メールアドレス）

任意:

- `MAIL_CC`
- `MAIL_BCC`
- `MAIL_SUBJECT_PREFIX=Interview Memo 完了`
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_PORT=587`
- `INBOX_TRIAGE_BASE_URL=https://notion-inbox-triage.example.com`
- `INBOX_TRIAGE_ACTION_SECRET=<same-as-notion-inbox-triage-ACTION_SECRET>`

重要:

- `MAIL_PASSWORD` は Gmail の通常ログインパスワードではなく、Google アカウントの **アプリパスワード** です。
- Google アカウントで 2 段階認証を有効化し、アプリパスワードを発行してください。
- Cloudflare Workers の Variables and Secrets では `MAIL_PASSWORD` を **Secret** として登録してください。
- 旧 Gmail API OAuth 方式の `GMAIL_OAUTH_*` は不要です（非推奨）。

補足:

- 同一 `recordingId` ですでに `notificationSentAt` が保存済みの場合、完了通知メールは再送しません。
- `My Tasks` 取込が失敗しても、Interview Memo 本体が Notion 保存済みならメール送信は継続します（warning ログのみ）。
- `INBOX_TRIAGE_BASE_URL` と `INBOX_TRIAGE_ACTION_SECRET` が設定されている場合、完了通知メールの My Tasks 各項目に `/move/choose` への「タスク処理を選ぶ」ボタンを表示します。

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

## Callback/Finalize 復旧フロー（2026-04 更新）

### 新しい設計

- `/api/interviews/transcription-callback` は **軽量受信専用**（認証・payload検証・job state保存・`FINALIZE_QUEUE`投入・`202 Accepted`返却）
- callback受信では `ctx.waitUntil(finalizeInterviewJob(...))` を起動しない
- callback受信では `/api/interviews/finalize` をHTTPで呼ばない
- Summary / 二次レビュー / Notion反映 / My Tasks登録 / メール送信は Queue Consumer が実行
- callback成功は最終完了ではない
- 最終完了判定は Workers 側 `finalizeStatus=completed`
- 手動復旧API:
  - `POST /api/interviews/finalize` `{ "recordingId": "...", "force": false }`
  - `POST /api/interviews/finalize/enqueue` `{ "recordingId": "...", "force": false }`（推奨）
  - `POST /api/interviews/resend-email` `{ "recordingId": "...", "force": true }`
  - `GET /api/interviews/job-status?recordingId=...`
- Railway(Python) 手動callback再送API:
  - `POST /jobs/{recordingId}/callback/retry`

### ケース1: Railwayでcallback timeoutが出たがNotionには追加されている

確認:
- Workerログに `callback_received`
- `notion_transcript_append_completed`
- `summary_generation_completed`
- `email_send_completed` または `email_send_failed`

対応:
- `POST /api/interviews/finalize` を `recordingId` 指定で実行

### ケース2: NotionにTranscriptはあるがSummaryがない

対応:
- `POST /api/interviews/finalize`
- `summary_generation_failed` ログ確認

### ケース3: Summaryはあるがメールが届かない

対応:
- `email_send_failed` / `email_skipped_missing_config` を確認
- メール環境変数を確認
- `POST /api/interviews/resend-email` を実行

### ケース4: callbackログがCloudflare側に見えない

確認:
- Railway側 callbackUrl
- `INTERVIEW_WEBHOOK_SECRET`
- Worker route
- `/api/interviews/transcription-callback` のデプロイ有無

### ケース5: callback_failed の録音を復旧したい

対応:
- Railway側 `POST /jobs/{recordingId}/callback/retry`
- すでにNotionにTranscriptがある場合は Worker側 `POST /api/interviews/finalize`

### Python callback retry / timeout 設定

- `CALLBACK_CONNECT_TIMEOUT_SEC`（既定: 10秒）
- `CALLBACK_READ_TIMEOUT_SEC`（既定: 60秒）
- callback送信は `0s -> 10s -> 30s -> 60s` の指数バックオフで再試行
- 全失敗時は completed 扱いにせず、`transcribed_callback_failed` 状態で保持

## Cloudflare Queue 作成・デプロイ手順

1. Queue作成（既に存在する場合は再作成不要）
   - `wrangler queues create meeting-memo-finalize`
   - `wrangler queues create meeting-memo-finalize-dlq`
2. `wrangler.toml` に Queue producer / consumer 設定を反映
3. デプロイ
   - `wrangler deploy`
4. 動作確認
   - 録音をアップロード
   - Railwayで `callback_attempt_succeeded` を確認
   - Workersで `finalize_queue_enqueue_succeeded` を確認
   - Workersで `finalize_queue_message_started` を確認
   - Workersで `summary_generation_completed` を確認
   - Workersで `review_completed` を確認
   - Workersで `finalize_completed` を確認
   - `/api/interviews/job-status` で `finalizeStatus: completed` を確認
