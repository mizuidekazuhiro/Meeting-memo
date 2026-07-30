import pytest

from ffmpeg_utils import ChunkPlanEntry, SourceMetadata, build_chunk_plan
from models import IntakeRequestPayload, TranscriptResult, TranscriptSegment, TranscriptionJobRequest
from transcription_service import merge_results


class _FakeResponse:
    def model_dump(self):
        return {'text': 'ok', 'segments': []}


class _FakeStringResponse:
    def model_dump(self):
        return '{"text":"ok","segments":[]}'


class _FakeTranscriptions:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeResponse()


class _FakeStringTranscriptions(_FakeTranscriptions):
    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeStringResponse()


class _FakeAudio:
    def __init__(self):
        self.transcriptions = _FakeTranscriptions()


class _FakeOpenAI:
    def __init__(self):
        self.audio = _FakeAudio()


class _FakeStringAudio:
    def __init__(self):
        self.transcriptions = _FakeStringTranscriptions()


class _FakeStringOpenAI:
    def __init__(self):
        self.audio = _FakeStringAudio()


class _FakeBadResponse:
    def model_dump(self):
        return 123


class _FakeBadTranscriptions(_FakeTranscriptions):
    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeBadResponse()


class _FakeBadAudio:
    def __init__(self):
        self.transcriptions = _FakeBadTranscriptions()


class _FakeBadOpenAI:
    def __init__(self):
        self.audio = _FakeBadAudio()


def _stub_ffprobe(*args, **kwargs):
    return SourceMetadata(duration_sec=1.2, codec='aac', sample_rate=48000, channels=2, container='mp4')


def test_chunk_plan_splits_1000_seconds_into_four_chunks_at_300_second_target():
    plan = build_chunk_plan(1000, 1024)
    assert len(plan) == 4
    assert [p.start_offset_ms for p in plan] == [0, 250000, 500000, 750000]


def test_chunk_plan_single_for_short_audio():
    plan = build_chunk_plan(120, 1024)
    assert len(plan) == 1
    assert plan[0].chunk_count == 1


def test_chunk_plan_respects_24_mb_limit_before_single_chunk_return():
    plan = build_chunk_plan(120, 24 * 1024 * 1024 + 1)

    assert len(plan) == 2
    assert [p.chunk_count for p in plan] == [2, 2]


def test_transcript_merge_order_by_chunk_index():
    merged = merge_results([
        (
            ChunkPlanEntry(1, 2, 600000, 1200000, 600),
            TranscriptResult(fullText=' second\n\n\n', segments=[TranscriptSegment(speaker='spk2', startMs=0, endMs=500, text='second')], raw={'idx': 1}),
        ),
        (
            ChunkPlanEntry(0, 2, 0, 600000, 600),
            TranscriptResult(fullText='first', segments=[TranscriptSegment(speaker='spk1', startMs=0, endMs=500, text='first')], raw={'idx': 0}),
        ),
    ])
    assert merged.fullText == 'first\n\nsecond'
    assert [s.startMs for s in merged.segments] == [0, 600000]


def test_merge_results_corrects_inverted_timestamps():
    merged = merge_results([
        (
            ChunkPlanEntry(0, 1, 1000, 2000, 1),
            TranscriptResult(
                fullText='x',
                segments=[TranscriptSegment(speaker='spk', startMs=300, endMs=100, text='text')],
                raw={'idx': 0},
            ),
        )
    ])
    assert merged.segments[0].startMs == 1300
    assert merged.segments[0].endMs == 1300


def test_transcribe_file_passes_chunking_strategy(monkeypatch, tmp_path):
    monkeypatch.setenv('DIARIZATION_CHUNKING_STRATEGY', 'auto')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'true')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', _stub_ffprobe)

    service = transcription_service.TranscriptionService()
    fake = _FakeOpenAI()
    service.openai = fake

    audio_path = tmp_path / 'sample.wav'
    audio_path.write_bytes(b'RIFF')

    service.transcribe_file(audio_path, language_hint='ja', chunk_index=0, audio_format='wav')

    assert fake.audio.transcriptions.calls
    kwargs = fake.audio.transcriptions.calls[0]
    assert kwargs['model'] == 'gpt-4o-transcribe-diarize'
    assert kwargs['response_format'] == 'diarized_json'
    assert kwargs['chunking_strategy'] == 'auto'


def test_transcribe_file_raises_when_chunking_strategy_missing(monkeypatch, tmp_path):
    monkeypatch.setenv('DIARIZATION_CHUNKING_STRATEGY', '')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'true')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    service = transcription_service.TranscriptionService()
    audio_path = tmp_path / 'sample.wav'
    audio_path.write_bytes(b'RIFF')

    with pytest.raises(transcription_service.TranscriptionProcessingError) as exc:
        service.transcribe_file(audio_path, language_hint='ja', chunk_index=0, audio_format='wav')

    assert 'DIARIZATION_CHUNKING_STRATEGY must be configured' in str(exc.value)


def test_transcribe_file_wraps_normalize_runtime_error(monkeypatch, tmp_path):
    monkeypatch.setenv('DIARIZATION_CHUNKING_STRATEGY', 'auto')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'true')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', _stub_ffprobe)

    service = transcription_service.TranscriptionService()
    service.openai = _FakeBadOpenAI()

    audio_path = tmp_path / 'sample.wav'
    audio_path.write_bytes(b'RIFF')

    with pytest.raises(transcription_service.TranscriptionProcessingError) as exc:
        service.transcribe_file(audio_path, language_hint='ja', chunk_index=0, audio_format='wav')

    assert exc.value.source == 'openai_response'
    assert 'Unexpected transcription response type' in str(exc.value)


def test_transcribe_file_accepts_json_string_payload(monkeypatch, tmp_path):
    monkeypatch.setenv('DIARIZATION_CHUNKING_STRATEGY', 'auto')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'true')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', _stub_ffprobe)

    service = transcription_service.TranscriptionService()
    service.openai = _FakeStringOpenAI()

    audio_path = tmp_path / 'sample.wav'
    audio_path.write_bytes(b'RIFF')

    result = service.transcribe_file(audio_path, language_hint='ja', chunk_index=0, audio_format='wav')
    assert result.fullText == 'ok'


def test_transcribe_file_uses_standard_model_when_diarization_disabled(monkeypatch, tmp_path):
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')
    monkeypatch.setenv('TRANSCRIBE_LANGUAGE', 'ja')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', _stub_ffprobe)
    service = transcription_service.TranscriptionService()
    fake = _FakeOpenAI()
    service.openai = fake

    audio_path = tmp_path / 'sample.wav'
    audio_path.write_bytes(b'RIFF')
    service.transcribe_file(audio_path, language_hint=None, chunk_index=0, audio_format='wav')

    kwargs = fake.audio.transcriptions.calls[0]
    assert kwargs['model'] == 'gpt-4o-transcribe'
    assert kwargs['language'] == 'ja'
    assert kwargs['response_format'] == 'json'
    assert 'chunking_strategy' not in kwargs
    assert 'prompt' in kwargs


def test_transcribe_file_prefers_request_language_hint_en(monkeypatch, tmp_path):
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')
    monkeypatch.setenv('TRANSCRIBE_LANGUAGE', 'ja')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', _stub_ffprobe)
    service = transcription_service.TranscriptionService()
    fake = _FakeOpenAI()
    service.openai = fake

    audio_path = tmp_path / 'sample.wav'
    audio_path.write_bytes(b'RIFF')
    service.transcribe_file(audio_path, language_hint='en', chunk_index=0, audio_format='wav')

    kwargs = fake.audio.transcriptions.calls[0]
    assert kwargs['language'] == 'en'
    assert 'English business meeting audio' in kwargs['prompt']


def test_transcribe_file_invalid_language_hint_falls_back_to_auto_env(monkeypatch, tmp_path):
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')
    monkeypatch.setenv('TRANSCRIBE_LANGUAGE', 'auto')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', _stub_ffprobe)
    service = transcription_service.TranscriptionService()
    fake = _FakeOpenAI()
    service.openai = fake

    audio_path = tmp_path / 'sample.wav'
    audio_path.write_bytes(b'RIFF')
    service.transcribe_file(audio_path, language_hint='jp', chunk_index=0, audio_format='wav')

    kwargs = fake.audio.transcriptions.calls[0]
    assert 'language' not in kwargs
    assert 'Indian English' in kwargs['prompt']
    assert 'Hindi' in kwargs['prompt']


def test_transcribe_file_explicit_auto_overrides_ja_env_and_omits_language(monkeypatch, tmp_path):
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')
    monkeypatch.setenv('TRANSCRIBE_LANGUAGE', 'ja')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', _stub_ffprobe)
    service = transcription_service.TranscriptionService()
    fake = _FakeOpenAI()
    service.openai = fake

    audio_path = tmp_path / 'sample.wav'
    audio_path.write_bytes(b'RIFF')
    service.transcribe_file(audio_path, language_hint='auto', chunk_index=0, audio_format='wav')

    kwargs = fake.audio.transcriptions.calls[0]
    assert 'language' not in kwargs
    assert 'Preserve the language actually spoken' in kwargs['prompt']
    assert 'Do not force all speech into English' in kwargs['prompt']


def test_quality_failure_triggers_wav_auto_retry(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')
    monkeypatch.setenv('TRANSCRIBE_LANGUAGE', 'ja')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    source_meta = SourceMetadata(duration_sec=120, codec='aac', sample_rate=48000, channels=2, container='mp4')
    chunk = ChunkPlanEntry(0, 1, 0, 120000, 120)
    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', lambda _path: source_meta)
    monkeypatch.setattr(transcription_service, 'build_chunk_plan', lambda _duration, _bytes: [chunk])
    monkeypatch.setattr(
        transcription_service,
        'run_ffmpeg_chunk',
        lambda _source, output, _start, _duration, _fmt: output.write_bytes(b'audio'),
    )
    monkeypatch.setattr(
        transcription_service,
        'validate_chunk',
        lambda _path, ext: (
            True,
            {
                'duration': 120,
                'codec': 'aac' if ext == 'm4a' else 'pcm_s16le',
                'sample_rate': 16000,
                'channels': 1,
                'mime_type': 'audio/mp4' if ext == 'm4a' else 'audio/wav',
            },
        ),
    )

    service = object.__new__(transcription_service.TranscriptionService)
    calls: list[tuple[str, str | None]] = []

    def fake_transcribe(_path, language_hint, _chunk_index, audio_format):
        calls.append((audio_format, language_hint))
        if audio_format == 'm4a':
            return TranscriptResult(fullText='We will follow up. ' * 8, segments=[], raw={})
        return TranscriptResult(
            fullText='We reviewed the project timeline and agreed on the next delivery milestones.',
            segments=[],
            raw={},
        )

    service.transcribe_file = fake_transcribe
    job = TranscriptionJobRequest(
        recordingId='quality-retry',
        dropboxFileId='id:quality-retry',
        fileName='meeting.m4a',
        request=IntakeRequestPayload(languageHint='en'),
    )

    payload = service.process(job, b'source-audio')

    assert calls == [('m4a', 'en'), ('wav', 'auto')]
    assert payload.transcript.fullText.startswith('We reviewed the project timeline')


def test_repetition_after_wav_auto_retry_is_hard_failure(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    source_meta = SourceMetadata(duration_sec=120, codec='aac', sample_rate=48000, channels=2, container='mp4')
    chunk = ChunkPlanEntry(0, 1, 0, 120000, 120)
    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', lambda _path: source_meta)
    monkeypatch.setattr(transcription_service, 'build_chunk_plan', lambda _duration, _bytes: [chunk])
    monkeypatch.setattr(
        transcription_service,
        'run_ffmpeg_chunk',
        lambda _source, output, _start, _duration, _fmt: output.write_bytes(b'audio'),
    )
    monkeypatch.setattr(
        transcription_service,
        'validate_chunk',
        lambda _path, ext: (
            True,
            {
                'duration': 120,
                'codec': 'aac' if ext == 'm4a' else 'pcm_s16le',
                'sample_rate': 16000,
                'channels': 1,
                'mime_type': 'audio/mp4' if ext == 'm4a' else 'audio/wav',
            },
        ),
    )

    service = object.__new__(transcription_service.TranscriptionService)
    calls: list[tuple[str, str | None]] = []

    def fake_transcribe(_path, language_hint, _chunk_index, audio_format):
        calls.append((audio_format, language_hint))
        return TranscriptResult(fullText='確認して対応します。' * 8, segments=[], raw={})

    service.transcribe_file = fake_transcribe
    job = TranscriptionJobRequest(
        recordingId='quality-hard-failure',
        dropboxFileId='id:quality-hard-failure',
        fileName='meeting.m4a',
        request=IntakeRequestPayload(languageHint='ja'),
    )

    with pytest.raises(transcription_service.TranscriptionProcessingError) as exc:
        service.process(job, b'source-audio')

    assert exc.value.source == 'quality'
    assert calls == [('m4a', 'ja'), ('wav', 'auto')]


def test_merged_transcript_max_repetition_is_only_a_warning(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    source_meta = SourceMetadata(duration_sec=240, codec='aac', sample_rate=48000, channels=2, container='mp4')
    chunks = [
        ChunkPlanEntry(0, 2, 0, 120000, 120),
        ChunkPlanEntry(1, 2, 120000, 240000, 120),
    ]
    monkeypatch.setattr(transcription_service, 'ffprobe_metadata', lambda _path: source_meta)
    monkeypatch.setattr(transcription_service, 'build_chunk_plan', lambda _duration, _bytes: chunks)
    monkeypatch.setattr(
        transcription_service,
        'run_ffmpeg_chunk',
        lambda _source, output, _start, _duration, _fmt: output.write_bytes(b'audio'),
    )
    monkeypatch.setattr(
        transcription_service,
        'validate_chunk',
        lambda _path, ext: (
            True,
            {
                'duration': 120,
                'codec': 'aac' if ext == 'm4a' else 'pcm_s16le',
                'sample_rate': 16000,
                'channels': 1,
                'mime_type': 'audio/mp4' if ext == 'm4a' else 'audio/wav',
            },
        ),
    )

    service = object.__new__(transcription_service.TranscriptionService)
    calls: list[tuple[int, str, str | None]] = []

    def fake_transcribe(_path, language_hint, chunk_index, audio_format):
        calls.append((chunk_index, audio_format, language_hint))
        return TranscriptResult(fullText='We will follow up. ' * 4, segments=[], raw={})

    service.transcribe_file = fake_transcribe
    job = TranscriptionJobRequest(
        recordingId='merged-quality-hard-failure',
        dropboxFileId='id:merged-quality-hard-failure',
        fileName='meeting.m4a',
        request=IntakeRequestPayload(languageHint='en'),
    )

    payload = service.process(job, b'source-audio')

    assert payload.transcript.fullText.count('We will follow up.') == 8
    assert calls == [(0, 'm4a', 'en'), (1, 'm4a', 'en')]


def test_chunk_prepared_log_uses_resolved_standard_model_and_auto_language(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')
    monkeypatch.setenv('TRANSCRIBE_LANGUAGE', 'ja')

    import importlib
    import config
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)

    captured: dict[str, object] = {}

    def capture_log(_logger, _level, _event, **fields):
        captured.update(fields)

    monkeypatch.setattr(transcription_service, 'log_event', capture_log)
    service = object.__new__(transcription_service.TranscriptionService)
    job = TranscriptionJobRequest(
        recordingId='log-settings',
        dropboxFileId='id:log-settings',
        fileName='meeting.m4a',
        request=IntakeRequestPayload(languageHint='auto'),
    )
    chunk = ChunkPlanEntry(0, 1, 0, 120000, 120)

    service._log_chunk_prepared(
        job=job,
        chunk=chunk,
        audio_format='m4a',
        language_hint='auto',
        attempt='initial_m4a_requested_language',
        validation_passed=True,
        details={'duration': 120},
    )

    assert captured['model'] == 'gpt-4o-transcribe'
    assert captured['response_format'] == 'json'
    assert captured['chunking_strategy'] is None
    assert captured['language'] == 'auto'
    assert captured['languageParameter'] is None
