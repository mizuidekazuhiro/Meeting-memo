from __future__ import annotations

import base64

import httpx

from config import SETTINGS


class DropboxClient:
    def __init__(self) -> None:
        self._cached_token: str | None = None

    def _resolve_access_token(self) -> str:
        if SETTINGS.dropbox_access_token:
            return SETTINGS.dropbox_access_token
        if self._cached_token:
            return self._cached_token
        if not (SETTINGS.dropbox_app_key and SETTINGS.dropbox_app_secret and SETTINGS.dropbox_refresh_token):
            raise RuntimeError('Dropbox auth failed: set DROPBOX_ACCESS_TOKEN or refresh token credentials')
        basic = base64.b64encode(f'{SETTINGS.dropbox_app_key}:{SETTINGS.dropbox_app_secret}'.encode()).decode()
        resp = httpx.post(
            'https://api.dropbox.com/oauth2/token',
            data={'grant_type': 'refresh_token', 'refresh_token': SETTINGS.dropbox_refresh_token},
            headers={'authorization': f'Basic {basic}'},
            timeout=30,
        )
        resp.raise_for_status()
        self._cached_token = resp.json()['access_token']
        return self._cached_token

    def download_file(self, dropbox_file_id: str | None, dropbox_path_lower: str | None) -> bytes:
        path = dropbox_file_id or dropbox_path_lower
        if not path:
            raise RuntimeError('Dropbox identity is missing')
        token = self._resolve_access_token()
        resp = httpx.post(
            'https://content.dropboxapi.com/2/files/download',
            headers={'authorization': f'Bearer {token}', 'Dropbox-API-Arg': f'{{"path": "{path}"}}'},
            timeout=180,
        )
        resp.raise_for_status()
        return resp.content
