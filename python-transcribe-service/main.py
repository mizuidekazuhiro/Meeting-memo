from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

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
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='transcribe-worker')


@dataclass
class JobState:
    recording_id: str
    status: str
    attempts: int = 0
    callback_succeeded: bool | None = None
    error: str | None = None
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
    try:
        source = dropbox.download_file(job.dropboxFileId, job.dropboxPathLower)
        payload = service.process(job, source)
        callback_succeeded = send_callback(payload, callback_url=job.callbackUrl)
        update_job_state(job.recordingId, 'completed', callback_succeeded=callback_succeeded, error=None)
        log_event(logger, 'info', 'transcription job completed', recordingId=job.recordingId, callbackSucceeded=callback_succeeded)
    except Exception as exc:  # noqa: BLE001
        update_job_state(job.recordingId, 'failed', error=str(exc), callback_succeeded=False)
        logger.exception('python transcription pipeline failed (background)', extra={'recordingId': job.recordingId})


@app.get('/health')
def health() -> dict[str, bool]:
    return {'ok': True}


@app.post('/jobs/transcribe', dependencies=[Depends(require_bearer_token)], status_code=202)
def transcribe_job(job: TranscriptionJobRequest) -> dict[str, object]:
    with job_states_lock:
        state = job_states.get(job.recordingId)
        if state and state.status in {'queued', 'running'}:
            return {'ok': True, 'recordingId': job.recordingId, 'status': state.status, 'accepted': True}

    updated = update_job_state(job.recordingId, 'queued', attempts=(state.attempts + 1 if state else 1), callback_succeeded=None, error=None)
    executor.submit(_process_job_async, job)
    return {'ok': True, 'recordingId': job.recordingId, 'status': updated.status, 'accepted': True}


@app.get('/jobs/transcribe/{recording_id}', dependencies=[Depends(require_bearer_token)])
def get_transcribe_job_status(recording_id: str) -> dict[str, object]:
    with job_states_lock:
        state = job_states.get(recording_id)
    if not state:
        raise HTTPException(status_code=404, detail={'message': 'recordingId not found', 'recordingId': recording_id})
    return {
        'ok': True,
        'recordingId': state.recording_id,
        'status': state.status,
        'attempts': state.attempts,
        'callbackSucceeded': state.callback_succeeded,
        'error': state.error,
        'updatedAt': state.updated_at,
    }
