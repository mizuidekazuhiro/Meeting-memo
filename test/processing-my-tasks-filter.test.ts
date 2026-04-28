// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildFinalMemoStats, filterMyTasksForUserActions, sanitizeTranscriptForMemo } from '../src/lib/processing';

test('ケースA: 固有名詞/誤変換などメモ整備タスクは My Tasks から除外される', () => {
  const result = filterMyTasksForUserActions([
    '固有名詞を確認する',
    'Transcriptの誤変換を確認する',
    'Notion本文を補足する',
  ]);
  assert.deepEqual(result, []);
});

test('ケースB: ユーザー側の実務アクションは My Tasks に残る', () => {
  const result = filterMyTasksForUserActions([
    '社内で価格条件を確認して回答する',
    '社内で確認して回答します',
  ]);
  assert.deepEqual(result, ['社内で価格条件を確認して回答する', '社内で確認して回答します']);
});

test('ケースC: 先方側タスクが otherTasks にある想定でも My Tasks には入らない', () => {
  const myTasks = filterMyTasksForUserActions(['先方が資料を送る']);
  const otherTasks = ['先方が資料を送る'];
  assert.deepEqual(myTasks, []);
  assert.deepEqual(otherTasks, ['先方が資料を送る']);
});

test('ケースD: 次回までの提案書作成・送付は My Tasks に残る', () => {
  const result = filterMyTasksForUserActions([
    '次回までに提案書ドラフトを作成して送る',
  ]);
  assert.deepEqual(result, ['次回までに提案書ドラフトを作成して送る']);
});

test('ケースE: 所有者不明の抽象タスクは My Tasks に入れない', () => {
  const result = filterMyTasksForUserActions([
    '確認が必要',
  ]);
  assert.deepEqual(result, []);
});

test('英語風ノイズと話者ラベルを完成版メモ入力から除去する', () => {
  const sanitized = sanitizeTranscriptForMemo({
    fullText: '[A] Well I don\'t know',
    segments: [
      { speaker: 'A', text: '[A] Well I don\'t know' },
      { speaker: 'B', text: '[B] AWS と DC の件は継続' },
    ],
    raw: {},
  } as any);
  assert.equal(sanitized.transcript.fullText.includes('[A]'), false);
  assert.equal(sanitized.transcript.fullText.includes('Well'), false);
  assert.equal(sanitized.transcript.fullText.includes('AWS'), true);
});

test('完成版メモの統計でテーマ数・アクション数・数値を抽出する', () => {
  const stats = buildFinalMemoStats([
    '# 完成版 面談メモ',
    '## 1. 王子製鉄',
    '売上 30%',
    '## Next Steps / アクション',
    '| # | アクション | 担当 | 補足 |',
    '|---|---|---|---|',
    '| 1 | 資料更新 | 不明 | 5月中 |',
  ].join('\n'));
  assert.equal(stats.extractedThemeCount, 1);
  assert.equal(stats.extractedActionCount, 1);
  assert.ok(stats.numericCount >= 2);
});

test('language=en の場合は英語本文を過剰に除去しない', () => {
  const sanitized = sanitizeTranscriptForMemo({
    fullText: '[A] Well I do not know the exact figure',
    segments: [{ speaker: 'A', text: '[A] Well I do not know the exact figure' }],
    raw: {},
  } as any, 'en');
  assert.equal(sanitized.transcript.fullText.includes('Well'), true);
});
