from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

from config import SETTINGS

MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024


@dataclass
class SourceMetadata:
    duration_sec: float
    codec: str
    sample_rate: int | None
    channels: int | None
    container: str


@dataclass
class ChunkPlanEntry:
    chunk_index: int
    chunk_count: int
    start_offset_ms: int
    end_offset_ms: int
    estimated_duration_sec: float


def ffprobe_metadata(path: Path) -> SourceMetadata:
    cmd = [SETTINGS.ffprobe_path, '-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_name,sample_rate,channels', '-of', 'json', str(path)]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    stream = (payload.get('streams') or [{}])[0]
    format_info = payload.get('format') or {}
    container = (format_info.get('format_name') or path.suffix.replace('.', '').lower() or 'unknown').split(',')[0]
    return SourceMetadata(
        duration_sec=float(format_info.get('duration') or 0),
        codec=stream.get('codec_name') or 'unknown',
        sample_rate=int(stream['sample_rate']) if stream.get('sample_rate') else None,
        channels=stream.get('channels'),
        container=container,
    )


def build_chunk_plan(duration_sec: float, source_bytes: int | None) -> list[ChunkPlanEntry]:
    effective_target_duration = min(SETTINGS.target_chunk_duration_sec, SETTINGS.max_transcribe_duration_sec)
    by_duration = math.ceil(duration_sec / effective_target_duration)
    by_size = math.ceil((source_bytes or 1) / MAX_TRANSCRIPTION_BYTES)
    chunk_count = max(1, by_duration, by_size)
    if chunk_count == 1:
        return [ChunkPlanEntry(0, 1, 0, math.ceil(duration_sec * 1000), duration_sec)]

    duration_ms = math.ceil(duration_sec * 1000)
    plan: list[ChunkPlanEntry] = []
    for idx in range(chunk_count):
        start = math.floor(duration_ms * idx / chunk_count)
        end = duration_ms if idx == chunk_count - 1 else math.floor(duration_ms * (idx + 1) / chunk_count)
        plan.append(ChunkPlanEntry(idx, chunk_count, start, end, max(0.001, (end - start) / 1000)))
    return plan


def run_ffmpeg_chunk(source: Path, output: Path, start_offset_sec: float, duration_sec: float, fmt: str) -> None:
    if fmt == 'm4a':
        args = ['-vn', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-movflags', '+faststart']
    elif fmt == 'wav':
        args = ['-vn', '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1']
    else:
        raise RuntimeError(f'Unsupported audio format: {fmt}')
    cmd = [SETTINGS.ffmpeg_path, '-y', '-ss', str(start_offset_sec), '-i', str(source), '-t', str(duration_sec), *args, str(output)]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def validate_chunk(path: Path, expected_ext: str) -> tuple[bool, dict[str, object]]:
    if not path.exists() or path.stat().st_size <= 0:
        return False, {'error': 'bytes must be > 0'}
    if path.stat().st_size > MAX_TRANSCRIPTION_BYTES:
        return False, {'error': 'bytes must be <= 24 MB', 'bytes': path.stat().st_size}
    meta = ffprobe_metadata(path)
    if meta.duration_sec <= 0:
        return False, {'error': 'duration must be > 0'}
    if not meta.codec or not meta.container:
        return False, {'error': 'codec/container missing'}
    ext = path.suffix.replace('.', '').lower()
    if ext != expected_ext:
        return False, {'error': 'extension mismatch', 'extension': ext, 'expected': expected_ext}
    if expected_ext == 'm4a' and not (meta.container.startswith('mov') or meta.container.startswith('mp4') or meta.container == 'ipod'):
        return False, {'error': 'container mismatch for m4a', 'container': meta.container}
    if expected_ext == 'wav' and 'wav' not in meta.container:
        return False, {'error': 'container mismatch for wav', 'container': meta.container}
    mime_type = 'audio/mp4' if expected_ext == 'm4a' else 'audio/wav'
    return True, {
        'duration': meta.duration_sec,
        'codec': meta.codec,
        'container': meta.container,
        'sample_rate': meta.sample_rate,
        'channels': meta.channels,
        'mime_type': mime_type,
    }
