import importlib
import logging

import httpx
import pytest


class _MockResponse:
    def __init__(self, status_code=200, json_data=None, content=b'ok', request=None):
        self.status_code = status_code
        self._json_data = json_data or {}
        self.content = content
        self.request = request or httpx.Request('POST', 'https://example.com')

    def json(self):
        return self._json_data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError('err', request=self.request, response=self)


def _reload_modules(monkeypatch, **env):
    for key in ('DROPBOX_ACCESS_TOKEN', 'DROPBOX_REFRESH_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET'):
        monkeypatch.delenv(key, raising=False)
    for key, val in env.items():
        monkeypatch.setenv(key, val)
    import config
    import dropbox_client

    importlib.reload(config)
    return importlib.reload(dropbox_client)


def test_refresh_credentials_take_priority_over_static_access_token(monkeypatch):
    mod = _reload_modules(
        monkeypatch,
        DROPBOX_ACCESS_TOKEN='stale-token',
        DROPBOX_REFRESH_TOKEN='refresh-token',
        DROPBOX_APP_KEY='app-key',
        DROPBOX_APP_SECRET='app-secret',
    )
    calls = []

    def _fake_post(url, **kwargs):
        calls.append(url)
        if 'oauth2/token' in url:
            return _MockResponse(json_data={'access_token': 'fresh-token', 'expires_in': 3600})
        return _MockResponse(content=b'audio')

    monkeypatch.setattr(mod.httpx, 'post', _fake_post)

    client = mod.DropboxClient()
    content = client.download_file('id:1', None)

    assert content == b'audio'
    assert calls[0] == 'https://api.dropbox.com/oauth2/token'


def test_download_401_with_cached_token_refreshes_and_retries_once(monkeypatch):
    mod = _reload_modules(
        monkeypatch,
        DROPBOX_REFRESH_TOKEN='refresh-token',
        DROPBOX_APP_KEY='app-key',
        DROPBOX_APP_SECRET='app-secret',
    )
    state = {'token_refresh_calls': 0, 'download_calls': 0}

    def _fake_post(url, **kwargs):
        if 'oauth2/token' in url:
            state['token_refresh_calls'] += 1
            return _MockResponse(json_data={'access_token': f"fresh-{state['token_refresh_calls']}", 'expires_in': 1})
        state['download_calls'] += 1
        if state['download_calls'] == 1:
            return _MockResponse(status_code=401, request=httpx.Request('POST', url))
        return _MockResponse(status_code=200, content=b'retry-ok', request=httpx.Request('POST', url))

    monkeypatch.setattr(mod.httpx, 'post', _fake_post)

    client = mod.DropboxClient()
    assert client.download_file('id:1', None) == b'retry-ok'
    assert state['download_calls'] == 2
    assert state['token_refresh_calls'] == 2


def test_static_access_token_mode_without_refresh_credentials(monkeypatch):
    mod = _reload_modules(monkeypatch, DROPBOX_ACCESS_TOKEN='static-token')

    def _fake_post(url, **kwargs):
        assert 'oauth2/token' not in url
        return _MockResponse(status_code=200, content=b'static-ok')

    monkeypatch.setattr(mod.httpx, 'post', _fake_post)

    client = mod.DropboxClient()
    assert client.download_file('id:1', None) == b'static-ok'


def test_logs_do_not_include_token_or_secret_values(monkeypatch, caplog):
    mod = _reload_modules(monkeypatch, DROPBOX_ACCESS_TOKEN='top-secret-token')

    def _fake_post(url, **kwargs):
        return _MockResponse(status_code=401, request=httpx.Request('POST', url))

    monkeypatch.setattr(mod.httpx, 'post', _fake_post)
    caplog.set_level(logging.INFO)

    client = mod.DropboxClient()
    with pytest.raises(httpx.HTTPStatusError):
        client.download_file('id:1', None)

    rendered = '\n'.join(r.getMessage() for r in caplog.records)
    assert 'top-secret-token' not in rendered
    assert 'DROPBOX_APP_SECRET' not in rendered
    assert 'dropbox_download_unauthorized_retry_failed' in rendered
