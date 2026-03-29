import pytest

from transcription_service import (
    TranscriptionProcessingError,
    normalize_transcription_response,
    parse_transcript_response,
    should_fallback,
)


def test_should_fallback_only_for_4xx_file_errors():
    assert should_fallback(400, 'Audio file might be corrupted or unsupported')
    assert not should_fallback(500, 'unsupported')


def test_parse_diarized_payload():
    result = parse_transcript_response(
        {
            'text': 'hello',
            'diarized_segments': [
                {'speaker': 'spk1', 'start': 0.0, 'end': 1.0, 'text': 'hello'},
            ],
        }
    )
    assert result.fullText == 'hello'
    assert result.segments[0].speaker == 'spk1'
    assert result.segments[0].startMs == 0
    assert result.segments[0].endMs == 1000


def test_parse_diarized_payload_handles_unexpected_shapes():
    result = parse_transcript_response({'text': 'hello', 'diarized_segments': 'unexpected'})
    assert result.fullText == 'hello'
    assert result.segments == []


def test_normalize_transcription_response_from_json_string():
    payload = normalize_transcription_response('{"text":"hello","diarized_segments":[]}')
    assert payload['text'] == 'hello'


def test_normalize_transcription_response_rejects_unexpected_types():
    with pytest.raises(TranscriptionProcessingError):
        normalize_transcription_response(123)
