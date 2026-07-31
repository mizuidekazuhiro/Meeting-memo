from __future__ import annotations

import main
import retaining_transcription_service as retaining
from transcript_quality import TranscriptQualityEvaluation


class _ArchivableRepetitionEvaluation:
    """Route repetition-only quality rejects into the existing archive path.

    The retaining service already preserves low-confidence retry output while
    excluding it from summary/review input. This adapter keeps the original
    quality status, reasons, and metrics visible, but prevents sentence
    repetition from terminating the entire recording after WAV+Auto retry.
    """

    def __init__(self, original: TranscriptQualityEvaluation) -> None:
        self._original = original

    @property
    def status(self):
        return self._original.status

    @property
    def reasons(self):
        return self._original.reasons

    @property
    def metrics(self):
        return self._original.metrics

    @property
    def warnings(self):
        return (*self._original.warnings, 'retained_low_confidence_after_repetition')

    @property
    def has_excessive_repetition(self) -> bool:
        return False

    @property
    def has_only_low_text_density(self) -> bool:
        # The retaining service uses this branch for archive-only chunks. The
        # original reasons remain unchanged, so the transcript marker still
        # identifies exact/normalized repetition rather than low density.
        return True

    def to_log_dict(self) -> dict[str, object]:
        payload = self._original.to_log_dict()
        payload['qualityWarnings'] = list(self.warnings)
        payload['retainedAsLowConfidence'] = True
        return payload


if not getattr(retaining.evaluate_transcript_quality, '_retains_repetition_as_low_confidence', False):
    _base_evaluate_transcript_quality = retaining.evaluate_transcript_quality

    def _evaluate_transcript_quality_for_archive(text: str, duration_sec: float):
        evaluation = _base_evaluate_transcript_quality(text, duration_sec)
        if evaluation.has_excessive_repetition:
            return _ArchivableRepetitionEvaluation(evaluation)
        return evaluation

    setattr(_evaluate_transcript_quality_for_archive, '_retains_repetition_as_low_confidence', True)
    retaining.evaluate_transcript_quality = _evaluate_transcript_quality_for_archive


# Keep the existing API/routes/job-state implementation and replace only the
# transcription service used by background jobs.
main.service = retaining.RetainingTranscriptionService()
app = main.app
