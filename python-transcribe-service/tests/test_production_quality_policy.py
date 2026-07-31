import importlib


def test_production_routes_repetition_rejects_to_low_confidence_archive(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'test')
    monkeypatch.setenv('TRANSCRIBE_DIARIZATION_ENABLED', 'false')
    monkeypatch.setenv('TRANSCRIBE_LANGUAGE', 'auto')

    import config
    import retaining_transcription_service
    import transcription_service

    importlib.reload(config)
    importlib.reload(transcription_service)
    retaining = importlib.reload(retaining_transcription_service)

    import production_app

    importlib.reload(production_app)

    evaluation = retaining.evaluate_transcript_quality(
        'We will confirm the delivery schedule. ' * 8,
        120,
    )

    assert evaluation.status == 'reject'
    assert 'exact_sentence_repetition' in evaluation.reasons
    assert evaluation.has_excessive_repetition is False
    assert evaluation.has_only_low_text_density is True
    assert 'retained_low_confidence_after_repetition' in evaluation.warnings
    assert evaluation.to_log_dict()['retainedAsLowConfidence'] is True
    assert isinstance(production_app.main.service, retaining.RetainingTranscriptionService)
