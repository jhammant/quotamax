import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel } from '../src/store.mjs';
import { claudeWorkProvider } from '../src/providers/claude-account.mjs';

const config = { accounts: { claude: { label: 'Claude (me@example.com)' }, 'claude-work': { label: '  Claude (work@example.com) ' } } };

test('accountLabel uses the configured name, trimmed', () => {
  assert.equal(accountLabel('claude', 'Claude', config), 'Claude (me@example.com)');
  assert.equal(accountLabel('claude-work', 'Claude (work)', config), 'Claude (work@example.com)');
});

test('accountLabel falls back when the account is unnamed or the name is blank', () => {
  assert.equal(accountLabel('codex', 'Codex', config), 'Codex');
  assert.equal(accountLabel('claude', 'Claude', { accounts: { claude: { label: '   ' } } }), 'Claude');
  assert.equal(accountLabel('claude', 'Claude', {}), 'Claude');
});

test('the work provider keeps its default label when none is configured', async () => {
  const p = await claudeWorkProvider({ token: null });
  assert.ok(p.label.startsWith('Claude'));
});
