from __future__ import annotations

from fastapi import Header, HTTPException

from config import SETTINGS


def require_bearer_token(authorization: str | None = Header(default=None)) -> None:
    if not SETTINGS.api_token:
        return
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status_code=401, detail='Missing bearer token')
    token = authorization.split(' ', 1)[1]
    if token != SETTINGS.api_token:
        raise HTTPException(status_code=401, detail='Invalid bearer token')
