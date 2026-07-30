import importlib

import pytest


def _load_modules(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')
    monkeypatch.setenv('TRANSCRIBE_LANGUAGE', 'auto')

    import config
    import transcription_service
    import retaining_transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)
    return importlib.reload(retaining_transcription_service)


def _install_audio_stubs(monkeypatch, retaining, *, source_duration, chunks):
    from ffmpeg_utils import SourceMetadata

    source_meta = SourceMetadata(
        duration_sec=source_duration,
        codec='aac',
        sample_rate=48000,
        channels=1,
        container='mp4',
    )
    monkeypatch.setattr(retaining, 'ffprobe_metadata', lambda _path: source_meta)
    monkeypatch.setattr(retaining, 'build_chunk_plan', lambda _duration, _bytes: chunks)
    monkeypatch.setattr(
        retaining,
        'run_ffmpeg_chunk',
        lambda _source, output, _start, _duration, _fmt: output.write_bytes(b'audio'),
    )
    monkeypatch.setattr(
        retaining,
        'validate_chunk',
        lambda _path, ext: (
            True,
            {
                'duration': chunks[0].estimated_duration_sec,
                'codec': 'aac' if ext == 'm4a' else 'pcm_s16le',
                'sample_rate': 16000,
                'channels': 1,
                'mime_type': 'audio/mp4' if ext == 'm4a' else 'audio/wav',
            },
        ),
    )


def test_low_density_retry_is_archived_but_excluded_from_summary(monkeypatch):
    retaining = _load_modules(monkeypatch)
    from ffmpeg_utils import ChunkPlanEntry
    from models import IntakeRequestPayload, TranscriptResult, TranscriptionJobRequest

    chunks = [
        ChunkPlanEntry(0, 2, 0, 180000, 180),
        ChunkPlanEntry(1, 2, 180000, 360000, 180),
    ]
    _install_audio_stubs(monkeypatch, retaining, source_duration=360, chunks=chunks)

    service = object.__new__(retaining.RetainingTranscriptionService)
    calls = []

    def fake_transcribe(_path, language_hint, chunk_index, audio_format):
        calls.append((chunk_index, audio_format, language_hint))
        if chunk_index == 0 and audio_format == 'm4a':
            return TranscriptResult(fullText='What is this? ' * 10, segments=[], raw={'attempt': 'initial'})
        if chunk_index == 0:
            return TranscriptResult(fullText='Short note.', segments=[], raw={'attempt': 'retry'})
        return TranscriptResult(
            fullText=(
                'We reviewed the project schedule and agreed that the Mumbai team '
                'will circulate the revised commercial proposal tomorrow morning.'
            ),
            segments=[],
            raw={'attempt': 'accepted'},
        )

    service.transcribe_file = fake_transcribe
    job = TranscriptionJobRequest(
        recordingId='retain-low-confidence',
        dropboxFileId='id:retain-low-confidence',
        fileName='meeting.m4a',
        request=IntakeRequestPayload(languageHint='auto'),
    )

    payload = service.process(job, b'source-audio')
    transcript = payload.transcript
    trusted_text = '\n'.join(segment.text for segment in transcript.segments)

    assert calls == [
        (0, 'm4a', 'auto'),
        (0, 'wav', 'auto'),
        (1, 'm4a', 'auto'),
    ]
    assert '[低信頼区間 00:00:00-00:03:00｜音声要確認' in transcript.fullText
    assert 'Short note.' in transcript.fullText
    assert 'What is this?' in transcript.fullText
    assert '# 文字起こし再試行・低信頼区間記録' in transcript.fullText
    assert 'We reviewed the project schedule' in transcript.fullText
    assert 'We reviewed the project schedule' in trusted_text
    assert 'Short note.' not in trusted_text
    assert 'What is this?' not in trusted_text

    assert isinstance(transcript.raw, dict)
    assert transcript.raw['trustedChunkCount'] == 1
    assert transcript.raw['lowConfidenceChunkCount'] == 1
    assert transcript.raw['archiveIncludesAllRetryOutputs'] is True
    assert transcript.raw['summaryUsesTrustedSegmentsOnly'] is True
    diagnostics = transcript.raw['chunkDiagnostics']
    assert len(diagnostics) == 1
    assert diagnostics[0]['disposition'] == 'retained_low_confidence_excluded_from_summary'
    assert len(diagnostics[0]['attempts']) == 2
    assert diagnostics[0]['attempts'][0]['quality']['qualityStatus'] == 'reject'
    assert diagnostics[0]['attempts'][1]['quality']['qualityStatus'] == 'retry'


def test_successful_retry_keeps_initial_and_retry_outputs(monkeypatch):
    retaining = _load_modules(monkeypatch)
    from ffmpeg_utils import ChunkPlanEntry
    from models import IntakeRequestPayload, TranscriptResult, TranscriptionJobRequest

    chunks = [ChunkPlanEntry(0, 1, 0, 180000, 180)]
    _install_audio_stubs(monkeypatch, retaining, source_duration=180, chunks=chunks)

    service = object.__new__(retaining.RetainingTranscriptionService)

    def fake_transcribe(_path, _language_hint, _chunk_index, audio_format):
        if audio_format == 'm4a':
            return TranscriptResult(fullText='We will follow up. ' * 8, segments=[], raw={})
        return TranscriptResult(
            fullText=(
                'The revised estimate will be shared after the engineering team '
                'confirms the final quantity and delivery schedule.'
            ),
            segments=[],
            raw={},
        )

    service.transcribe_file = fake_transcribe
    job = TranscriptionJobRequest(
        recordingId='retain-retry-history',
        dropboxFileId='id:retain-retry-history',
        fileName='meeting.m4a',
        request=IntakeRequestPayload(languageHint='en'),
    )

    payload = service.process(job, b'source-audio')
    trusted_text = '\n'.join(segment.text for segment in payload.transcript.segments)

    assert 'The revised estimate will be shared' in payload.transcript.fullText
    assert 'We will follow up.' in payload.transcript.fullText
    assert 'The revised estimate will be shared' in trusted_text
    assert 'We will follow up.' not in trusted_text
    diagnostics = payload.transcript.raw['chunkDiagnostics']
    assert diagnostics[0]['disposition'] == 'accepted_after_wav_auto_retry'
    assert len(diagnostics[0]['attempts']) == 2


def test_repetition_after_retry_remains_terminal_failure(monkeypatch):
    retaining = _load_modules(monkeypatch)
    from ffmpeg_utils import ChunkPlanEntry
    from models import IntakeRequestPayload, TranscriptResult, TranscriptionJobRequest

    chunks = [ChunkPlanEntry(0, 1, 0, 120000, 120)]
    _install_audio_stubs(monkeypatch, retaining, source_duration=120, chunks=chunks)

    service = object.__new__(retaining.RetainingTranscriptionService)
    service.transcribe_file = lambda *_args, **_kwargs: TranscriptResult(
        fullText='確認して対応します。' * 8,
        segments=[],
        raw={},
    )
    job = TranscriptionJobRequest(
        recordingId='retain-hard-failure',
        dropboxFileId='id:retain-hard-failure',
        fileName='meeting.m4a',
        request=IntakeRequestPayload(languageHint='ja'),
    )

    with pytest.raises(retaining.TranscriptionProcessingError) as exc:
        service.process(job, b'source-audio')

    assert exc.value.source == 'quality'
    assert exc.value.failure_stage == 'transcript_quality'
