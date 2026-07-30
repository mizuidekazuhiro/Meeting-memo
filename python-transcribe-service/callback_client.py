from __future__ import annotations

import os
import time
import httpx

from config import SETTINGS
from logging_utils import get_logger, log_event, preview_text
from models import WorkersCallbackPayload, WorkersFailureCallbackPayload

logger = get_logger()


def _timeout_config() -> httpx.Timeout:
    connect_timeout_sec = float(os.getenv('CALLBACK_CONNECT_TIMEOUT_SEC', '10'))
    read_timeout_sec = float(os.getenv('CALLBACK_READ_TIMEOUT_SEC', '60'))
    return httpx.Timeout(connect=connect_timeout_sec, read=read_timeout_sec, write=30.0, pool=30.0)


def _retry_delays_sec() -> list[int]:
    return [0, 10, 30, 60]


def _extract_finalize_queued(resp: httpx.Response) -> bool | None:
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001
        return None
    value = body.get('finalizeQueued') if isinstance(body, dict) else None
    return value if isinstance(value, bool) else None


def send_callback(
    payload: WorkersCallbackPayload | WorkersFailureCallbackPayload,
    callback_url: str | None = None,
) -> tuple[bool, bool | None]:
    final_url = callback_url or SETTINGS.workers_callback_url
    if not final_url:
        log_event(logger, 'warning', 'callback skipped', reason='WORKERS_CALLBACK_URL is not configured')
        return False, None

    max_attempts = len(_retry_delays_sec())
    timeout = _timeout_config()
    for attempt, delay_sec in enumerate(_retry_delays_sec(), start=1):
        if delay_sec > 0:
            log_event(
                logger,
                'info',
                'callback_retry_started',
                recordingId=payload.recordingId,
                callbackUrl=final_url,
                attempt=attempt,
                maxAttempts=max_attempts,
                delaySeconds=delay_sec,
            )
            time.sleep(delay_sec)

        started_at = time.perf_counter()
        log_event(
            logger,
            'info',
            'callback_attempt_started',
            recordingId=payload.recordingId,
            callbackUrl=final_url,
            attempt=attempt,
            maxAttempts=max_attempts,
            connectTimeoutSeconds=timeout.connect,
            readTimeoutSeconds=timeout.read,
        )

        try:
            resp = httpx.post(
                final_url,
                json=payload.model_dump(),
                headers={'x-webhook-secret': SETTINGS.workers_callback_token},
                timeout=timeout,
            )
            elapsed = round(time.perf_counter() - started_at, 3)
            body_preview = preview_text(resp.text, max_len=250)
            if resp.status_code >= 400:
                log_event(
                    logger,
                    'warning',
                    'callback_attempt_failed',
                    recordingId=payload.recordingId,
                    callbackUrl=final_url,
                    attempt=attempt,
                    maxAttempts=max_attempts,
                    httpStatus=resp.status_code,
                    elapsedSeconds=elapsed,
                    timeoutType=None,
                    responseBodyPreview=body_preview,
                )
                if attempt < max_attempts:
                    continue
                log_event(
                    logger,
                    'error',
                    'callback_permanently_failed',
                    recordingId=payload.recordingId,
                    callbackUrl=final_url,
                    attempt=attempt,
                    maxAttempts=max_attempts,
                    httpStatus=resp.status_code,
                )
                return False, None

            success_event = 'callback_retry_succeeded' if attempt > 1 else 'callback_attempt_succeeded'
            log_event(
                logger,
                'info',
                success_event,
                recordingId=payload.recordingId,
                callbackUrl=final_url,
                attempt=attempt,
                maxAttempts=max_attempts,
                httpStatus=resp.status_code,
                elapsedSeconds=elapsed,
                responseBodyPreview=body_preview,
                finalizeQueued=_extract_finalize_queued(resp),
            )
            return True, _extract_finalize_queued(resp)
        except Exception as exc:  # noqa: BLE001
            elapsed = round(time.perf_counter() - started_at, 3)
            timeout_type = None
            if isinstance(exc, httpx.ConnectTimeout):
                timeout_type = 'connect_timeout'
            elif isinstance(exc, httpx.ReadTimeout):
                timeout_type = 'read_timeout'
            elif isinstance(exc, httpx.TimeoutException):
                timeout_type = 'timeout'
            event_name = 'callback_retry_failed' if attempt > 1 else 'callback_attempt_failed'
            log_event(
                logger,
                'warning',
                event_name,
                recordingId=payload.recordingId,
                callbackUrl=final_url,
                attempt=attempt,
                maxAttempts=max_attempts,
                exceptionType=type(exc).__name__,
                exceptionMessage=str(exc),
                elapsedSeconds=elapsed,
                timeoutType=timeout_type,
                responseBodyPreview=None,
            )
            if attempt >= max_attempts:
                log_event(
                    logger,
                    'error',
                    'callback_permanently_failed',
                    recordingId=payload.recordingId,
                    callbackUrl=final_url,
                    attempt=attempt,
                    maxAttempts=max_attempts,
                    exceptionType=type(exc).__name__,
                    exceptionMessage=str(exc),
                )
                return False, None
    return False, None
