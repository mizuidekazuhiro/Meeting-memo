// @ts-nocheck
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { filterMyTasksForUserActions } from '../src/lib/processing';

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
  ]);
  assert.deepEqual(result, ['社内で価格条件を確認して回答する']);
});

test('ケースC: 先方側タスクが otherTasks にある想定でも My Tasks には入らない', () => {
  const myTasks = filterMyTasksForUserActions([]);
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
