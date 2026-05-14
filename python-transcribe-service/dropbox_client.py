from __future__ import annotations

import base64
import time

import httpx

from config import SETTINGS
from logging_utils import get_logger, log_event


logger = get_logger()


TOKEN_EXPIRY_BUFFER_SEC = 60


class DropboxClient:
    def __init__(self) -> None:
        self._cached_token: str | None = None
        self._cached_token_expires_at: float | None = None

    def _has_refresh_credentials(self) -> bool:
        return bool(SETTINGS.dropbox_refresh_token and SETTINGS.dropbox_app_key and SETTINGS.dropbox_app_secret)

    def _token_is_fresh(self) -> bool:
        if not self._cached_token:
            return False
        if self._cached_token_expires_at is None:
            return True
        return time.time() + TOKEN_EXPIRY_BUFFER_SEC < self._cached_token_expires_at

    def _refresh_access_token(self) -> str:
        if not self._has_refresh_credentials():
            raise RuntimeError('Dropbox auth failed: set DROPBOX_ACCESS_TOKEN or refresh token credentials')

        basic = base64.b64encode(f'{SETTINGS.dropbox_app_key}:{SETTINGS.dropbox_app_secret}'.encode()).decode()
        resp = httpx.post(
            'https://api.dropbox.com/oauth2/token',
            data={'grant_type': 'refresh_token', 'refresh_token': SETTINGS.dropbox_refresh_token},
            headers={'authorization': f'Basic {basic}'},
            timeout=30,
        )
        resp.raise_for_status()
        payload = resp.json()
        self._cached_token = payload['access_token']
        expires_in = payload.get('expires_in')
        if isinstance(expires_in, (int, float)) and expires_in > 0:
            self._cached_token_expires_at = time.time() + float(expires_in)
        else:
            self._cached_token_expires_at = None
        log_event(logger, 'info', 'dropbox_access_token_refreshed', hasExpiresIn=bool(self._cached_token_expires_at))
        return self._cached_token

    def _clear_cached_token(self) -> None:
        self._cached_token = None
        self._cached_token_expires_at = None

    def _resolve_access_token(self) -> str:
        if self._has_refresh_credentials():
            if self._token_is_fresh():
                log_event(logger, 'info', 'dropbox_auth_mode_selected', mode='refresh_token_cached')
                return self._cached_token or ''
            log_event(logger, 'info', 'dropbox_auth_mode_selected', mode='refresh_token')
            return self._refresh_access_token()

        if SETTINGS.dropbox_access_token:
            log_event(logger, 'info', 'dropbox_auth_mode_selected', mode='static_access_token')
            return SETTINGS.dropbox_access_token

        raise RuntimeError('Dropbox auth failed: set DROPBOX_ACCESS_TOKEN or refresh token credentials')

    def download_file(self, dropbox_file_id: str | None, dropbox_path_lower: str | None) -> bytes:
        path = dropbox_file_id or dropbox_path_lower
        if not path:
            raise RuntimeError('Dropbox identity is missing')
        token = self._resolve_access_token()
        try:
            resp = httpx.post(
                'https://content.dropboxapi.com/2/files/download',
                headers={'authorization': f'Bearer {token}', 'Dropbox-API-Arg': f'{{"path": "{path}"}}'},
                timeout=180,
            )
            resp.raise_for_status()
            return resp.content
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 401:
                raise
            if not self._has_refresh_credentials():
                log_event(
                    logger,
                    'warning',
                    'dropbox_download_unauthorized_retry_failed',
                    reason='static_access_token_no_refresh_credentials',
                    statusCode=exc.response.status_code,
                )
                raise

            log_event(logger, 'warning', 'dropbox_download_unauthorized_retrying', statusCode=exc.response.status_code)
            self._clear_cached_token()
            retry_token = self._resolve_access_token()
            retry_resp = httpx.post(
                'https://content.dropboxapi.com/2/files/download',
                headers={'authorization': f'Bearer {retry_token}', 'Dropbox-API-Arg': f'{{"path": "{path}"}}'},
                timeout=180,
            )
            try:
                retry_resp.raise_for_status()
            except httpx.HTTPStatusError:
                log_event(
                    logger,
                    'error',
                    'dropbox_download_unauthorized_retry_failed',
                    statusCode=retry_resp.status_code,
                )
                raise exc
            return retry_resp.content
