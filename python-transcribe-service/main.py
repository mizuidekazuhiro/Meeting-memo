from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException

from auth import require_bearer_token
from callback_client import send_callback
from dropbox_client import DropboxClient
from logging_utils import configure_logging, get_logger, log_event, preview_text
from models import TranscriptionJobRequest
from transcription_service import TranscriptionProcessingError, TranscriptionService

configure_logging()
logger = get_logger()
app = FastAPI(title='meeting-memo-python-transcribe-service')
service = TranscriptionService()
dropbox = DropboxClient()
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='transcribe-worker')


@dataclass
class JobState:
    recording_id: str
    status: str
    attempts: int = 0
    callback_succeeded: bool | None = None
    error: str | None = None
    processing_seconds: float | None = None
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


job_states: dict[str, JobState] = {}
job_states_lock = threading.Lock()


def update_job_state(recording_id: str, status: str, **kwargs) -> JobState:
    with job_states_lock:
        state = job_states.get(recording_id) or JobState(recording_id=recording_id, status='queued')
        state.status = status
        state.updated_at = datetime.now(timezone.utc).isoformat()
        for key, value in kwargs.items():
            if hasattr(state, key):
                setattr(state, key, value)
        job_states[recording_id] = state
        return state


def _process_job_async(job: TranscriptionJobRequest) -> None:
    update_job_state(job.recordingId, 'running')
    started_at = time.perf_counter()
    log_event(
        logger,
        'info',
        'transcribe lifecycle start',
        recordingId=job.recordingId,
        dropboxFileId=job.dropboxFileId,
        dropboxPathLower=job.dropboxPathLower,
        fileName=job.fileName,
        callbackUrlOverride=bool(job.callbackUrl),
        processingMode='async-background',
    )
    try:
        source = dropbox.download_file(job.dropboxFileId, job.dropboxPathLower)
        payload = service.process(job, source)
        callback_succeeded = send_callback(payload, callback_url=job.callbackUrl)
        elapsed = round(time.perf_counter() - started_at, 3)
        update_job_state(job.recordingId, 'completed', callback_succeeded=callback_succeeded, error=None, processing_seconds=elapsed)
        if callback_succeeded:
            log_event(
                logger,
                'info',
                'callback completed',
                recordingId=job.recordingId,
                callbackSucceeded=True,
                callbackUrlOverride=bool(job.callbackUrl),
            )
        else:
            log_event(
                logger,
                'warning',
                'callback failed but transcription marked successful',
                recordingId=job.recordingId,
                callbackSucceeded=False,
                callbackUrlOverride=bool(job.callbackUrl),
                retryAttempted=False,
                reason='send_callback returned False',
            )
        log_event(
            logger,
            'info',
            'transcribe lifecycle complete',
            recordingId=job.recordingId,
            status='completed',
            processingSeconds=elapsed,
        )
    except Exception as exc:  # noqa: BLE001
        elapsed = round(time.perf_counter() - started_at, 3)
        phase = 'unknown'
        failed_chunk_index = None
        status_code = None
        if isinstance(exc, TranscriptionProcessingError):
            phase = exc.source
            failed_chunk_index = exc.chunk_index
            status_code = exc.external_status_code
        update_job_state(job.recordingId, 'failed', error=str(exc), callback_succeeded=False, processing_seconds=elapsed)
        log_event(
            logger,
            'error',
            'python transcription pipeline failed',
            recordingId=job.recordingId,
            phase=phase,
            failedChunkIndex=failed_chunk_index,
            responseStatus=status_code,
            exceptionClass=type(exc).__name__,
            error=preview_text(str(exc)),
            processingSeconds=elapsed,
            callbackUrlOverride=bool(job.callbackUrl),
        )


@app.get('/health')
def health() -> dict[str, bool]:
    return {'ok': True}


@app.post('/jobs/transcribe', dependencies=[Depends(require_bearer_token)], status_code=202)
def transcribe_job(job: TranscriptionJobRequest) -> dict[str, object]:
    request_started_at = time.perf_counter()
    log_event(
        logger,
        'info',
        'jobs/transcribe request accepted',
        recordingId=job.recordingId,
        callbackUrlOverride=bool(job.callbackUrl),
        processingMode='async-background',
        note='Long audio can take a long time because processing is synchronous inside the worker thread.',
    )
    with job_states_lock:
        state = job_states.get(job.recordingId)
        if state and state.status in {'queued', 'running'}:
            elapsed = round(time.perf_counter() - request_started_at, 3)
            log_event(logger, 'info', 'jobs/transcribe request deduplicated', recordingId=job.recordingId, status=state.status, requestSeconds=elapsed)
            return {
                'ok': True,
                'recordingId': job.recordingId,
                'status': state.status,
                'accepted': True,
                'requestSeconds': elapsed,
                'processingSeconds': state.processing_seconds,
            }

    updated = update_job_state(job.recordingId, 'queued', attempts=(state.attempts + 1 if state else 1), callback_succeeded=None, error=None)
    executor.submit(_process_job_async, job)
    elapsed = round(time.perf_counter() - request_started_at, 3)
    log_event(logger, 'info', 'jobs/transcribe request finished', recordingId=job.recordingId, status=updated.status, requestSeconds=elapsed)
    return {
        'ok': True,
        'recordingId': job.recordingId,
        'status': updated.status,
        'accepted': True,
        'requestSeconds': elapsed,
        'processingSeconds': updated.processing_seconds,
    }


@app.get('/jobs/transcribe/{recording_id}', dependencies=[Depends(require_bearer_token)])
def get_transcribe_job_status(recording_id: str) -> dict[str, object]:
    with job_states_lock:
        state = job_states.get(recording_id)
    if not state:
        raise HTTPException(status_code=404, detail={'message': 'recordingId not found', 'recordingId': recording_id})

    detail: dict[str, object] | None = None
    if state.error:
        detail = {'message': 'transcription job failed', 'recordingId': state.recording_id}

    if state.status == 'failed':
        raise HTTPException(status_code=500, detail=detail or {'message': 'transcription job failed', 'recordingId': state.recording_id})

    return {
        'ok': True,
        'recordingId': state.recording_id,
        'status': state.status,
        'attempts': state.attempts,
        'callbackSucceeded': state.callback_succeeded,
        'error': state.error,
        'processingSeconds': state.processing_seconds,
        'updatedAt': state.updated_at,
    }
