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
    monkeypatch.setattr(main, 'send_callback', lambda payload, callback_url=None: (True, True))
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
    assert body['status'] == 'callback_delivered'
    assert body['callbackSucceeded'] is True
    assert body['finalizeStatus'] == 'queued_in_workers'
    assert body['overallStatus'] == 'callback_delivered_finalize_queued'
    assert isinstance(body['processingSeconds'], float)


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
    monkeypatch.setattr(main, 'send_callback', lambda payload, callback_url=None: (False, None))
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


def test_callback_success_without_finalize_queued_not_completed(monkeypatch):
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
    monkeypatch.setattr(main, 'send_callback', lambda payload, callback_url=None: (True, None))
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
    assert body['finalizeStatus'] == 'unknown_in_workers'
    assert body['status'] == 'callback_delivered'


def test_hard_quality_failure_sends_terminal_failure_callback(monkeypatch):
    import main
    from transcription_service import TranscriptionProcessingError

    class FakeDropbox:
        def download_file(self, dropbox_file_id, dropbox_path_lower):
            return b'audio-bytes'

    class QualityFailureService:
        def process(self, job, source_bytes):
            raise TranscriptionProcessingError(
                'Transcript quality rejected after WAV Auto retry',
                source='quality',
                failure_stage='transcript_quality',
                chunk_index=0,
                context={
                    'qualityReasons': ['exact_sentence_repetition'],
                    'textLength': 120,
                    'uniqueSentenceRatio': 0.1,
                },
            )

    callback_calls = []
    monkeypatch.setattr(main, 'dropbox', FakeDropbox())
    monkeypatch.setattr(main, 'service', QualityFailureService())
    monkeypatch.setattr(
        main,
        'send_callback',
        lambda payload, callback_url=None: (
            callback_calls.append((payload, callback_url)) or True,
            False,
        ),
    )
    main.job_states.clear()

    job = main.TranscriptionJobRequest(
        recordingId='rec-quality-failure',
        dropboxFileId='id:quality-failure',
        fileName='audio.m4a',
    )
    main._process_job_async(job)

    state = main.job_states['rec-quality-failure']
    assert len(callback_calls) == 1
    failure_payload, callback_url = callback_calls[0]
    assert callback_url is None
    assert failure_payload.status == 'failed'
    assert failure_payload.recordingId == 'rec-quality-failure'
    assert failure_payload.dropboxFileId == 'id:quality-failure'
    assert failure_payload.fileName == 'audio.m4a'
    assert failure_payload.failureStage == 'transcript_quality'
    assert failure_payload.errorSource == 'quality'
    assert failure_payload.errorMessage == 'Transcript quality rejected after WAV Auto retry'
    assert failure_payload.failedChunkIndex == 0
    assert isinstance(failure_payload.processingSeconds, float)
    assert failure_payload.qualityReasons == ['exact_sentence_repetition']
    assert failure_payload.qualityMetrics == {
        'textLength': 120,
        'uniqueSentenceRatio': 0.1,
    }
    assert state.status == 'failed'
    assert state.transcription_status == 'failed'
    assert state.finalize_status == 'skipped'
    assert state.callback_status == 'succeeded'
    assert state.callback_succeeded is True
    assert state.overall_status == 'failed_callback_delivered'


def test_dropbox_download_failure_sends_terminal_failure_callback(monkeypatch):
    import main

    class FailingDropbox:
        def download_file(self, dropbox_file_id, dropbox_path_lower):
            raise RuntimeError('Dropbox download timed out')

    callback_calls = []
    monkeypatch.setattr(main, 'dropbox', FailingDropbox())
    monkeypatch.setattr(
        main,
        'send_callback',
        lambda payload, callback_url=None: (
            callback_calls.append((payload, callback_url)) or True,
            False,
        ),
    )
    main.job_states.clear()

    job = main.TranscriptionJobRequest(
        recordingId='rec-dropbox-failure',
        dropboxFileId='id:dropbox-failure',
        dropboxPathLower='/apps/meetingmemo/inbox/audio.m4a',
        fileName='audio.m4a',
        callbackUrl='https://worker.example/callback',
    )
    main._process_job_async(job)

    assert len(callback_calls) == 1
    failure_payload, callback_url = callback_calls[0]
    assert callback_url == 'https://worker.example/callback'
    assert failure_payload.failureStage == 'dropbox_download'
    assert failure_payload.errorSource == 'dropbox'
    assert failure_payload.errorMessage == 'Dropbox download timed out'
    assert failure_payload.dropboxPathLower == '/apps/meetingmemo/inbox/audio.m4a'
