from __future__ import annotations

import json
import re
import tempfile
from http import HTTPStatus
from pathlib import Path
from typing import Any

from openai import OpenAI

from config import SETTINGS
from ffmpeg_utils import ChunkPlanEntry, build_chunk_plan, ffprobe_metadata, run_ffmpeg_chunk, validate_chunk
from logging_utils import get_logger, log_event, preview_text
from models import TranscriptResult, TranscriptSegment, TranscriptionJobRequest, WorkersCallbackPayload
from transcript_quality import (
    TranscriptQualityEvaluation,
    evaluate_merged_transcript_quality,
    evaluate_transcript_quality,
)

logger = get_logger()
DIARIZATION_MODEL = 'gpt-4o-transcribe-diarize'
STANDARD_MODEL = 'gpt-4o-transcribe'
DIARIZED_RESPONSE_FORMAT = 'diarized_json'
JAPANESE_TRANSCRIBE_PROMPT = '\n'.join([
    'これは日本語の社内会議音声です。',
    '明確な英単語・略語・会社名以外は日本語として文字起こししてください。',
    '相槌、聞き取り不能な断片、意味のない英語風フレーズは無理に英語化しないでください。',
    '業界用語、会社名、略称、数値が多く含まれます。',
])
ENGLISH_TRANSCRIBE_PROMPT = '\n'.join([
    'This is an English business meeting audio.',
    'Transcribe in English.',
    'Preserve company names, abbreviations, numbers, technical terms, and business context.',
    'Do not invent unclear content. Mark unclear parts as [inaudible] where necessary.',
])
AUTO_TRANSCRIBE_PROMPT = '\n'.join([
    'This recording may contain English, Indian English, Hindi, and Japanese names.',
    'Preserve the language actually spoken in each passage.',
    'Do not force all speech into English.',
    'Do not invent, guess, or repeat unclear content.',
])
SUPPORTED_LANGUAGES = {'ja', 'en', 'auto'}


class TranscriptionProcessingError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        source: str,
        failure_stage: str | None = None,
        chunk_index: int | None = None,
        external_status_code: int | None = None,
        context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.source = source
        self.failure_stage = failure_stage
        self.chunk_index = chunk_index
        self.external_status_code = external_status_code
        self.context = context or {}


def should_fallback(status_code: int, error_text: str) -> bool:
    text = error_text.lower()
    return SETTINGS.enable_audio_fallback and 400 <= status_code < 500 and any(token in text for token in ('corrupted', 'unsupported', 'file'))


def _prompt_for_language_mode(language_mode: str) -> str:
    if language_mode == 'ja':
        return JAPANESE_TRANSCRIBE_PROMPT
    if language_mode == 'en':
        return ENGLISH_TRANSCRIBE_PROMPT
    return AUTO_TRANSCRIBE_PROMPT


def _coerce_ms(value: Any, *, is_ms: bool) -> int | None:
    if value is None:
        return None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        value = trimmed
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return int(round(numeric if is_ms else numeric * 1000))


def _as_mapping(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if hasattr(value, 'model_dump'):
        dumped = value.model_dump()
        if isinstance(dumped, dict):
            return dumped
    if hasattr(value, '__dict__'):
        as_dict = vars(value)
        if isinstance(as_dict, dict):
            return as_dict
    return None


def parse_transcript_response(payload: dict[str, Any]) -> TranscriptResult:
    if not isinstance(payload, dict):
        log_event(
            logger,
            'warning',
            'unexpected transcription response container',
            responseType=type(payload).__name__,
            payloadPreview=preview_text(payload),
        )
        payload = {'raw': payload}

    segments_raw = payload.get('segments') or payload.get('diarized_segments') or []
    if not isinstance(segments_raw, list):
        log_event(
            logger,
            'warning',
            'unexpected transcription segments format',
            responseType=type(segments_raw).__name__,
            payloadPreview=preview_text(payload),
        )
        segments_raw = []

    segments: list[TranscriptSegment] = []
    for seg in segments_raw:
        mapped = _as_mapping(seg)
        if not mapped:
            log_event(logger, 'warning', 'unexpected segment entry format', segmentType=type(seg).__name__, rawSegment=preview_text(seg))
            continue
        text = str(mapped.get('text') or '').strip()
        if not text:
            continue
        start_ms = _coerce_ms(mapped.get('start_ms'), is_ms=True)
        if start_ms is None:
            start_ms = _coerce_ms(mapped.get('start'), is_ms=False)
        end_ms = _coerce_ms(mapped.get('end_ms'), is_ms=True)
        if end_ms is None:
            end_ms = _coerce_ms(mapped.get('end'), is_ms=False)

        segments.append(
            TranscriptSegment(
                speaker=str(mapped.get('speaker') or mapped.get('speaker_label') or mapped.get('speaker_id') or 'speaker_unknown'),
                startMs=start_ms,
                endMs=end_ms,
                text=text,
            )
        )

    diarization_enabled = SETTINGS.transcribe_diarization_enabled
    full_text = str(payload.get('text') or payload.get('transcript') or '').strip()
    if not full_text:
        if diarization_enabled:
            full_text = '\n'.join(f'[{seg.speaker}] {seg.text}' for seg in segments)
        else:
            full_text = '\n\n'.join(seg.text for seg in segments)
    return TranscriptResult(fullText=full_text, segments=segments, raw=payload)


def normalize_transcription_response(response: Any) -> dict[str, Any]:
    if isinstance(response, dict):
        return response

    dumped = response.model_dump() if hasattr(response, 'model_dump') else response
    if isinstance(dumped, dict):
        return dumped

    mapped = _as_mapping(dumped)
    if mapped:
        return mapped

    if isinstance(dumped, str):
        try:
            parsed = json.loads(dumped)
        except json.JSONDecodeError as exc:
            raise TranscriptionProcessingError(
                f'Unable to parse transcription response as JSON string: {exc}',
                source='openai_response',
                failure_stage='openai_transcription',
            ) from exc
        if not isinstance(parsed, dict):
            raise TranscriptionProcessingError(
                f'Transcription response JSON must be an object, got {type(parsed).__name__}',
                source='openai_response',
                failure_stage='openai_transcription',
            )
        return parsed

    raise RuntimeError(
        f'Unexpected transcription response type: {type(response).__name__} (dumped={type(dumped).__name__})'
    )


def merge_results(results: list[tuple[ChunkPlanEntry, TranscriptResult]]) -> TranscriptResult:
    ordered = sorted(results, key=lambda item: item[0].chunk_index)
    full_texts: list[str] = []
    merged_segments: list[TranscriptSegment] = []
    raw_parts: list[Any] = []
    for chunk, result in ordered:
        normalized_text = re.sub(r'\n{3,}', '\n\n', result.fullText.strip())
        if normalized_text:
            full_texts.append(normalized_text)
        raw_parts.append(result.raw)

        for seg in result.segments:
            start_ms = (seg.startMs + chunk.start_offset_ms) if seg.startMs is not None else None
            end_ms = (seg.endMs + chunk.start_offset_ms) if seg.endMs is not None else None
            if start_ms is not None and start_ms < 0:
                log_event(logger, 'warning', 'merged segment had negative start timestamp', chunkIndex=chunk.chunk_index, startMs=start_ms)
                start_ms = 0
            if end_ms is not None and end_ms < 0:
                log_event(logger, 'warning', 'merged segment had negative end timestamp', chunkIndex=chunk.chunk_index, endMs=end_ms)
                end_ms = 0
            if start_ms is not None and end_ms is not None and end_ms < start_ms:
                log_event(
                    logger,
                    'warning',
                    'merged segment had inverted timestamps; correcting end to start',
                    chunkIndex=chunk.chunk_index,
                    startMs=start_ms,
                    endMs=end_ms,
                )
                end_ms = start_ms

            merged_segments.append(
                TranscriptSegment(
                    speaker=seg.speaker,
                    startMs=start_ms,
                    endMs=end_ms,
                    text=seg.text,
                )
            )

    merged = TranscriptResult(fullText='\n\n'.join(full_texts), segments=merged_segments, raw=raw_parts)
    log_event(logger, 'info', 'transcript merge completed', mergedSegments=len(merged.segments), mergedFullTextLength=len(merged.fullText))
    return merged


class TranscriptionService:
    def __init__(self) -> None:
        self.openai = OpenAI(api_key=SETTINGS.openai_api_key)

    def _get_diarization_chunking_strategy(self) -> str:
        strategy = SETTINGS.diarization_chunking_strategy.strip()
        if not strategy:
            raise TranscriptionProcessingError(
                'DIARIZATION_CHUNKING_STRATEGY must be configured for diarization model transcription',
                source='configuration',
                failure_stage='openai_transcription',
            )
        return strategy

    def _resolve_language(self, language_hint: str | None) -> tuple[str, str, str | None, str | None]:
        normalized_hint = (language_hint or '').strip().lower()
        normalized_env = (SETTINGS.transcribe_language or '').strip().lower()
        invalid_hint = normalized_hint if normalized_hint and normalized_hint not in SUPPORTED_LANGUAGES else None
        invalid_env = normalized_env if normalized_env and normalized_env not in SUPPORTED_LANGUAGES else None
        if normalized_hint in SUPPORTED_LANGUAGES:
            return normalized_hint, 'request', invalid_hint, invalid_env
        if normalized_env in SUPPORTED_LANGUAGES:
            return normalized_env, 'env', invalid_hint, invalid_env
        return 'ja', 'default', invalid_hint, invalid_env

    def transcribe_file(self, file_path: Path, language_hint: str | None, chunk_index: int, audio_format: str) -> TranscriptResult:
        diarization_enabled = SETTINGS.transcribe_diarization_enabled
        chunking_strategy = self._get_diarization_chunking_strategy() if diarization_enabled else None
        model = DIARIZATION_MODEL if diarization_enabled else STANDARD_MODEL
        language_mode, fallback_reason, invalid_hint, invalid_env = self._resolve_language(language_hint)
        language_parameter = language_mode if language_mode in {'ja', 'en'} else None
        if invalid_hint or invalid_env:
            log_event(
                logger,
                'warning',
                'invalid language hint/env for transcription; fallback applied',
                requestLanguageHint=language_hint,
                envLanguage=SETTINGS.transcribe_language,
                invalidLanguageHint=invalid_hint,
                invalidEnvLanguage=invalid_env,
                resolvedLanguage=language_mode,
            )
        chunk_meta = ffprobe_metadata(file_path)
        log_event(
            logger,
            'info',
            'openai transcription request',
            model=model,
            response_format=DIARIZED_RESPONSE_FORMAT if diarization_enabled else 'json',
            chunking_strategy=chunking_strategy,
            diarizationEnabled=diarization_enabled,
            requestLanguageHint=language_hint,
            envLanguage=SETTINGS.transcribe_language,
            languageFallbackReason=fallback_reason,
            language=language_mode,
            languageParameter=language_parameter,
            promptEnabled=not diarization_enabled,
            languageHint=language_hint,
            chunkIndex=chunk_index,
            fileName=file_path.name,
            audioFormat=audio_format,
            chunkFileSize=file_path.stat().st_size,
            chunkDurationSec=chunk_meta.duration_sec,
        )

        try:
            with file_path.open('rb') as handle:
                # diarized_json is required to obtain speaker-separated segments from gpt-4o-transcribe-diarize.
                # normalize_transcription_response keeps processing stable across SDK response-shape differences.
                request_options: dict[str, Any] = {
                    'model': model,
                    'file': handle,
                    'response_format': DIARIZED_RESPONSE_FORMAT if diarization_enabled else 'json',
                }
                if language_parameter:
                    request_options['language'] = language_parameter
                if diarization_enabled and chunking_strategy:
                    request_options['chunking_strategy'] = chunking_strategy
                if not diarization_enabled:
                    request_options['prompt'] = _prompt_for_language_mode(language_mode)
                response = self.openai.audio.transcriptions.create(
                    **request_options,
                )
        except Exception as exc:  # noqa: BLE001
            status_code = getattr(exc, 'status_code', None)
            error_text = str(exc)
            fallback_candidate = should_fallback(status_code or 500, error_text)
            log_event(
                logger,
                'error',
                'openai transcription failed',
                exceptionClass=type(exc).__name__,
                model=model,
                response_format=DIARIZED_RESPONSE_FORMAT if diarization_enabled else 'json',
                chunking_strategy=chunking_strategy,
                chunkIndex=chunk_index,
                fileName=file_path.name,
                audioFormat=audio_format,
                responseStatus=status_code,
                responseTextPreview=preview_text(error_text),
                fallbackCandidate=fallback_candidate,
            )
            raise TranscriptionProcessingError(
                f'Transcription request failed for chunk {chunk_index}: {error_text}',
                source='openai',
                failure_stage='openai_transcription',
                chunk_index=chunk_index,
                external_status_code=status_code,
                context={
                    'model': model,
                    'response_format': DIARIZED_RESPONSE_FORMAT if diarization_enabled else 'json',
                    'chunking_strategy': chunking_strategy,
                    'file_name': file_path.name,
                    'audio_format': audio_format,
                },
            ) from exc

        try:
            payload = normalize_transcription_response(response)
        except RuntimeError as exc:
            raise TranscriptionProcessingError(
                str(exc),
                source='openai_response',
                failure_stage='openai_transcription',
                chunk_index=chunk_index,
            ) from exc

        response_status = getattr(response, 'status_code', None)
        if response_status is None and hasattr(response, 'response'):
            response_status = getattr(getattr(response, 'response'), 'status_code', None)
        if response_status is None:
            raw_status = payload.get('status_code') or payload.get('status')
            if isinstance(raw_status, int):
                response_status = raw_status
            elif isinstance(raw_status, str) and raw_status.isdigit():
                response_status = int(raw_status)
            elif isinstance(raw_status, str) and raw_status in HTTPStatus.__members__:
                response_status = HTTPStatus[raw_status].value

        segments_raw = payload.get('segments') or payload.get('diarized_segments') or []
        full_text = str(payload.get('text') or payload.get('transcript') or '').strip()
        log_event(
            logger,
            'info',
            'openai transcription response normalized',
            chunkIndex=chunk_index,
            model=model,
            diarizationEnabled=diarization_enabled,
            language=language_mode,
            languageParameter=language_parameter,
            promptEnabled=not diarization_enabled,
            responseStatus=response_status,
            topLevelKeys=sorted(payload.keys()),
            segmentsCount=len(segments_raw) if isinstance(segments_raw, list) else 0,
            fullTextLength=len(full_text),
            hasUsage=payload.get('usage') is not None,
            transcriptLength=len(parse_transcript_response(payload).fullText),
            fallbackOccurred=False,
        )
        return parse_transcript_response(payload)

    def _log_chunk_prepared(
        self,
        *,
        job: TranscriptionJobRequest,
        chunk: ChunkPlanEntry,
        audio_format: str,
        language_hint: str | None,
        attempt: str,
        validation_passed: bool,
        details: dict[str, object],
    ) -> None:
        diarization_enabled = SETTINGS.transcribe_diarization_enabled
        language_mode, fallback_reason, _, _ = self._resolve_language(language_hint)
        language_parameter = language_mode if language_mode in {'ja', 'en'} else None
        log_event(
            logger,
            'info',
            'chunk prepared',
            recordingId=job.recordingId,
            chunkIndex=chunk.chunk_index,
            chunkCount=chunk.chunk_count,
            startOffsetMs=chunk.start_offset_ms,
            endOffsetMs=chunk.end_offset_ms,
            attempt=attempt,
            model=DIARIZATION_MODEL if diarization_enabled else STANDARD_MODEL,
            response_format=DIARIZED_RESPONSE_FORMAT if diarization_enabled else 'json',
            chunking_strategy=self._get_diarization_chunking_strategy() if diarization_enabled else None,
            diarizationEnabled=diarization_enabled,
            requestLanguageHint=language_hint,
            language=language_mode,
            languageParameter=language_parameter,
            languageFallbackReason=fallback_reason,
            promptEnabled=not diarization_enabled,
            audioFormat=audio_format,
            ffprobe={
                'duration': details.get('duration'),
                'codec': details.get('codec'),
                'sample_rate': details.get('sample_rate'),
                'channels': details.get('channels'),
                'mime_type': details.get('mime_type'),
            },
            validationPassed=validation_passed,
        )

    @staticmethod
    def _quality_duration(details: dict[str, object], chunk: ChunkPlanEntry) -> float:
        try:
            duration = float(details.get('duration') or chunk.estimated_duration_sec)
        except (TypeError, ValueError):
            duration = chunk.estimated_duration_sec
        return max(0.001, duration)

    @staticmethod
    def _log_quality(
        *,
        job: TranscriptionJobRequest,
        chunk: ChunkPlanEntry,
        attempt: str,
        audio_format: str,
        evaluation: TranscriptQualityEvaluation,
    ) -> None:
        log_event(
            logger,
            'info' if evaluation.status == 'pass' else 'warning',
            'transcript quality evaluated',
            recordingId=job.recordingId,
            chunkIndex=chunk.chunk_index,
            chunkCount=chunk.chunk_count,
            attempt=attempt,
            audioFormat=audio_format,
            **evaluation.to_log_dict(),
        )

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
            results: list[tuple[ChunkPlanEntry, TranscriptResult]] = []
            requested_language_hint = job.request.languageHint if job.request else None

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
                    if evaluation.status == 'pass':
                        results.append((chunk, result))
                        chunk_handled = True
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
                        log_event(
                            logger,
                            'warning',
                            'transcription chunk skipped as probable silence',
                            recordingId=job.recordingId,
                            chunkIndex=chunk.chunk_index,
                            audioFormat='wav',
                            language='auto',
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
                merged = merge_results(results)
            except Exception as exc:  # noqa: BLE001
                raise TranscriptionProcessingError(
                    f'Unable to merge transcript chunks: {exc}',
                    source='merge',
                    failure_stage='merged_transcript',
                ) from exc
            accepted_duration_sec = sum(chunk.estimated_duration_sec for chunk, _ in results)
            merged_evaluation = evaluate_merged_transcript_quality(
                merged.fullText,
                source_meta.duration_sec,
                len(results),
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
                'merged transcript structural quality check',
                recordingId=job.recordingId,
                chunkCount=len(plan),
                acceptedChunkCount=len(results),
                acceptedDurationSec=accepted_duration_sec,
                **merged_evaluation.to_log_dict(),
            )
            if merged_evaluation.status != 'pass':
                raise TranscriptionProcessingError(
                    'Merged transcript failed structural quality check',
                    source='quality',
                    failure_stage='merged_transcript',
                    context=merged_evaluation.to_log_dict(),
                )

            return WorkersCallbackPayload(
                recordingId=job.recordingId,
                dropboxFileId=job.dropboxFileId or '',
                dropboxPathLower=job.dropboxPathLower,
                fileName=job.fileName,
                sourceDurationSec=source_meta.duration_sec,
                transcript=merged,
            )
