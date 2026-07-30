# python-transcribe-service

このディレクトリは **Meeting-memo と同一レポ内** で運用する Python API です（repo 分離しません）。

## 役割

- Shortcut -> Workers -> Dropbox の導線はそのまま
- Workers が Dropbox 保存成功 metadata を起点に処理
- 長時間音声（または Workers 側で安全判定できない音声）だけをこの API に委譲
- 本サービスが Dropbox 直接取得 / ffprobe / ffmpeg chunking / OpenAI transcription を担当（通常運用は話者分離OFF）
- 文字起こし結果を Workers callback へ返却（このサービスは finalize 完了まで待たない）

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
- `TRANSCRIBE_DIARIZATION_ENABLED`（既定: `false`）
- `TRANSCRIBE_LANGUAGE`（既定: `ja`）
- `FFMPEG_PATH`
- `FFPROBE_PATH`
- `TMP_DIR`
- `DIARIZATION_CHUNKING_STRATEGY`（diarization transcription 呼び出し時に必須）

## 実装ポリシー

- `dropboxFileId` 優先、`dropboxPathLower` は fallback
- mp4 rewrap / byte split / unsafe chunking は禁止
- `decode -> trim -> re-encode`（m4a = AAC-LC、fallback 1回のみ wav）
- 通常運用は `TRANSCRIBE_DIARIZATION_ENABLED=false` で `gpt-4o-transcribe` + `language=ja` + 日本語会議向けpromptを使用
- 話者分離が必要な場合のみ `TRANSCRIBE_DIARIZATION_ENABLED=true` で `gpt-4o-transcribe-diarize` + `response_format=diarized_json` を使用
- 言語は `request.languageHint`（`ja` / `en` / `auto`）を最優先し、未指定または不正値時は `TRANSCRIBE_LANGUAGE`、それも不正/未設定なら `ja` にフォールバック
- 明示的な `request.languageHint=auto` は `TRANSCRIBE_LANGUAGE=ja` より優先し、OpenAIの `language` パラメータを省略する
- AutoではEnglish、Indian English、Hindi、日本語名を含み得る混在言語promptを使い、実際に話された言語を維持する
- 既定のchunk長は300秒。24 MB上限も単一chunkを返す前に判定する
- M4A＋指定言語の品質が不十分ならWAV＋Autoで1回だけ再試行する
- WAV再試行後も反復過多ならcallbackせず失敗し、低密度だけなら無音候補chunkとして除外する
- diarization model 呼び出し時のみ `chunking_strategy` が必須（`DIARIZATION_CHUNKING_STRATEGY`）
- OpenAI SDK 側で `Unexpected audio response format: diarized_json` warning が出ても、normalize 層で返却型差分を吸収して処理継続
- chunkIndex 順に transcript を merge
- callback 失敗はログ化するが、transcription 本体成功は失敗扱いにしない（`callbackSucceeded` で返す）
- callback 成功後の最終化は Cloudflare Queues 上で Workers が処理するため、Python 側 `overallStatus` は `callback_delivered_finalize_*` で管理する
- `/jobs/transcribe` はバックグラウンド実行だが、ジョブ内部は同期パイプラインのため長時間音声では完了まで時間がかかる
- chunk 単位（chunkIndex / ffprobe metadata / OpenAI request-response要約）の構造化ログで原因追跡できる

## よくある失敗

- Python API URL 未設定（Workers 側）
- token 不一致
- ffmpeg / ffprobe not found
- Dropbox auth failed
- OpenAI auth failed
