import type { Env, InterviewInsights, TranscriptResult } from '../types';
import { HttpError } from './http';

const OPENAI_API = 'https://api.openai.com/v1';

export async function transcribeWithDiarization(env: Env, audio: Blob, fileName: string, languageHint?: string): Promise<TranscriptResult> {
  const form = new FormData();
  form.append('file', audio, fileName);
  form.append('model', env.OPENAI_MODEL_TRANSCRIBE ?? 'gpt-4o-transcribe');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (languageHint) {
    form.append('language', languageHint);
  }
  form.append('prompt', 'Create a diarized transcript. Label speakers consistently as speaker_1, speaker_2, etc.');

  const response = await fetch(`${OPENAI_API}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new HttpError('Transcription request failed.', 502, await response.text());
  }

  const payload = (await response.json()) as {
    text?: string;
    segments?: Array<{ speaker?: string; start?: number; end?: number; text?: string }>;
  };

  const segments = (payload.segments ?? []).map((segment) => ({
    speaker: segment.speaker ?? 'speaker_unknown',
    startMs: segment.start !== undefined ? Math.round(segment.start * 1000) : undefined,
    endMs: segment.end !== undefined ? Math.round(segment.end * 1000) : undefined,
    text: segment.text ?? '',
  }));

  return {
    fullText: payload.text ?? segments.map((segment) => `[${segment.speaker}] ${segment.text}`).join('\n'),
    segments,
    raw: payload,
  };
}

export async function summarizeInterview(env: Env, transcript: TranscriptResult): Promise<InterviewInsights> {
  const response = await fetch(`${OPENAI_API}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL_SUMMARIZE ?? 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'You extract structured interview notes.',
                'Return strict JSON with keys: summary, myTasks, otherTasks, ambiguities.',
                'myTasks and otherTasks must be string arrays.',
                'If task ownership is unclear, do not guess and instead explain it in ambiguities.',
              ].join(' '),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: transcript.fullText,
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'interview_insights',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['summary', 'myTasks', 'otherTasks', 'ambiguities'],
            properties: {
              summary: { type: 'string' },
              myTasks: { type: 'array', items: { type: 'string' } },
              otherTasks: { type: 'array', items: { type: 'string' } },
              ambiguities: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new HttpError('Summary generation failed.', 502, await response.text());
  }

  const payload = (await response.json()) as { output_text?: string };
  if (!payload.output_text) {
    throw new HttpError('Summary response did not include output_text.', 502, payload);
  }
  const parsed = JSON.parse(payload.output_text) as Omit<InterviewInsights, 'raw'>;
  return { ...parsed, raw: payload };
}
