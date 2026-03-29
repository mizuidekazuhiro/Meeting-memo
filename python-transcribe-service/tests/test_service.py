import pytest

from ffmpeg_utils import ChunkPlanEntry, SourceMetadata, build_chunk_plan
from models import TranscriptResult, TranscriptSegment
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


def test_chunk_plan_generation_for_long_audio():
    plan = build_chunk_plan(1800, 1024)
    assert len(plan) == 3
    assert [p.start_offset_ms for p in plan] == [0, 600000, 1200000]


def test_chunk_plan_single_for_short_audio():
    plan = build_chunk_plan(120, 1024)
    assert len(plan) == 1
    assert plan[0].chunk_count == 1


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
