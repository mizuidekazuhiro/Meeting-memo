from app.service import parse_transcript_response, should_fallback


def test_should_fallback_only_for_4xx_file_errors():
    assert should_fallback(400, 'Audio file might be corrupted or unsupported')
    assert not should_fallback(500, 'unsupported')


def test_parse_diarized_payload():
    result = parse_transcript_response({
        'text': 'hello',
        'diarized_segments': [
            {'speaker': 'spk1', 'start': 0.0, 'end': 1.0, 'text': 'hello'},
        ],
    })
    assert result.fullText == 'hello'
    assert result.segments[0].speaker == 'spk1'
    assert result.segments[0].startMs == 0
    assert result.segments[0].endMs == 1000
