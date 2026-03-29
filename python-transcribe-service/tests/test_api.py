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


def test_transcribe_job_maps_external_error_to_502(monkeypatch):
    import main

    class FakeDropbox:
        def download_file(self, dropbox_file_id, dropbox_path_lower):
            return b'audio-bytes'

    class SuccessPayload:
        recordingId = 'rec-1'

    class SuccessService:
        def process(self, job, source_bytes):
            return SuccessPayload()

    class InlineExecutor:
        def submit(self, fn, *args, **kwargs):
            fn(*args, **kwargs)

    monkeypatch.setattr(main, 'dropbox', FakeDropbox())
    monkeypatch.setattr(main, 'service', SuccessService())
    monkeypatch.setattr(main, 'send_callback', lambda payload, callback_url=None: True)
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
    assert response.json()['status'] in {'queued', 'completed'}

    status_response = client.get('/jobs/transcribe/rec-1', headers={'authorization': f'Bearer {token}'})
    assert status_response.status_code == 200
    assert status_response.json()['status'] == 'completed'


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
