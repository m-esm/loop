import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProposalChoice, parseTaskProposal } from '../src';

const valid = {
  question: 'Which store?',
  options: ['SQLite', 'Postgres'],
  pick: 'SQLite',
  why: 'one file, no service',
};

test('parseTaskProposal accepts a complete proposal and rejects malformed ones', () => {
  const ok = parseTaskProposal(JSON.stringify(valid));
  assert.deepEqual(ok, { proposal: valid });
  const badJson = parseTaskProposal('{');
  assert.ok('error' in badJson);
  assert.match(badJson.error, /Malformed proposal/);
  const emptyOptions = parseTaskProposal(JSON.stringify({ ...valid, options: [] }));
  assert.ok('error' in emptyOptions);
  assert.match(emptyOptions.error, /options must not be empty/);
  const badPick = parseTaskProposal(JSON.stringify({ ...valid, pick: 'MySQL' }));
  assert.ok('error' in badPick);
  assert.match(badPick.error, /pick is not one of the options/);
  const missing = parseTaskProposal(JSON.stringify({ question: 'x', options: ['a'], pick: 'a' }));
  assert.ok('error' in missing);
  assert.match(missing.error, /missing why/);
  assert.equal(isProposalChoice(valid, 'SQLite'), true);
  assert.equal(isProposalChoice(valid, 'discuss'), true);
  assert.equal(isProposalChoice(valid, 'reject'), true);
  assert.equal(isProposalChoice(valid, 'MySQL'), false);
});
