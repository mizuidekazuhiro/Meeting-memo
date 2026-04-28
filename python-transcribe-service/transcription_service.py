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
SUPPORTED_LANGUAGES = {'ja', 'en'}


class TranscriptionProcessingError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        source: str,
        chunk_index: int | None = None,
        external_status_code: int | None = None,
        context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.source = source
        self.chunk_index = chunk_index
        self.external_status_code = external_status_code
        self.context = context or {}


def should_fallback(status_code: int, error_text: str) -> bool:
    text = error_text.lower()
    return SETTINGS.enable_audio_fallback and 400 <= status_code < 500 and any(token in text for token in ('corrupted', 'unsupported', 'file'))


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
            ) from exc
        if not isinstance(parsed, dict):
            raise TranscriptionProcessingError(
                f'Transcription response JSON must be an object, got {type(parsed).__name__}',
                source='openai_response',
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
        language, fallback_reason, invalid_hint, invalid_env = self._resolve_language(language_hint)
        if invalid_hint or invalid_env:
            log_event(
                logger,
                'warning',
                'invalid language hint/env for transcription; fallback applied',
                requestLanguageHint=language_hint,
                envLanguage=SETTINGS.transcribe_language,
                invalidLanguageHint=invalid_hint,
                invalidEnvLanguage=invalid_env,
                resolvedLanguage=language,
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
            language=language,
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
                response = self.openai.audio.transcriptions.create(
                    model=model,
                    file=handle,
                    response_format=DIARIZED_RESPONSE_FORMAT if diarization_enabled else 'json',
                    language=language,
                    **({'chunking_strategy': chunking_strategy} if diarization_enabled and chunking_strategy else {}),
                    **({'prompt': JAPANESE_TRANSCRIBE_PROMPT if language == 'ja' else ENGLISH_TRANSCRIBE_PROMPT} if not diarization_enabled else {}),
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
            raise TranscriptionProcessingError(str(exc), source='openai_response', chunk_index=chunk_index) from exc

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
            language=language,
            promptEnabled=not diarization_enabled,
            responseStatus=response_status,
            topLevelKeys=sorted(payload.keys()),
            segmentsCount=len(segments_raw) if isinstance(segments_raw, list) else 0,
            fullTextLength=len(full_text),
            hasUsage=payload.get('usage') is not None,
            payloadPreview=preview_text(payload),
            transcriptLength=len(parse_transcript_response(payload).fullText),
            fallbackOccurred=False,
        )
        return parse_transcript_response(payload)

    def process(self, job: TranscriptionJobRequest, source_bytes: bytes) -> WorkersCallbackPayload:
        with tempfile.TemporaryDirectory(dir=SETTINGS.tmp_dir) as tmp_dir:
            source_path = Path(tmp_dir) / job.fileName
            source_path.write_bytes(source_bytes)

            source_meta = ffprobe_metadata(source_path)
            if source_meta.duration_sec <= 0:
                raise TranscriptionProcessingError('invalid source: duration must be > 0', source='validation')
            plan = build_chunk_plan(source_meta.duration_sec, job.sourceBytes or len(source_bytes))
            results: list[tuple[ChunkPlanEntry, TranscriptResult]] = []

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
                    audioFormat=SETTINGS.primary_audio_format,
                )
                formats = [SETTINGS.primary_audio_format]
                if SETTINGS.enable_audio_fallback and SETTINGS.fallback_audio_format != SETTINGS.primary_audio_format:
                    formats.append(SETTINGS.fallback_audio_format)

                transcribed = False
                for index, fmt in enumerate(formats):
                    ext = 'm4a' if fmt == 'm4a' else 'wav'
                    output = Path(tmp_dir) / f'part-{chunk.chunk_index + 1:03d}.{ext}'
                    run_ffmpeg_chunk(source_path, output, chunk.start_offset_ms / 1000, chunk.estimated_duration_sec, fmt)
                    ok, details = validate_chunk(output, ext)
                    log_event(
                        logger,
                        'info',
                        'chunk prepared',
                        recordingId=job.recordingId,
                        chunkIndex=chunk.chunk_index,
                        chunkCount=chunk.chunk_count,
                        startOffsetMs=chunk.start_offset_ms,
                        endOffsetMs=chunk.end_offset_ms,
                        model=DIARIZATION_MODEL,
                        response_format=DIARIZED_RESPONSE_FORMAT if SETTINGS.transcribe_diarization_enabled else 'json',
                        chunking_strategy=SETTINGS.diarization_chunking_strategy,
                        diarizationEnabled=SETTINGS.transcribe_diarization_enabled,
                        language=job.request.languageHint if job.request and job.request.languageHint else SETTINGS.transcribe_language,
                        promptEnabled=not SETTINGS.transcribe_diarization_enabled,
                        audioFormat=ext,
                        ffprobe={
                            'duration': details.get('duration'),
                            'codec': details.get('codec'),
                            'sample_rate': details.get('sample_rate'),
                            'channels': details.get('channels'),
                            'mime_type': details.get('mime_type'),
                        },
                        validationPassed=ok,
                    )
                    if not ok:
                        raise TranscriptionProcessingError(
                            f'chunk validation failed: {details}',
                            source='validation',
                            chunk_index=chunk.chunk_index,
                            context={'file_name': output.name, 'audio_format': ext},
                        )

                    try:
                        result = self.transcribe_file(output, job.request.languageHint if job.request else None, chunk.chunk_index, ext)
                        results.append((chunk, result))
                        transcribed = True
                        break
                    except TranscriptionProcessingError as exc:
                        fallback_candidate = should_fallback(exc.external_status_code or 500, str(exc))
                        log_event(
                            logger,
                            'error',
                            'chunk transcription failed',
                            recordingId=job.recordingId,
                            chunkIndex=chunk.chunk_index,
                            model=DIARIZATION_MODEL if SETTINGS.transcribe_diarization_enabled else STANDARD_MODEL,
                            response_format=DIARIZED_RESPONSE_FORMAT if SETTINGS.transcribe_diarization_enabled else 'json',
                            chunking_strategy=SETTINGS.diarization_chunking_strategy,
                            error=str(exc),
                            errorSource=exc.source,
                            responseStatus=exc.external_status_code,
                            fallbackCandidate=fallback_candidate,
                        )
                        if index == 0 and fmt == 'm4a' and fallback_candidate:
                            continue
                        raise

                if not transcribed:
                    raise TranscriptionProcessingError(
                        f'Unable to transcribe chunk {chunk.chunk_index}',
                        source='openai',
                        chunk_index=chunk.chunk_index,
                    )

            merged = merge_results(results)
            return WorkersCallbackPayload(
                recordingId=job.recordingId,
                dropboxFileId=job.dropboxFileId or '',
                dropboxPathLower=job.dropboxPathLower,
                fileName=job.fileName,
                sourceDurationSec=source_meta.duration_sec,
                transcript=merged,
            )
