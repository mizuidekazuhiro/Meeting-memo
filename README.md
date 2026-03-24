# Meeting-memo

Meeting-memo は、**iPhone ショートカットで選んだ音声ファイルを Cloudflare Workers に送信し、Dropbox に保存し、その後に文字起こし・Notion 保存を行う**リポジトリです。

## 変わらないユーザー操作フロー（最重要）

この導線は変更していません。

1. iPhone ショートカットで音声ファイルを選択
2. ショートカットが Workers の既存 API `POST /api/interviews/upload` を呼ぶ
3. Workers が Dropbox に元ファイルを保存

つまり **Shortcut -> Workers -> Dropbox** はそのままです。

---

## 今回の修正の要点

長時間 `.m4a` の分割・再エンコードは Workers では実行せず、**独立した Python API サービス**に委譲します。

### 新しい後段フロー

1. Shortcut -> Workers -> Dropbox
2. Workers が Dropbox upload 成功レスポンスから metadata を即時記録
3. Workers が recording job を作成（探索待ちしない）
4. 長時間・不明 duration の音声は Python API へ dispatch
5. Python API が Dropbox から直接取得して `ffprobe` / `ffmpeg` で安全分割
6. Python API が `gpt-4o-transcribe-diarize` に順次送信
7. Python API が chunkIndex 順に transcript を結合して Workers callback
8. Workers が Notion 保存し、状態を `transcribed -> persisted` に更新

---

## Dropbox metadata 起点（探索依存しない）

Workers は upload 成功直後に次を確定情報として記録します。

- `dropboxFileId`
- `dropboxPathLower`
- `fileName`
- `size`
- `client_modified`
- `server_modified`

この metadata を主処理の起点にするため、**Dropbox scan が無くても処理対象を確定**できます。

`list_folder` / `list_folder_continue` は補助用途（再同期・復旧・手動再処理・整合確認）のみです。

---

## Workers で禁止していること

長時間 `.m4a` に対して以下は禁止です。

- `mp4-rewrapped`
- byte range split
- container rewrap
- unsafe chunking
- runtime 非対応なのに Workers 内で再エンコード続行

---

## Python API サービス（`python-transcribe-service/`）

FastAPI ベースの独立 API として実装しています（Cloud Run 前提ではありません）。

### 必須エンドポイント

- `POST /jobs/transcribe` : Workers -> Python 起動
- `POST /api/interviews/transcription-callback` : Python -> Workers callback（Workers 側）

### 主な責務

- Dropbox API から対象ファイルを直接ダウンロード
- `ffprobe` で duration / codec / sample rate / channels 取得
- `decode -> trim -> re-encode` で 600〜720 秒の chunk 生成
- chunk validation（bytes / duration / codec/container / 拡張子整合）
- `gpt-4o-transcribe-diarize` へ順次送信
- m4a 失敗時のみ wav fallback を 1 回だけ実施
- transcript を chunkIndex 順で統合して callback

### 依存関係

- FastAPI
- uvicorn
- pydub
- ffmpeg / ffprobe
- openai Python SDK
- httpx

---

## 状態管理

Recording job は最低限この状態を持ちます。

- `uploaded`
- `queued`
- `transcoding`
- `transcribed`
- `persisted`
- `failed`

重複排除は次の優先順です。

1. `dropboxFileId`
2. `recordingId`
3. `dropboxPathLower`（補助）

**`path_lower` 単独の一意判定はしません。**

---

## 設定値一覧

### Workers 側

- `PYTHON_TRANSCRIBE_API_URL`
- `PYTHON_TRANSCRIBE_API_TOKEN`
- `WORKERS_CALLBACK_BASE_URL`
- `DROPBOX_ACCESS_TOKEN` または `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET` + `DROPBOX_REFRESH_TOKEN`
- `OPENAI_API_KEY`
- `NOTION_TOKEN`
- `INBOX_DB_ID`
- `MAX_TRANSCRIBE_DURATION_SEC`
- `TARGET_CHUNK_DURATION_SEC`

### Python API 側

- `PYTHON_TRANSCRIBE_API_TOKEN`
- `DROPBOX_ACCESS_TOKEN` または `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET` + `DROPBOX_REFRESH_TOKEN`
- `OPENAI_API_KEY`
- `WORKERS_CALLBACK_URL`
- `WORKERS_CALLBACK_TOKEN`
- `MAX_TRANSCRIBE_DURATION_SEC`
- `TARGET_CHUNK_DURATION_SEC`
- `PRIMARY_AUDIO_FORMAT`
- `FALLBACK_AUDIO_FORMAT`
- `ENABLE_AUDIO_FALLBACK`
- `FFMPEG_PATH`
- `FFPROBE_PATH`
- `TMP_DIR`

---

## 障害切り分け（長時間音声）

次の順にログを確認してください。

1. Dropbox upload failed
2. Python API dispatch failed
3. source inspection / ffprobe failed
4. ffmpeg chunk generation failed
5. chunk validation failed
6. OpenAI 4xx/5xx
7. callback failed
8. Notion persistence failed

Workers / Python の双方で structured logging（recordingId, fileName, dropboxFileId, dropboxPathLower, details）を出します。

---

## テスト観点

Workers 側と Python 側で次を確認します。

- upload 後に Dropbox metadata から job 作成
- Dropbox 探索なしで処理対象確定
- duration 上限以下は direct path
- 長時間は Python API に委譲
- `mp4-rewrapped` を選ばない
- chunk plan 生成
- invalid chunk を validation で拒否
- m4a 失敗時 wav fallback 1 回
- transcript の chunkIndex 順結合
- callback 後 Notion 保存導線
- dropboxFileId ベース重複防止
- scan/list_folder は補助用途のみ
