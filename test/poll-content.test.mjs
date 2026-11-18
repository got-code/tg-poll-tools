import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollQuestion, pollAnswers } from '../src/domain/poll-content.ts';

test('only a final space-separated positive part number is removed from questions', () => {
  for (const title of ['Question', ' Question ', 'Question #1', 'Question #12  ', 'Question\t#3'])
    assert.equal(pollQuestion(title), 'Question');

  for (const title of [
    'Question#1',
    'Question #0',
    'Question #-1',
    'Question #1 today',
    'Question #1.5',
    'Question #',
    '#1',
  ])
    assert.equal(pollQuestion(title), title);

  assert.notEqual(pollQuestion('Question #1'), pollQuestion('question #2'));
  assert.notEqual(pollQuestion('Two  words #1'), pollQuestion('Two words #2'));
});

test('answer union trims edges and preserves first appearance, case and internal whitespace', () => {
  const answers = Object.freeze([' A ', 'B', 'A', 'a', 'Two  words', 'Two words', ' B ']);
  assert.deepEqual(pollAnswers(answers), ['A', 'B', 'a', 'Two  words', 'Two words']);
  assert.deepEqual(answers, [' A ', 'B', 'A', 'a', 'Two  words', 'Two words', ' B ']);
});
