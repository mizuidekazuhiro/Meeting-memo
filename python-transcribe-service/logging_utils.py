from __future__ import annotations

import logging
from typing import Any


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')


def get_logger(name: str = 'python-transcribe-service') -> logging.Logger:
    return logging.getLogger(name)


def preview_text(value: Any, max_len: int = 400) -> str:
    text = value if isinstance(value, str) else repr(value)
    if len(text) <= max_len:
        return text
    return f'{text[:max_len]}...(truncated)'


def log_event(logger: logging.Logger, level: str, event: str, **fields: Any) -> None:
    payload = {'event': event, **fields}
    getattr(logger, level, logger.info)(payload)
