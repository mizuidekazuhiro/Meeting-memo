from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException

from auth import require_bearer_token
from callback_client import send_callback
from dropbox_client import DropboxClient
from logging_utils import configure_logging, get_logger, log_event
from models import TranscriptionJobRequest
from transcription_service import TranscriptionProcessingError, TranscriptionService

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
    except TranscriptionProcessingError as exc:
        status_code = 500
        if exc.source in {'openai', 'dropbox'}:
            status_code = 502
        elif exc.source == 'validation':
            status_code = 400

        log_event(
            logger,
            'error',
            'python transcription pipeline failed',
            recordingId=job.recordingId,
            error=str(exc),
            errorSource=exc.source,
            chunkIndex=exc.chunk_index,
            upstreamStatus=exc.external_status_code,
            context=exc.context,
        )
        raise HTTPException(
            status_code=status_code,
            detail={
                'message': str(exc),
                'source': exc.source,
                'chunkIndex': exc.chunk_index,
                'upstreamStatus': exc.external_status_code,
            },
        ) from exc
    except Exception as exc:  # noqa: BLE001
        log_event(logger, 'error', 'python transcription pipeline failed', recordingId=job.recordingId, error=str(exc), errorType=type(exc).__name__)
        raise HTTPException(status_code=500, detail={'message': str(exc), 'source': 'internal'}) from exc
