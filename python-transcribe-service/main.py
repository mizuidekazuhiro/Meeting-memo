from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel

from auth import require_bearer_token
from callback_client import send_callback
from dropbox_client import DropboxClient
from logging_utils import configure_logging, get_logger, log_event, preview_text
from models import TranscriptionJobRequest, WorkersCallbackPayload, WorkersFailureCallbackPayload
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
    callback_status: str = 'pending'
    finalize_status: str = 'pending'
    transcription_status: str = 'pending'
    overall_status: str = 'queued'
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    payload: WorkersCallbackPayload | WorkersFailureCallbackPayload | None = None


class CallbackRetryRequest(BaseModel):
    callbackUrl: str | None = None


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


_QUALITY_METRIC_KEYS = {
    'textLength',
    'sentenceCount',
    'uniqueSentenceCount',
    'uniqueSentenceRatio',
    'maxExactSentenceRepetitions',
    'maxNormalizedSentenceRepetitions',
    'charactersPerMinute',
    'japanesePunctuationCount',
    'englishPunctuationCount',
    'hindiPunctuationCount',
}


def _failure_stage_for_exception(exc: Exception, current_stage: str) -> str:
    if isinstance(exc, TranscriptionProcessingError):
        if exc.failure_stage:
            return exc.failure_stage
        return {
            'validation': 'ffmpeg_chunk_validation',
            'ffmpeg': 'ffmpeg_chunk_validation',
            'openai': 'openai_transcription',
            'openai_response': 'openai_transcription',
            'quality': 'transcript_quality',
            'merge': 'merged_transcript',
        }.get(exc.source, 'transcription_unhandled')
    return current_stage


def _build_failure_callback_payload(
    job: TranscriptionJobRequest,
    exc: Exception,
    processing_seconds: float,
    current_stage: str,
) -> WorkersFailureCallbackPayload:
    context = exc.context if isinstance(exc, TranscriptionProcessingError) else {}
    quality_reasons_value = context.get('qualityReasons')
    quality_reasons = (
        [str(reason) for reason in quality_reasons_value]
        if isinstance(quality_reasons_value, list)
        else None
    )
    quality_metrics = {
        key: context[key]
        for key in _QUALITY_METRIC_KEYS
        if key in context
    } or None
    return WorkersFailureCallbackPayload(
        recordingId=job.recordingId,
        dropboxFileId=job.dropboxFileId or '',
        dropboxPathLower=job.dropboxPathLower,
        fileName=job.fileName,
        failureStage=_failure_stage_for_exception(exc, current_stage),
        errorSource=(
            exc.source
            if isinstance(exc, TranscriptionProcessingError)
            else 'dropbox'
            if current_stage == 'dropbox_download'
            else type(exc).__name__
        ),
        errorMessage=str(exc) or type(exc).__name__,
        failedChunkIndex=exc.chunk_index if isinstance(exc, TranscriptionProcessingError) else None,
        processingSeconds=processing_seconds,
        qualityReasons=quality_reasons,
        qualityMetrics=quality_metrics,
    )


def _process_job_async(job: TranscriptionJobRequest) -> None:
    update_job_state(job.recordingId, 'running', transcription_status='running', overall_status='running', callback_status='pending', finalize_status='pending')
    started_at = time.perf_counter()
    current_stage = 'dropbox_download'
    log_event(logger, 'info', 'transcription_started', recordingId=job.recordingId, dropboxFileId=job.dropboxFileId, dropboxPathLower=job.dropboxPathLower, fileName=job.fileName)
    try:
        source = dropbox.download_file(job.dropboxFileId, job.dropboxPathLower)
        current_stage = 'transcription_unhandled'
        payload = service.process(job, source)
        log_event(logger, 'info', 'transcript_merge_completed', recordingId=job.recordingId, transcriptLength=len(payload.transcript.fullText), segmentCount=len(payload.transcript.segments))

        callback_succeeded, finalize_queued = send_callback(payload, callback_url=job.callbackUrl)
        elapsed = round(time.perf_counter() - started_at, 3)
        if callback_succeeded:
            log_event(logger, 'info', 'callback_attempt_succeeded', recordingId=job.recordingId)
            overall_status = 'callback_delivered_finalize_queued' if finalize_queued is True else 'callback_delivered_finalize_unknown'
            update_job_state(
                job.recordingId,
                'callback_delivered',
                payload=payload,
                callback_succeeded=True,
                callback_status='succeeded',
                transcription_status='transcribed',
                finalize_status='queued_in_workers' if finalize_queued is True else 'unknown_in_workers',
                error=None,
                processing_seconds=elapsed,
                overall_status=overall_status,
            )
            log_event(
                logger,
                'info',
                'lifecycle_completed',
                recordingId=job.recordingId,
                transcriptionStatus='transcribed',
                callbackStatus='succeeded',
                finalizeStatus='queued_in_workers' if finalize_queued is True else 'unknown_in_workers',
                overallStatus=overall_status,
                processingSeconds=elapsed,
            )
            return

        update_job_state(
            job.recordingId,
            'callback_failed',
            payload=payload,
            callback_succeeded=False,
            callback_status='failed',
            transcription_status='transcribed',
            finalize_status='skipped',
            overall_status='transcribed_callback_failed',
            error='callback delivery failed after retries',
            processing_seconds=elapsed,
        )
        log_event(logger, 'warning', 'lifecycle_finished_with_callback_failed', recordingId=job.recordingId, transcriptionStatus='transcribed', callbackStatus='failed', overallStatus='transcribed_callback_failed', processingSeconds=elapsed)
    except Exception as exc:  # noqa: BLE001
        elapsed = round(time.perf_counter() - started_at, 3)
        phase = 'unknown'
        failed_chunk_index = None
        status_code = None
        if isinstance(exc, TranscriptionProcessingError):
            phase = exc.source
            failed_chunk_index = exc.chunk_index
            status_code = exc.external_status_code
        failure_payload = _build_failure_callback_payload(job, exc, elapsed, current_stage)
        failure_callback_succeeded = False
        try:
            failure_callback_succeeded, _ = send_callback(
                failure_payload,
                callback_url=job.callbackUrl,
            )
        except Exception as callback_exc:  # noqa: BLE001
            log_event(
                logger,
                'error',
                'terminal failure callback raised unexpectedly',
                recordingId=job.recordingId,
                failureStage=failure_payload.failureStage,
                exceptionClass=type(callback_exc).__name__,
                error=preview_text(str(callback_exc)),
            )
        update_job_state(
            job.recordingId,
            'failed',
            payload=failure_payload,
            error=str(exc),
            callback_succeeded=failure_callback_succeeded,
            callback_status='succeeded' if failure_callback_succeeded else 'failed',
            transcription_status='failed',
            finalize_status='skipped',
            overall_status=(
                'failed_callback_delivered'
                if failure_callback_succeeded
                else 'failed_callback_delivery_failed'
            ),
            processing_seconds=elapsed,
        )
        log_event(
            logger,
            'error',
            'python transcription pipeline failed',
            recordingId=job.recordingId,
            phase=phase,
            failureStage=failure_payload.failureStage,
            errorSource=failure_payload.errorSource,
            failedChunkIndex=failed_chunk_index,
            responseStatus=status_code,
            exceptionClass=type(exc).__name__,
            error=preview_text(str(exc)),
            processingSeconds=elapsed,
            callbackUrlOverride=bool(job.callbackUrl),
            failureCallbackSucceeded=failure_callback_succeeded,
            qualityReasons=failure_payload.qualityReasons,
            qualityMetrics=failure_payload.qualityMetrics,
        )


@app.get('/health')
def health() -> dict[str, bool]:
    return {'ok': True}


@app.post('/jobs/transcribe', dependencies=[Depends(require_bearer_token)], status_code=202)
def transcribe_job(job: TranscriptionJobRequest) -> dict[str, object]:
    request_started_at = time.perf_counter()
    log_event(logger, 'info', 'jobs/transcribe request accepted', recordingId=job.recordingId, callbackUrlOverride=bool(job.callbackUrl), processingMode='async-background')
    with job_states_lock:
        state = job_states.get(job.recordingId)
        if state and state.status in {'queued', 'running'}:
            elapsed = round(time.perf_counter() - request_started_at, 3)
            return {'ok': True, 'recordingId': job.recordingId, 'status': state.status, 'accepted': True, 'requestSeconds': elapsed, 'processingSeconds': state.processing_seconds}

    updated = update_job_state(job.recordingId, 'queued', attempts=(state.attempts + 1 if state else 1), callback_succeeded=None, error=None)
    executor.submit(_process_job_async, job)
    elapsed = round(time.perf_counter() - request_started_at, 3)
    return {'ok': True, 'recordingId': job.recordingId, 'status': updated.status, 'accepted': True, 'requestSeconds': elapsed, 'processingSeconds': updated.processing_seconds}


@app.post('/jobs/{recording_id}/callback/retry', dependencies=[Depends(require_bearer_token)])
def retry_callback(recording_id: str, body: CallbackRetryRequest) -> dict[str, object]:
    with job_states_lock:
        state = job_states.get(recording_id)
    if not state:
        raise HTTPException(status_code=404, detail={'message': 'recordingId not found', 'recordingId': recording_id})
    if not state.payload:
        raise HTTPException(status_code=400, detail={'message': 'transcription payload not found for callback retry', 'recordingId': recording_id})

    log_event(logger, 'info', 'callback_retry_started', recordingId=recording_id, manual=True)
    callback_succeeded, finalize_queued = send_callback(state.payload, callback_url=body.callbackUrl)
    is_failure_payload = isinstance(state.payload, WorkersFailureCallbackPayload)
    if callback_succeeded:
        if is_failure_payload:
            updated = update_job_state(
                recording_id,
                'failed',
                callback_succeeded=True,
                callback_status='succeeded',
                transcription_status='failed',
                finalize_status='skipped',
                overall_status='failed_callback_delivered',
                error=state.error,
            )
            log_event(logger, 'info', 'failure_callback_retry_succeeded', recordingId=recording_id, manual=True)
            return {
                'ok': True,
                'recordingId': recording_id,
                'status': updated.status,
                'callbackStatus': updated.callback_status,
                'overallStatus': updated.overall_status,
            }
        updated = update_job_state(
            recording_id,
            'callback_delivered',
            callback_succeeded=True,
            callback_status='succeeded',
            finalize_status='queued_in_workers' if finalize_queued is True else 'unknown_in_workers',
            overall_status='callback_delivered_finalize_queued' if finalize_queued is True else 'callback_delivered_finalize_unknown',
            error=None,
        )
        log_event(logger, 'info', 'callback_retry_succeeded', recordingId=recording_id, manual=True)
        return {'ok': True, 'recordingId': recording_id, 'status': updated.status, 'callbackStatus': updated.callback_status, 'overallStatus': updated.overall_status}

    updated = update_job_state(
        recording_id,
        'failed' if is_failure_payload else 'callback_failed',
        callback_succeeded=False,
        callback_status='failed',
        transcription_status='failed' if is_failure_payload else state.transcription_status,
        finalize_status='skipped',
        overall_status='failed_callback_delivery_failed' if is_failure_payload else 'transcribed_callback_failed',
        error=state.error if is_failure_payload else 'manual callback retry failed',
    )
    log_event(logger, 'warning', 'callback_retry_failed', recordingId=recording_id, manual=True)
    return {'ok': False, 'recordingId': recording_id, 'status': updated.status, 'callbackStatus': updated.callback_status, 'overallStatus': updated.overall_status}


@app.get('/jobs/transcribe/{recording_id}', dependencies=[Depends(require_bearer_token)])
def get_transcribe_job_status(recording_id: str) -> dict[str, object]:
    with job_states_lock:
        state = job_states.get(recording_id)
    if not state:
        raise HTTPException(status_code=404, detail={'message': 'recordingId not found', 'recordingId': recording_id})

    if state.status == 'failed':
        raise HTTPException(status_code=500, detail={'message': 'transcription job failed', 'recordingId': state.recording_id})

    return {
        'ok': True,
        'recordingId': state.recording_id,
        'status': state.status,
        'attempts': state.attempts,
        'callbackSucceeded': state.callback_succeeded,
        'callbackStatus': state.callback_status,
        'transcriptionStatus': state.transcription_status,
        'finalizeStatus': state.finalize_status,
        'overallStatus': state.overall_status,
        'error': state.error,
        'processingSeconds': state.processing_seconds,
        'updatedAt': state.updated_at,
    }
