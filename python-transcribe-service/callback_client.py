from __future__ import annotations

import httpx

from config import SETTINGS
from logging_utils import get_logger, log_event
from models import WorkersCallbackPayload

logger = get_logger()


def send_callback(payload: WorkersCallbackPayload, callback_url: str | None = None) -> bool:
    final_url = callback_url or SETTINGS.workers_callback_url
    if not final_url:
        log_event(logger, 'warning', 'callback skipped', reason='WORKERS_CALLBACK_URL is not configured')
        return False
    try:
        resp = httpx.post(
            final_url,
            json=payload.model_dump(),
            headers={'x-webhook-secret': SETTINGS.workers_callback_token},
            timeout=60,
        )
        resp.raise_for_status()
        return True
    except Exception as exc:  # noqa: BLE001
        log_event(logger, 'error', 'callback failed', error=str(exc), callbackUrl=final_url)
        return False
