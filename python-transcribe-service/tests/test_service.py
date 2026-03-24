from pathlib import Path

from app.models import TranscriptResult, TranscriptSegment
from app.service import ChunkPlanEntry, build_chunk_plan, merge_results, validate_chunk


def test_chunk_plan_generation():
    plan = build_chunk_plan(1800, 1024)
    assert len(plan) == 3
    assert [p.start_offset_ms for p in plan] == [0, 600000, 1200000]


def test_chunk_plan_no_split():
    plan = build_chunk_plan(120, 1024)
    assert len(plan) == 1
    assert plan[0].chunk_count == 1


def test_transcript_merge_order_by_chunk_index():
    merged = merge_results([
        (ChunkPlanEntry(1, 2, 600000, 1200000, 600), TranscriptResult(fullText='second', segments=[TranscriptSegment(speaker='spk2', startMs=0, endMs=500, text='second')], raw={'idx': 1})),
        (ChunkPlanEntry(0, 2, 0, 600000, 600), TranscriptResult(fullText='first', segments=[TranscriptSegment(speaker='spk1', startMs=0, endMs=500, text='first')], raw={'idx': 0})),
    ])
    assert merged.fullText == 'first\n\nsecond'
    assert [s.startMs for s in merged.segments] == [0, 600000]


def test_validation_rejects_empty_chunk(tmp_path: Path):
    p = tmp_path / 'bad.wav'
    p.write_bytes(b'')
    ok, details = validate_chunk(p, 'wav')
    assert not ok
    assert 'bytes must be > 0' in details['error']
