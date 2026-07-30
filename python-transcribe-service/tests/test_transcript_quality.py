from transcript_quality import evaluate_transcript_quality


def test_repeated_japanese_sentence_is_rejected():
    evaluation = evaluate_transcript_quality('確認して対応します。' * 8, duration_sec=120)

    assert evaluation.status == 'reject'
    assert evaluation.has_excessive_repetition
    assert evaluation.metrics.max_normalized_sentence_repetitions == 8
    assert evaluation.metrics.japanese_punctuation_count == 8


def test_repeated_english_sentence_is_rejected():
    evaluation = evaluate_transcript_quality('We will follow up. ' * 8, duration_sec=120)

    assert evaluation.status == 'reject'
    assert evaluation.has_excessive_repetition
    assert evaluation.metrics.max_exact_sentence_repetitions == 8
    assert evaluation.metrics.english_punctuation_count == 8


def test_repeated_hindi_sentence_is_rejected():
    evaluation = evaluate_transcript_quality('हम कल चर्चा करेंगे।' * 8, duration_sec=120)

    assert evaluation.status == 'reject'
    assert evaluation.has_excessive_repetition
    assert evaluation.metrics.max_normalized_sentence_repetitions == 8
    assert evaluation.metrics.hindi_punctuation_count == 8


def test_normal_multilingual_transcript_passes():
    text = (
        'We reviewed the project schedule. '
        'The Mumbai team will share the revised estimate tomorrow. '
        'हमने आपूर्ति योजना पर चर्चा की।'
        '水出さんの名前と日本側の担当者名は原文どおり残します。'
    )

    evaluation = evaluate_transcript_quality(text, duration_sec=120)

    assert evaluation.status == 'pass'
    assert evaluation.metrics.unique_sentence_ratio == 1.0
    assert evaluation.metrics.english_punctuation_count == 2
    assert evaluation.metrics.hindi_punctuation_count == 1
    assert evaluation.metrics.japanese_punctuation_count == 1


def test_low_density_transcript_requests_retry():
    evaluation = evaluate_transcript_quality('Short note.', duration_sec=180)

    assert evaluation.status == 'retry'
    assert evaluation.has_only_low_text_density
    assert 'low_characters_per_minute' in evaluation.reasons
    assert 'too_few_characters' in evaluation.reasons
