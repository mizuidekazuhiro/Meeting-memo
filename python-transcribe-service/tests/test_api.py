from fastapi.testclient import TestClient


def test_health_endpoint():
    from main import app

    client = TestClient(app)
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json() == {'ok': True}


def test_auth_guard_rejects_invalid_token(monkeypatch):
    monkeypatch.setenv('API_TOKEN', 'expected-token')
    import importlib
    import config
    import auth

    importlib.reload(config)
    importlib.reload(auth)

    from fastapi import Depends, FastAPI

    app = FastAPI()

    @app.post('/guarded', dependencies=[Depends(auth.require_bearer_token)])
    def guarded():
        return {'ok': True}

    client = TestClient(app)
    response = client.post('/guarded', headers={'authorization': 'Bearer wrong'})
    assert response.status_code == 401

    monkeypatch.delenv('API_TOKEN', raising=False)


def test_transcribe_job_success_and_processing_seconds(monkeypatch):
    import main

    class FakeDropbox:
        def download_file(self, dropbox_file_id, dropbox_path_lower):
            return b'audio-bytes'

    class SuccessPayload:
        recordingId = 'rec-1'
        transcript = type('Transcript', (), {'fullText': 'hello', 'segments': []})()

    class SuccessService:
        def process(self, job, source_bytes):
            return SuccessPayload()

    class InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)

    monkeypatch.setattr(main, 'dropbox', FakeDropbox())
    monkeypatch.setattr(main, 'service', SuccessService())
    monkeypatch.setattr(main, 'send_callback', lambda payload, callback_url=None: True)
    finalize_calls = []
    monkeypatch.setattr(main, 'send_finalize', lambda recording_id, callback_url=None: (finalize_calls.append((recording_id, callback_url)) or True, 'https://example.com/api/interviews/finalize'))
    monkeypatch.setattr(main, 'executor', InlineExecutor())
    main.job_states.clear()

    client = TestClient(main.app)
    import auth

    token = auth.SETTINGS.api_token or 'anything'
    response = client.post(
        '/jobs/transcribe',
        headers={'authorization': f'Bearer {token}'},
        json={
            'recordingId': 'rec-1',
            'dropboxFileId': 'id:123',
            'fileName': 'audio.m4a',
        },
    )

    assert response.status_code == 202
    assert response.json()['accepted'] is True
    assert 'processingSeconds' in response.json()

    status_response = client.get('/jobs/transcribe/rec-1', headers={'authorization': f'Bearer {token}'})
    assert status_response.status_code == 200
    body = status_response.json()
    assert body['status'] == 'completed'
    assert body['callbackSucceeded'] is True
    assert body['finalizeStatus'] == 'succeeded'
    assert isinstance(body['processingSeconds'], float)
    assert finalize_calls == [('rec-1', None)]


def test_transcribe_job_callback_failure_marks_callback_failed(monkeypatch):
    import main

    class FakeDropbox:
        def download_file(self, dropbox_file_id, dropbox_path_lower):
            return b'audio-bytes'

    class SuccessPayload:
        recordingId = 'rec-cb-fail'
        transcript = type('Transcript', (), {'fullText': 'hello', 'segments': []})()

    class SuccessService:
        def process(self, job, source_bytes):
            return SuccessPayload()

    class InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)

    monkeypatch.setattr(main, 'dropbox', FakeDropbox())
    monkeypatch.setattr(main, 'service', SuccessService())
    monkeypatch.setattr(main, 'send_callback', lambda payload, callback_url=None: False)
    monkeypatch.setattr(main, 'send_finalize', lambda recording_id, callback_url=None: (True, 'https://example.com/api/interviews/finalize'))
    monkeypatch.setattr(main, 'executor', InlineExecutor())
    main.job_states.clear()

    client = TestClient(main.app)
    import auth

    token = auth.SETTINGS.api_token or 'anything'
    client.post(
        '/jobs/transcribe',
        headers={'authorization': f'Bearer {token}'},
        json={'recordingId': 'rec-cb-fail', 'dropboxFileId': 'id:123', 'fileName': 'audio.m4a'},
    )

    status_response = client.get('/jobs/transcribe/rec-cb-fail', headers={'authorization': f'Bearer {token}'})
    assert status_response.status_code == 200
    body = status_response.json()
    assert body['status'] == 'callback_failed'
    assert body['callbackSucceeded'] is False
    assert body['finalizeStatus'] == 'skipped'


def test_transcribe_job_deduplicates_running_job(monkeypatch):
    import main

    class InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            return None

    monkeypatch.setattr(main, 'executor', InlineExecutor())
    main.job_states.clear()
    main.update_job_state('rec-2', 'running', attempts=1)

    client = TestClient(main.app)
    import auth

    token = auth.SETTINGS.api_token or 'anything'
    response = client.post(
        '/jobs/transcribe',
        headers={'authorization': f'Bearer {token}'},
        json={
            'recordingId': 'rec-2',
            'dropboxFileId': 'id:123',
            'fileName': 'audio.m4a',
        },
    )

    assert response.status_code == 202
    assert response.json()['status'] == 'running'


def test_callback_success_finalize_failure_marks_finalize_failed(monkeypatch):
    import main

    class FakeDropbox:
        def download_file(self, dropbox_file_id, dropbox_path_lower):
            return b'audio-bytes'

    class SuccessPayload:
        recordingId = 'rec-finalize-fail'
        transcript = type('Transcript', (), {'fullText': 'hello', 'segments': []})()

    class SuccessService:
        def process(self, job, source_bytes):
            return SuccessPayload()

    class InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)

    monkeypatch.setattr(main, 'dropbox', FakeDropbox())
    monkeypatch.setattr(main, 'service', SuccessService())
    monkeypatch.setattr(main, 'send_callback', lambda payload, callback_url=None: True)
    monkeypatch.setattr(main, 'send_finalize', lambda recording_id, callback_url=None: (False, 'https://example.com/api/interviews/finalize'))
    monkeypatch.setattr(main, 'executor', InlineExecutor())
    main.job_states.clear()

    client = TestClient(main.app)
    import auth

    token = auth.SETTINGS.api_token or 'anything'
    client.post(
        '/jobs/transcribe',
        headers={'authorization': f'Bearer {token}'},
        json={'recordingId': 'rec-finalize-fail', 'dropboxFileId': 'id:123', 'fileName': 'audio.m4a'},
    )
    status_response = client.get('/jobs/transcribe/rec-finalize-fail', headers={'authorization': f'Bearer {token}'})
    body = status_response.json()
    assert body['status'] == 'finalize_failed'
    assert body['callbackStatus'] == 'succeeded'
    assert body['finalizeStatus'] == 'failed'
    assert body['overallStatus'] == 'finalize_failed'


def test_callback_success_without_finalize_success_not_completed(monkeypatch):
    import main

    class FakeDropbox:
        def download_file(self, dropbox_file_id, dropbox_path_lower):
            return b'audio-bytes'

    class SuccessPayload:
        recordingId = 'rec-not-completed'
        transcript = type('Transcript', (), {'fullText': 'hello', 'segments': []})()

    class SuccessService:
        def process(self, job, source_bytes):
            return SuccessPayload()

    class InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)

    monkeypatch.setattr(main, 'dropbox', FakeDropbox())
    monkeypatch.setattr(main, 'service', SuccessService())
    monkeypatch.setattr(main, 'send_callback', lambda payload, callback_url=None: True)
    monkeypatch.setattr(main, 'send_finalize', lambda recording_id, callback_url=None: (False, None))
    monkeypatch.setattr(main, 'executor', InlineExecutor())
    main.job_states.clear()

    client = TestClient(main.app)
    import auth

    token = auth.SETTINGS.api_token or 'anything'
    client.post(
        '/jobs/transcribe',
        headers={'authorization': f'Bearer {token}'},
        json={'recordingId': 'rec-not-completed', 'dropboxFileId': 'id:123', 'fileName': 'audio.m4a'},
    )
    status_response = client.get('/jobs/transcribe/rec-not-completed', headers={'authorization': f'Bearer {token}'})
    body = status_response.json()
    assert body['overallStatus'] != 'completed'


def test_finalize_url_derived_from_callback_url(monkeypatch):
    from callback_client import derive_finalize_url

    assert derive_finalize_url('https://meeting-memo.example.workers.dev/api/interviews/transcription-callback') == 'https://meeting-memo.example.workers.dev/api/interviews/finalize'


def test_finalize_skipped_no_url_logs(monkeypatch):
    import callback_client

    monkeypatch.setattr(callback_client, 'resolve_finalize_url', lambda callback_url=None: None)
    events = []
    monkeypatch.setattr(callback_client, 'log_event', lambda *args, **kwargs: events.append((args, kwargs)))
    ok, url = callback_client.send_finalize('rec-skip', callback_url=None)
    assert ok is False
    assert url is None
    assert any(args[2] == 'finalize_skipped_no_url' for args, _kwargs in events)
