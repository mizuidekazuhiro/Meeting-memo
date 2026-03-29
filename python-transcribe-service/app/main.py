from __future__ import annotations

import base64
import logging
import os

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException

from .models import TranscriptionJobRequest
from .service import InputValidationError, PipelineService, UpstreamParseError

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
logger = logging.getLogger(__name__)
app = FastAPI(title='meeting-memo-python-transcribe-service')
service = PipelineService()


def require_bearer_token(authorization: str | None = Header(default=None)) -> None:
    expected = os.getenv('PYTHON_TRANSCRIBE_API_TOKEN', '')
    if not expected:
        return
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status_code=401, detail='Missing bearer token')
    token = authorization.split(' ', 1)[1]
    if token != expected:
        raise HTTPException(status_code=401, detail='Invalid bearer token')


def resolve_dropbox_access_token() -> str:
    access = os.getenv('DROPBOX_ACCESS_TOKEN')
    if access:
        return access
    app_key = os.getenv('DROPBOX_APP_KEY')
    app_secret = os.getenv('DROPBOX_APP_SECRET')
    refresh = os.getenv('DROPBOX_REFRESH_TOKEN')
    if not (app_key and app_secret and refresh):
        raise RuntimeError('Dropbox credentials are missing')
    basic = base64.b64encode(f'{app_key}:{app_secret}'.encode()).decode()
    resp = httpx.post('https://api.dropbox.com/oauth2/token', data={'grant_type': 'refresh_token', 'refresh_token': refresh}, headers={'authorization': f'Basic {basic}'}, timeout=30)
    resp.raise_for_status()
    return resp.json()['access_token']


def download_dropbox_file(job: TranscriptionJobRequest) -> bytes:
    path = job.dropboxFileId or job.dropboxPathLower
    if not path:
        raise InputValidationError('dropbox file identity is missing')
    token = resolve_dropbox_access_token()
    resp = httpx.post('https://content.dropboxapi.com/2/files/download', headers={'authorization': f'Bearer {token}', 'Dropbox-API-Arg': f'{{"path": "{path}"}}'}, timeout=120)
    resp.raise_for_status()
    return resp.content


@app.get('/health')
def health() -> dict[str, bool]:
    return {'ok': True}


@app.post('/jobs/transcribe', dependencies=[Depends(require_bearer_token)])
def start_job(job: TranscriptionJobRequest) -> dict[str, object]:
    try:
        payload = service.process(job, download_dropbox_file)
        service.callback_workers(payload, callback_url=job.callbackUrl)
        return {'ok': True, 'recordingId': payload.recordingId, 'status': 'transcribed'}
    except (InputValidationError, ValueError) as exc:
        logger.exception('python transcription pipeline input validation failed')
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (UpstreamParseError, httpx.HTTPStatusError) as exc:
        logger.exception('python transcription pipeline upstream handling failed')
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception('python transcription pipeline failed')
        raise HTTPException(status_code=500, detail=str(exc)) from exc
