# python-transcribe-service

このディレクトリは **Meeting-memo と同一レポ内** で運用する Python API です（repo 分離しません）。

## 役割

- Shortcut -> Workers -> Dropbox の導線はそのまま
- Workers が Dropbox 保存成功 metadata を起点に処理
- 長時間音声（または Workers 側で安全判定できない音声）だけをこの API に委譲
- 本サービスが Dropbox 直接取得 / ffprobe / ffmpeg chunking / OpenAI diarized transcription を担当
- 文字起こし結果を Workers callback へ返却

## エンドポイント

- `GET /health` -> `{"ok": true}`
- `POST /jobs/transcribe` (Bearer 認証)

`POST /jobs/transcribe` 必須項目:
- `recordingId`
- `dropboxFileId` または `dropboxPathLower` のどちらか

## ローカル起動

```bash
cd python-transcribe-service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## 必須環境変数

- `API_TOKEN`
- `OPENAI_API_KEY`
- `DROPBOX_ACCESS_TOKEN` **または** `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET`
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

## 実装ポリシー

- `dropboxFileId` 優先、`dropboxPathLower` は fallback
- mp4 rewrap / byte split / unsafe chunking は禁止
- `decode -> trim -> re-encode`（m4a = AAC-LC、fallback 1回のみ wav）
- OpenAI model は `gpt-4o-transcribe-diarize` 固定
- chunkIndex 順に transcript を merge
- callback 失敗はログ化するが、transcription 本体成功は失敗扱いにしない（`callbackSucceeded` で返す）

## よくある失敗

- Python API URL 未設定（Workers 側）
- token 不一致
- ffmpeg / ffprobe not found
- Dropbox auth failed
- OpenAI auth failed
