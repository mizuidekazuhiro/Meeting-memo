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
    from transcription_service import TranscriptionProcessingError

    class FakeDropbox:
        def download_file(self, dropbox_file_id, dropbox_path_lower):
            return b'audio-bytes'

    class FailingService:
        def process(self, job, source_bytes):
            raise TranscriptionProcessingError(
                'openai failed',
                source='openai',
                chunk_index=1,
                external_status_code=400,
            )

    monkeypatch.setattr(main, 'dropbox', FakeDropbox())
    monkeypatch.setattr(main, 'service', FailingService())

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

    assert response.status_code == 502
    detail = response.json()['detail']
    assert detail['source'] == 'openai'
    assert detail['chunkIndex'] == 1
    assert detail['upstreamStatus'] == 400
