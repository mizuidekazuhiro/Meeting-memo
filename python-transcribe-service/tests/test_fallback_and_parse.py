import pytest

from transcription_service import normalize_transcription_response, parse_transcript_response, should_fallback


class _ModelDumpObj:
    def __init__(self, payload):
        self.payload = payload

    def model_dump(self):
        return self.payload


def test_should_fallback_only_for_4xx_file_errors():
    assert should_fallback(400, 'Audio file might be corrupted or unsupported')
    assert not should_fallback(500, 'unsupported')


def test_parse_diarized_json_segments_normal_case():
    result = parse_transcript_response(
        {
            'text': 'hello',
            'segments': [
                {'speaker': 'spk1', 'start': 0.0, 'end': 1.0, 'text': 'hello'},
            ],
        }
    )
    assert result.fullText == 'hello'
    assert result.segments[0].speaker == 'spk1'
    assert result.segments[0].startMs == 0
    assert result.segments[0].endMs == 1000


def test_parse_diarized_segments_alias_and_key_variants():
    result = parse_transcript_response(
        {
            'text': 'greeting',
            'diarized_segments': [
                {'speaker_label': 'A', 'start_ms': 12, 'end_ms': 110, 'text': 'こんにちは'},
                {'speaker_id': 'B', 'start': 1.2, 'end': 2.5, 'text': 'world'},
            ],
        }
    )
    assert [seg.speaker for seg in result.segments] == ['A', 'B']
    assert [seg.startMs for seg in result.segments] == [12, 1200]
    assert [seg.endMs for seg in result.segments] == [110, 2500]


def test_parse_text_fallback_from_segments_when_text_missing():
    result = parse_transcript_response(
        {
            'segments': [
                {'speaker': 'spk1', 'start': 0, 'end': 1, 'text': 'first'},
                {'speaker': 'spk2', 'start': 1, 'end': 2, 'text': 'second'},
            ]
        }
    )
    assert result.fullText == 'first\n\nsecond'


def test_parse_filters_empty_segments():
    result = parse_transcript_response(
        {
            'text': 'ok',
            'segments': [
                {'speaker': 'spk1', 'start': 0, 'end': 1, 'text': '   '},
                {'speaker': 'spk2', 'start': 1, 'end': 2, 'text': 'line'},
            ],
        }
    )
    assert len(result.segments) == 1
    assert result.segments[0].speaker == 'spk2'


def test_parse_diarized_payload_handles_unexpected_shapes():
    result = parse_transcript_response({'text': 'hello', 'diarized_segments': 'unexpected'})
    assert result.fullText == 'hello'
    assert result.segments == []


def test_normalize_transcription_response_from_json_string():
    payload = normalize_transcription_response('{"text":"hello","diarized_segments":[]}')
    assert payload['text'] == 'hello'


def test_normalize_transcription_response_from_dict_and_model_dump():
    payload = {'text': 'hello'}
    assert normalize_transcription_response(payload) is payload

    dumped = normalize_transcription_response(_ModelDumpObj({'text': 'hi', 'segments': []}))
    assert dumped['text'] == 'hi'


def test_normalize_transcription_response_rejects_unexpected_types():
    with pytest.raises(RuntimeError) as exc:
        normalize_transcription_response(123)
    assert 'Unexpected transcription response type: int' in str(exc.value)


def test_parse_not_dependent_on_openai_warning_string():
    payload = normalize_transcription_response({'text': 'safe', 'segments': []})
    result = parse_transcript_response(payload)
    assert result.fullText == 'safe'
