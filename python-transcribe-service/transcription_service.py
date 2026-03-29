from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from openai import OpenAI

from config import SETTINGS
from ffmpeg_utils import ChunkPlanEntry, build_chunk_plan, ffprobe_metadata, run_ffmpeg_chunk, validate_chunk
from logging_utils import get_logger, log_event
from models import TranscriptResult, TranscriptSegment, TranscriptionJobRequest, WorkersCallbackPayload

logger = get_logger()
DIARIZATION_MODEL = 'gpt-4o-transcribe-diarize'
DIARIZED_RESPONSE_FORMAT = 'diarized_json'


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


def parse_transcript_response(payload: dict[str, Any]) -> TranscriptResult:
    if not isinstance(payload, dict):
        log_event(logger, 'warning', 'unexpected transcription response container', responseType=type(payload).__name__, rawResponse=repr(payload))
        payload = {'raw': payload}

    segments_raw = payload.get('diarized_segments') or payload.get('segments') or []
    if not isinstance(segments_raw, list):
        log_event(
            logger,
            'warning',
            'unexpected transcription segments format',
            responseType=type(segments_raw).__name__,
            rawResponse=repr(payload),
        )
        segments_raw = []

    segments: list[TranscriptSegment] = []
    for seg in segments_raw:
        if not isinstance(seg, dict):
            log_event(logger, 'warning', 'unexpected segment entry format', segmentType=type(seg).__name__, rawSegment=repr(seg))
            continue
        text = (seg.get('text') or '').strip()
        if not text:
            continue
        start_value = seg.get('start_ms') if seg.get('start_ms') is not None else seg.get('start')
        end_value = seg.get('end_ms') if seg.get('end_ms') is not None else seg.get('end')
        start_ms = int(start_value if seg.get('start_ms') is not None else float(start_value or 0) * 1000) if start_value is not None else None
        end_ms = int(end_value if seg.get('end_ms') is not None else float(end_value or 0) * 1000) if end_value is not None else None
        segments.append(TranscriptSegment(
            speaker=str(seg.get('speaker') or seg.get('speaker_label') or seg.get('speaker_id') or 'speaker_unknown'),
            startMs=start_ms,
            endMs=end_ms,
            text=text,
        ))
    full_text = (payload.get('text') or payload.get('transcript') or '').strip() or '\n'.join(f'[{seg.speaker}] {seg.text}' for seg in segments)
    return TranscriptResult(fullText=full_text, segments=segments, raw=payload)


def normalize_transcription_response(response: Any) -> dict[str, Any]:
    if isinstance(response, dict):
        log_event(
            logger,
            'debug',
            'normalizing transcription response',
            responseType=type(response).__name__,
            hasModelDump=hasattr(response, 'model_dump'),
            dumpedType=type(response).__name__,
            dumpedPreview=repr(response)[:1000],
        )
        return response

    has_model_dump = hasattr(response, 'model_dump')
    dumped = response.model_dump() if has_model_dump else response
    log_event(
        logger,
        'debug',
        'normalizing transcription response',
        responseType=type(response).__name__,
        hasModelDump=has_model_dump,
        dumpedType=type(dumped).__name__,
        dumpedPreview=repr(dumped)[:1000],
    )

    if isinstance(dumped, dict):
        return dumped

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
        full_texts.append(result.fullText)
        raw_parts.append(result.raw)
        for seg in result.segments:
            merged_segments.append(
                TranscriptSegment(
                    speaker=seg.speaker,
                    startMs=(seg.startMs + chunk.start_offset_ms) if seg.startMs is not None else None,
                    endMs=(seg.endMs + chunk.start_offset_ms) if seg.endMs is not None else None,
                    text=seg.text,
                )
            )
    return TranscriptResult(fullText='\n\n'.join(t.strip() for t in full_texts if t.strip()), segments=merged_segments, raw=raw_parts)


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

    def transcribe_file(self, file_path: Path, language_hint: str | None, chunk_index: int, audio_format: str) -> TranscriptResult:
        chunking_strategy = self._get_diarization_chunking_strategy()
        try:
            with file_path.open('rb') as handle:
                response = self.openai.audio.transcriptions.create(
                    model=DIARIZATION_MODEL,
                    file=handle,
                    response_format=DIARIZED_RESPONSE_FORMAT,
                    language=language_hint,
                    chunking_strategy=chunking_strategy,
                )
        except Exception as exc:  # noqa: BLE001
            status_code = getattr(exc, 'status_code', None)
            error_text = str(exc)
            log_event(
                logger,
                'error',
                'openai transcription failed',
                model=DIARIZATION_MODEL,
                response_format=DIARIZED_RESPONSE_FORMAT,
                chunking_strategy=chunking_strategy,
                chunkIndex=chunk_index,
                fileName=file_path.name,
                audioFormat=audio_format,
                responseStatus=status_code,
                responseText=error_text,
            )
            raise TranscriptionProcessingError(
                f'Transcription request failed for chunk {chunk_index}: {error_text}',
                source='openai',
                chunk_index=chunk_index,
                external_status_code=status_code,
                context={
                    'model': DIARIZATION_MODEL,
                    'response_format': DIARIZED_RESPONSE_FORMAT,
                    'chunking_strategy': chunking_strategy,
                    'file_name': file_path.name,
                    'audio_format': audio_format,
                },
            ) from exc

        has_model_dump = hasattr(response, 'model_dump')
        dumped = response.model_dump() if has_model_dump else response
        log_event(
            logger,
            'debug',
            'openai transcription response received',
            model=DIARIZATION_MODEL,
            response_format=DIARIZED_RESPONSE_FORMAT,
            chunking_strategy=chunking_strategy,
            chunkIndex=chunk_index,
            responseType=type(response).__name__,
            hasModelDump=has_model_dump,
            dumpedType=type(dumped).__name__,
            dumpedPreview=repr(dumped)[:1000],
        )
        try:
            payload = normalize_transcription_response(response)
        except RuntimeError as exc:
            raise TranscriptionProcessingError(str(exc), source='openai_response', chunk_index=chunk_index) from exc
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
                        model=DIARIZATION_MODEL,
                        response_format=DIARIZED_RESPONSE_FORMAT,
                        chunking_strategy=SETTINGS.diarization_chunking_strategy,
                        audioFormat=ext,
                        validationPassed=ok,
                        details=details,
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
                        log_event(
                            logger,
                            'error',
                            'chunk transcription failed',
                            recordingId=job.recordingId,
                            chunkIndex=chunk.chunk_index,
                            model=DIARIZATION_MODEL,
                            response_format=DIARIZED_RESPONSE_FORMAT,
                            chunking_strategy=SETTINGS.diarization_chunking_strategy,
                            error=str(exc),
                            errorSource=exc.source,
                        )
                        if index == 0 and fmt == 'm4a' and should_fallback(exc.external_status_code or 500, str(exc)):
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
