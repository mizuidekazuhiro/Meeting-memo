from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Literal


QualityStatus = Literal['pass', 'retry', 'reject']

REPETITION_LIMIT = 8
MIN_SENTENCES_FOR_UNIQUE_RATIO = 20
MIN_UNIQUE_SENTENCE_RATIO = 0.25
MIN_DURATION_FOR_DENSITY_CHECK_SEC = 180
MIN_CHARACTERS_PER_MINUTE = 20
MIN_DURATION_FOR_TEXT_LENGTH_CHECK_SEC = 60
MIN_TEXT_LENGTH = 20

_SENTENCE_PATTERN = re.compile(r'[^。！？.!?।॥\n]+(?:[。！？.!?।॥]+|(?=\n|$))')
_SPEAKER_PREFIX_PATTERN = re.compile(r'^\s*\[[^\]]+\]\s*')
_NORMALIZATION_PATTERN = re.compile(r'[\W_]+', flags=re.UNICODE)


@dataclass(frozen=True)
class TranscriptQualityMetrics:
    text_length: int
    sentence_count: int
    unique_sentence_count: int
    unique_sentence_ratio: float
    max_exact_sentence_repetitions: int
    max_normalized_sentence_repetitions: int
    characters_per_minute: float
    japanese_punctuation_count: int
    english_punctuation_count: int
    hindi_punctuation_count: int

    def to_log_dict(self) -> dict[str, int | float]:
        return {
            'textLength': self.text_length,
            'sentenceCount': self.sentence_count,
            'uniqueSentenceCount': self.unique_sentence_count,
            'uniqueSentenceRatio': round(self.unique_sentence_ratio, 4),
            'maxExactSentenceRepetitions': self.max_exact_sentence_repetitions,
            'maxNormalizedSentenceRepetitions': self.max_normalized_sentence_repetitions,
            'charactersPerMinute': round(self.characters_per_minute, 2),
            'japanesePunctuationCount': self.japanese_punctuation_count,
            'englishPunctuationCount': self.english_punctuation_count,
            'hindiPunctuationCount': self.hindi_punctuation_count,
        }


@dataclass(frozen=True)
class TranscriptQualityEvaluation:
    status: QualityStatus
    reasons: tuple[str, ...]
    metrics: TranscriptQualityMetrics

    @property
    def has_excessive_repetition(self) -> bool:
        return any(
            reason in {'exact_sentence_repetition', 'normalized_sentence_repetition', 'low_unique_sentence_ratio'}
            for reason in self.reasons
        )

    @property
    def has_only_low_text_density(self) -> bool:
        return bool(self.reasons) and all(
            reason in {'low_characters_per_minute', 'too_few_characters'}
            for reason in self.reasons
        )

    def to_log_dict(self) -> dict[str, object]:
        return {
            'qualityStatus': self.status,
            'qualityReasons': list(self.reasons),
            **self.metrics.to_log_dict(),
        }


def _extract_sentences(text: str) -> list[str]:
    return [match.group(0).strip() for match in _SENTENCE_PATTERN.finditer(text) if match.group(0).strip()]


def _normalize_sentence(sentence: str) -> str:
    without_speaker = _SPEAKER_PREFIX_PATTERN.sub('', sentence)
    normalized = unicodedata.normalize('NFKC', without_speaker).casefold()
    return _NORMALIZATION_PATTERN.sub('', normalized)


def evaluate_transcript_quality(text: str, duration_sec: float) -> TranscriptQualityEvaluation:
    text = text or ''
    text_length = len(re.sub(r'\s+', '', text))
    sentences = _extract_sentences(text)
    exact_sentences = [re.sub(r'\s+', ' ', sentence).strip() for sentence in sentences]
    normalized_sentences = [normalized for sentence in sentences if (normalized := _normalize_sentence(sentence))]

    exact_counts = Counter(exact_sentences)
    normalized_counts = Counter(normalized_sentences)
    sentence_count = len(normalized_sentences)
    unique_sentence_count = len(normalized_counts)
    unique_sentence_ratio = unique_sentence_count / sentence_count if sentence_count else 1.0
    characters_per_minute = text_length / (duration_sec / 60) if duration_sec > 0 else float(text_length)

    metrics = TranscriptQualityMetrics(
        text_length=text_length,
        sentence_count=sentence_count,
        unique_sentence_count=unique_sentence_count,
        unique_sentence_ratio=unique_sentence_ratio,
        max_exact_sentence_repetitions=max(exact_counts.values(), default=0),
        max_normalized_sentence_repetitions=max(normalized_counts.values(), default=0),
        characters_per_minute=characters_per_minute,
        japanese_punctuation_count=len(re.findall(r'[。！？]', text)),
        english_punctuation_count=len(re.findall(r'[.!?]', text)),
        hindi_punctuation_count=len(re.findall(r'[।॥]', text)),
    )

    reject_reasons: list[str] = []
    if metrics.max_exact_sentence_repetitions >= REPETITION_LIMIT:
        reject_reasons.append('exact_sentence_repetition')
    if (
        metrics.max_normalized_sentence_repetitions >= REPETITION_LIMIT
        and 'exact_sentence_repetition' not in reject_reasons
    ):
        reject_reasons.append('normalized_sentence_repetition')
    if (
        metrics.sentence_count >= MIN_SENTENCES_FOR_UNIQUE_RATIO
        and metrics.unique_sentence_ratio < MIN_UNIQUE_SENTENCE_RATIO
    ):
        reject_reasons.append('low_unique_sentence_ratio')
    if reject_reasons:
        return TranscriptQualityEvaluation(status='reject', reasons=tuple(reject_reasons), metrics=metrics)

    retry_reasons: list[str] = []
    if (
        duration_sec >= MIN_DURATION_FOR_DENSITY_CHECK_SEC
        and metrics.characters_per_minute < MIN_CHARACTERS_PER_MINUTE
    ):
        retry_reasons.append('low_characters_per_minute')
    if duration_sec >= MIN_DURATION_FOR_TEXT_LENGTH_CHECK_SEC and metrics.text_length < MIN_TEXT_LENGTH:
        retry_reasons.append('too_few_characters')
    if retry_reasons:
        return TranscriptQualityEvaluation(status='retry', reasons=tuple(retry_reasons), metrics=metrics)

    return TranscriptQualityEvaluation(status='pass', reasons=(), metrics=metrics)
