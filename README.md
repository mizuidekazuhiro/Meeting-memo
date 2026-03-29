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
4. Workers が duration を判定
   - 短時間: Workers 内で既存処理を継続
   - 長時間 / 安全判定不能: Python API へ委譲
5. Python API が Dropbox から直接取得、`ffprobe` / `ffmpeg` で安全分割
6. Python API が `gpt-4o-transcribe-diarize` へ `chunking_strategy` を指定して chunkIndex 順に送信
7. Python API が transcript を chunkIndex 順で結合して Workers callback
8. Workers が Notion に保存

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
- 既存 Dropbox / OpenAI / Notion 関連 env

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
