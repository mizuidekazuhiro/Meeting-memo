# Python Transcribe Service

Workers から長時間音声処理を委譲される FastAPI サービスです。

## Run

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## Endpoints

- `GET /health`
- `POST /jobs/transcribe` (Bearer `PYTHON_TRANSCRIBE_API_TOKEN`)

## Notes

- Dropbox から直接ファイル取得
- ffprobe / ffmpeg で decode -> trim -> re-encode
- OpenAI `gpt-4o-transcribe-diarize`
- m4a 失敗時のみ wav fallback 1 回
- Workers callback へ統合 transcript を返却
