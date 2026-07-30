from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from config import SETTINGS
from ffmpeg_utils import ChunkPlanEntry, build_chunk_plan, ffprobe_metadata, run_ffmpeg_chunk, validate_chunk
from logging_utils import get_logger, log_event
from models import TranscriptResult, TranscriptSegment, TranscriptionJobRequest, WorkersCallbackPayload
from transcript_quality import evaluate_merged_transcript_quality, evaluate_transcript_quality
from transcription_service import (
    DIARIZATION_MODEL,
    DIARIZED_RESPONSE_FORMAT,
    STANDARD_MODEL,
    TranscriptionProcessingError,
    TranscriptionService,
    merge_results,
    should_fallback,
)

logger = get_logger()


def _format_timestamp(offset_ms: int) -> str:
    total_seconds = max(0, int(offset_ms) // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f'{hours:02d}:{minutes:02d}:{seconds:02d}'


def _trusted_result(result: TranscriptResult, chunk: ChunkPlanEntry) -> TranscriptResult:
    """Keep fullText for archive storage and expose only trusted text as segments.

    The Worker stores transcript.fullText in Dropbox when diarization is disabled,
    while summary/review sanitization reconstructs its input from segments when
    segments are present. Synthetic segments therefore separate archive text from
    trusted memo input without changing the callback schema.
    """
    if result.segments or not result.fullText.strip():
        return result
    return TranscriptResult(
        fullText=result.fullText,
        segments=[
            TranscriptSegment(
                speaker='speaker_unknown',
                startMs=0,
                endMs=max(0, int(round(chunk.estimated_duration_sec * 1000))),
                text=result.fullText.strip(),
            )
        ],
        raw=result.raw,
    )


def _attempt_record(
    *,
    attempt: str,
    audio_format: str,
    language_hint: str | None,
    result: TranscriptResult,
    evaluation: Any,
) -> dict[str, Any]:
    return {
        'attempt': attempt,
        'audioFormat': audio_format,
        'languageHint': language_hint,
        'transcriptText': result.fullText,
        'quality': evaluation.to_log_dict(),
    }


def _quality_summary(attempt: dict[str, Any]) -> str:
    quality = attempt.get('quality') if isinstance(attempt.get('quality'), dict) else {}
    reasons = quality.get('qualityReasons') or []
    reason_text = ', '.join(str(reason) for reason in reasons) if reasons else 'none'
    return (
        f"status={quality.get('qualityStatus', 'unknown')}; "
        f"reasons={reason_text}; "
        f"textLength={quality.get('textLength', 'unknown')}; "
        f"charactersPerMinute={quality.get('charactersPerMinute', 'unknown')}; "
        f"maxExactSentenceRepetitions={quality.get('maxExactSentenceRepetitions', 'unknown')}; "
        f"maxNormalizedSentenceRepetitions={quality.get('maxNormalizedSentenceRepetitions', 'unknown')}"
    )


def _diagnostic_block(entry: dict[str, Any]) -> str:
    chunk_index = int(entry['chunkIndex'])
    start = _format_timestamp(int(entry['startOffsetMs']))
    end = _format_timestamp(int(entry['endOffsetMs']))
    lines = [
        f'## チャンク {chunk_index + 1} ({start}-{end})',
        f"処理結果: {entry['disposition']}",
    ]
    for attempt_index, attempt in enumerate(entry.get('attempts', []), start=1):
        lines.extend([
            '',
            f"### 試行 {attempt_index}: {attempt.get('attempt', 'unknown')}",
            f"音声形式: {attempt.get('audioFormat', 'unknown')}",
            f"言語指定: {attempt.get('languageHint') or '未指定'}",
            f"品質判定: {_quality_summary(attempt)}",
            '文字起こし:',
            str(attempt.get('transcriptText') or '[文字起こし結果なし]'),
        ])
    return '\n'.join(lines)


class RetainingTranscriptionService(TranscriptionService):
    """Transcription pipeline that never silently drops low-density retry output.

    Full archive text contains the selected transcript for every chunk plus an
    appendix with both initial and retry outputs. Summary/review input is limited
    to quality-passed chunks through trusted transcript segments.
    """

    def process(self, job: TranscriptionJobRequest, source_bytes: bytes) -> WorkersCallbackPayload:
        with tempfile.TemporaryDirectory(dir=SETTINGS.tmp_dir) as tmp_dir:
            source_path = Path(tmp_dir) / job.fileName
            source_path.write_bytes(source_bytes)

            try:
                source_meta = ffprobe_metadata(source_path)
            except Exception as exc:  # noqa: BLE001
                raise TranscriptionProcessingError(
                    f'Unable to inspect source audio: {exc}',
                    source='ffmpeg',
                    failure_stage='ffmpeg_chunk_validation',
                ) from exc
            if source_meta.duration_sec <= 0:
                raise TranscriptionProcessingError(
                    'invalid source: duration must be > 0',
                    source='validation',
                    failure_stage='ffmpeg_chunk_validation',
                )
            try:
                plan = build_chunk_plan(source_meta.duration_sec, job.sourceBytes or len(source_bytes))
            except Exception as exc:  # noqa: BLE001
                raise TranscriptionProcessingError(
                    f'Unable to build audio chunk plan: {exc}',
                    source='ffmpeg',
                    failure_stage='ffmpeg_chunk_validation',
                ) from exc

            archive_results: list[tuple[ChunkPlanEntry, TranscriptResult]] = []
            chunk_diagnostics: list[dict[str, Any]] = []
            requested_language_hint = job.request.languageHint if job.request else None
            trusted_chunk_count = 0
            trusted_duration_sec = 0.0
            low_confidence_chunk_count = 0

            for chunk in plan:
                log_event(
                    logger,
                    'info',
                    'transcription chunk started',
                    recordingId=job.recordingId,
                    chunkIndex=chunk.chunk_index,
                    chunkCount=chunk.chunk_count,
                    startOffsetMs=chunk.start_offset_ms,
                    endOffsetMs=chunk.end_offset_ms,
                    audioFormat='m4a',
                    language=requested_language_hint,
                )

                chunk_handled = False
                attempts: list[dict[str, Any]] = []
                for attempt_index, (audio_format, language_hint, attempt) in enumerate((
                    ('m4a', requested_language_hint, 'initial_m4a_requested_language'),
                    ('wav', 'auto', 'quality_retry_wav_auto'),
                )):
                    output = Path(tmp_dir) / f'part-{chunk.chunk_index + 1:03d}.{audio_format}'
                    retry_failure_stage = 'wav_retry' if attempt_index > 0 else 'ffmpeg_chunk_validation'
                    try:
                        run_ffmpeg_chunk(
                            source_path,
                            output,
                            chunk.start_offset_ms / 1000,
                            chunk.estimated_duration_sec,
                            audio_format,
                        )
                        ok, details = validate_chunk(output, audio_format)
                    except Exception as exc:  # noqa: BLE001
                        raise TranscriptionProcessingError(
                            f'ffmpeg/chunk validation failed for chunk {chunk.chunk_index}: {exc}',
                            source='ffmpeg',
                            failure_stage=retry_failure_stage,
                            chunk_index=chunk.chunk_index,
                            context={'file_name': output.name, 'audio_format': audio_format},
                        ) from exc
                    self._log_chunk_prepared(
                        job=job,
                        chunk=chunk,
                        audio_format=audio_format,
                        language_hint=language_hint,
                        attempt=attempt,
                        validation_passed=ok,
                        details=details,
                    )
                    if not ok:
                        raise TranscriptionProcessingError(
                            f'chunk validation failed: {details}',
                            source='validation',
                            failure_stage=retry_failure_stage,
                            chunk_index=chunk.chunk_index,
                            context={'file_name': output.name, 'audio_format': audio_format},
                        )

                    try:
                        result = self.transcribe_file(
                            output,
                            language_hint,
                            chunk.chunk_index,
                            audio_format,
                        )
                    except TranscriptionProcessingError as exc:
                        fallback_candidate = (
                            attempt_index == 0
                            and audio_format == 'm4a'
                            and should_fallback(exc.external_status_code or 500, str(exc))
                        )
                        log_event(
                            logger,
                            'error',
                            'chunk transcription failed',
                            recordingId=job.recordingId,
                            chunkIndex=chunk.chunk_index,
                            model=DIARIZATION_MODEL if SETTINGS.transcribe_diarization_enabled else STANDARD_MODEL,
                            response_format=DIARIZED_RESPONSE_FORMAT if SETTINGS.transcribe_diarization_enabled else 'json',
                            chunking_strategy=(
                                self._get_diarization_chunking_strategy()
                                if SETTINGS.transcribe_diarization_enabled
                                else None
                            ),
                            audioFormat=audio_format,
                            language=self._resolve_language(language_hint)[0],
                            error=str(exc),
                            errorSource=exc.source,
                            responseStatus=exc.external_status_code,
                            fallbackCandidate=fallback_candidate,
                        )
                        if fallback_candidate:
                            log_event(
                                logger,
                                'warning',
                                'transcription retry selected',
                                recordingId=job.recordingId,
                                chunkIndex=chunk.chunk_index,
                                retryReason='openai_file_error',
                                fromAudioFormat='m4a',
                                toAudioFormat='wav',
                                retryLanguage='auto',
                            )
                            continue
                        if attempt_index > 0:
                            raise TranscriptionProcessingError(
                                f'WAV Auto retry failed for chunk {chunk.chunk_index}: {exc}',
                                source=exc.source,
                                failure_stage='wav_retry',
                                chunk_index=chunk.chunk_index,
                                external_status_code=exc.external_status_code,
                                context=exc.context,
                            ) from exc
                        raise

                    evaluation = evaluate_transcript_quality(
                        result.fullText,
                        self._quality_duration(details, chunk),
                    )
                    self._log_quality(
                        job=job,
                        chunk=chunk,
                        attempt=attempt,
                        audio_format=audio_format,
                        evaluation=evaluation,
                    )
                    attempts.append(_attempt_record(
                        attempt=attempt,
                        audio_format=audio_format,
                        language_hint=language_hint,
                        result=result,
                        evaluation=evaluation,
                    ))

                    if evaluation.status == 'pass':
                        archive_results.append((chunk, _trusted_result(result, chunk)))
                        trusted_chunk_count += 1
                        trusted_duration_sec += chunk.estimated_duration_sec
                        chunk_handled = True
                        if attempt_index > 0:
                            chunk_diagnostics.append({
                                'chunkIndex': chunk.chunk_index,
                                'startOffsetMs': chunk.start_offset_ms,
                                'endOffsetMs': chunk.end_offset_ms,
                                'disposition': 'accepted_after_wav_auto_retry',
                                'attempts': attempts,
                            })
                        break

                    if attempt_index == 0:
                        log_event(
                            logger,
                            'warning',
                            'transcription retry selected',
                            recordingId=job.recordingId,
                            chunkIndex=chunk.chunk_index,
                            retryReason='quality_gate',
                            qualityStatus=evaluation.status,
                            qualityReasons=list(evaluation.reasons),
                            fromAudioFormat='m4a',
                            toAudioFormat='wav',
                            retryLanguage='auto',
                        )
                        continue

                    if evaluation.has_excessive_repetition:
                        log_event(
                            logger,
                            'error',
                            'transcription quality hard failure after retry',
                            recordingId=job.recordingId,
                            chunkIndex=chunk.chunk_index,
                            audioFormat='wav',
                            language='auto',
                            **evaluation.to_log_dict(),
                        )
                        raise TranscriptionProcessingError(
                            f'Transcript quality rejected chunk {chunk.chunk_index} after WAV Auto retry',
                            source='quality',
                            failure_stage='transcript_quality',
                            chunk_index=chunk.chunk_index,
                            context={
                                **evaluation.to_log_dict(),
                                'retryAttempt': 'wav_auto',
                            },
                        )

                    if evaluation.has_only_low_text_density:
                        reason_text = ', '.join(evaluation.reasons) or 'low_text_density'
                        low_confidence_text = '\n'.join([
                            (
                                f'[低信頼区間 {_format_timestamp(chunk.start_offset_ms)}-'
                                f'{_format_timestamp(chunk.end_offset_ms)}｜音声要確認｜理由: {reason_text}]'
                            ),
                            result.fullText.strip() or '[文字起こし結果なし]',
                        ])
                        archive_results.append((
                            chunk,
                            TranscriptResult(
                                fullText=low_confidence_text,
                                segments=[],
                                raw=result.raw,
                            ),
                        ))
                        low_confidence_chunk_count += 1
                        chunk_diagnostics.append({
                            'chunkIndex': chunk.chunk_index,
                            'startOffsetMs': chunk.start_offset_ms,
                            'endOffsetMs': chunk.end_offset_ms,
                            'disposition': 'retained_low_confidence_excluded_from_summary',
                            'attempts': attempts,
                        })
                        log_event(
                            logger,
                            'warning',
                            'transcription chunk retained as low confidence',
                            recordingId=job.recordingId,
                            chunkIndex=chunk.chunk_index,
                            startOffsetMs=chunk.start_offset_ms,
                            endOffsetMs=chunk.end_offset_ms,
                            audioFormat='wav',
                            language='auto',
                            excludedFromSummary=True,
                            **evaluation.to_log_dict(),
                        )
                        chunk_handled = True
                        break

                    raise TranscriptionProcessingError(
                        f'Transcript quality remained invalid for chunk {chunk.chunk_index} after WAV Auto retry',
                        source='quality',
                        failure_stage='transcript_quality',
                        chunk_index=chunk.chunk_index,
                        context={
                            **evaluation.to_log_dict(),
                            'retryAttempt': 'wav_auto',
                        },
                    )

                if not chunk_handled:
                    raise TranscriptionProcessingError(
                        f'Unable to transcribe chunk {chunk.chunk_index}',
                        source='openai',
                        failure_stage='openai_transcription',
                        chunk_index=chunk.chunk_index,
                    )

            try:
                merged = merge_results(archive_results)
            except Exception as exc:  # noqa: BLE001
                raise TranscriptionProcessingError(
                    f'Unable to merge transcript chunks: {exc}',
                    source='merge',
                    failure_stage='merged_transcript',
                ) from exc

            trusted_text = '\n\n'.join(
                segment.text.strip()
                for segment in merged.segments
                if segment.text and segment.text.strip()
            )
            if trusted_chunk_count > 0:
                merged_evaluation = evaluate_merged_transcript_quality(
                    trusted_text,
                    trusted_duration_sec,
                    trusted_chunk_count,
                )
                merged_log_level = (
                    'error'
                    if merged_evaluation.status != 'pass'
                    else 'warning'
                    if merged_evaluation.warnings
                    else 'info'
                )
                log_event(
                    logger,
                    merged_log_level,
                    'merged trusted transcript structural quality check',
                    recordingId=job.recordingId,
                    chunkCount=len(plan),
                    trustedChunkCount=trusted_chunk_count,
                    lowConfidenceChunkCount=low_confidence_chunk_count,
                    trustedDurationSec=trusted_duration_sec,
                    archiveFullTextLength=len(merged.fullText),
                    trustedTextLength=len(trusted_text),
                    **merged_evaluation.to_log_dict(),
                )
                if merged_evaluation.status != 'pass':
                    raise TranscriptionProcessingError(
                        'Merged trusted transcript failed structural quality check',
                        source='quality',
                        failure_stage='merged_transcript',
                        context=merged_evaluation.to_log_dict(),
                    )
            else:
                # Keep archive delivery successful while preventing low-confidence
                # text from becoming memo input when every chunk was low confidence.
                merged.segments.append(TranscriptSegment(
                    speaker='quality_notice',
                    startMs=0,
                    endMs=None,
                    text='信頼できる文字起こし区間がありません。保存済み全文を音声と照合してください。',
                ))
                log_event(
                    logger,
                    'warning',
                    'merged transcript contains only low confidence chunks',
                    recordingId=job.recordingId,
                    chunkCount=len(plan),
                    lowConfidenceChunkCount=low_confidence_chunk_count,
                    archiveFullTextLength=len(merged.fullText),
                    excludedFromSummary=True,
                )

            if chunk_diagnostics:
                appendix = '\n\n'.join(_diagnostic_block(entry) for entry in chunk_diagnostics)
                merged.fullText = '\n\n'.join(filter(None, [
                    merged.fullText.strip(),
                    '# 文字起こし再試行・低信頼区間記録\n\n' + appendix,
                ]))

            merged.raw = {
                'selectedParts': merged.raw,
                'chunkDiagnostics': chunk_diagnostics,
                'trustedChunkCount': trusted_chunk_count,
                'lowConfidenceChunkCount': low_confidence_chunk_count,
                'archiveIncludesAllRetryOutputs': True,
                'summaryUsesTrustedSegmentsOnly': True,
            }

            return WorkersCallbackPayload(
                recordingId=job.recordingId,
                dropboxFileId=job.dropboxFileId or '',
                dropboxPathLower=job.dropboxPathLower,
                fileName=job.fileName,
                sourceDurationSec=source_meta.duration_sec,
                transcript=merged,
            )
