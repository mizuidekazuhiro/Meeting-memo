from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException

from auth import require_bearer_token
from callback_client import send_callback
from dropbox_client import DropboxClient
from logging_utils import configure_logging, get_logger, log_event
from models import TranscriptionJobRequest
from transcription_service import TranscriptionService

configure_logging()
logger = get_logger()
app = FastAPI(title='meeting-memo-python-transcribe-service')
service = TranscriptionService()
dropbox = DropboxClient()


@app.get('/health')
def health() -> dict[str, bool]:
    return {'ok': True}


@app.post('/jobs/transcribe', dependencies=[Depends(require_bearer_token)])
def transcribe_job(job: TranscriptionJobRequest) -> dict[str, object]:
    try:
        source = dropbox.download_file(job.dropboxFileId, job.dropboxPathLower)
        payload = service.process(job, source)
        callback_succeeded = send_callback(payload, callback_url=job.callbackUrl)
        return {
            'ok': True,
            'recordingId': payload.recordingId,
            'status': 'transcribed',
            'callbackSucceeded': callback_succeeded,
        }
    except Exception as exc:  # noqa: BLE001
        log_event(logger, 'error', 'python transcription pipeline failed', recordingId=job.recordingId, error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
