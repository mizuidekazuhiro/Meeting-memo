import type { TranscriptResult } from '../types';

export function mergeTranscriptResultsInOrder(results: Array<{ chunkIndex: number; startOffsetMs: number; transcript: TranscriptResult }>): TranscriptResult {
  const ordered = [...results].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const segments = ordered.flatMap(({ startOffsetMs, transcript }) => transcript.segments.map((segment) => ({
    ...segment,
    startMs: segment.startMs !== undefined ? segment.startMs + startOffsetMs : undefined,
    endMs: segment.endMs !== undefined ? segment.endMs + startOffsetMs : undefined,
  })));
  const fullText = ordered.map((entry) => entry.transcript.fullText.trim()).filter(Boolean).join('\n\n');
  return { fullText, segments, raw: ordered.map((entry) => entry.transcript.raw) };
}
