// readOAuth lookup order, including inside a claude-work session. The Keychain
// and the credentials file are injected: no real Keychain, no real ~/.claude,
// and the only tokens in play are fakes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readOAuth } from '../src/credentials.mjs';

const MAIN = { accessToken: 'main-account-token', subscriptionType: 'max' };
const WORK_TOKEN = 'work-account-inference-token';

function stores({ keychain = null, file = null } = {}) {
  const read = [];
  return {
    read,
    keychain: () => {
      read.push('keychain');
      return keychain;
    },
    credentialsFile: () => {
      read.push('file');
      return file;
    },
  };
}

describe('readOAuth', () => {
  test('CLAUDE_CODE_OAUTH_TOKEN wins outside claude-work, and no store is read', () => {
    const s = stores({ keychain: MAIN });
    const oauth = readOAuth({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }, ...s });
    assert.deepEqual(oauth, { accessToken: 'env-token', subscriptionType: null });
    assert.deepEqual(s.read, []);
  });

  test('no env token: the Keychain, then the credentials file', () => {
    assert.equal(readOAuth({ env: {}, ...stores({ keychain: MAIN }) }), MAIN);
    assert.equal(readOAuth({ env: {}, ...stores({ file: MAIN }) }), MAIN);
  });

  test('inside claude-work the env token is the second account, so the main one comes from the Keychain', () => {
    const s = stores({ keychain: MAIN });
    const oauth = readOAuth({ env: { CLAUDE_WORK_ACCOUNT: '1', CLAUDE_CODE_OAUTH_TOKEN: WORK_TOKEN }, ...s });
    assert.equal(oauth, MAIN);
    assert.deepEqual(s.read, ['keychain']);
  });

  test('inside claude-work with no Keychain item, the credentials file is used', () => {
    const s = stores({ file: MAIN });
    const oauth = readOAuth({ env: { CLAUDE_WORK_ACCOUNT: '1', CLAUDE_CODE_OAUTH_TOKEN: WORK_TOKEN }, ...s });
    assert.equal(oauth, MAIN);
    assert.deepEqual(s.read, ['keychain', 'file']);
  });

  test('inside claude-work with no main-account credentials: says why, never falls back to the work token', () => {
    const env = { CLAUDE_WORK_ACCOUNT: '1', CLAUDE_CODE_OAUTH_TOKEN: WORK_TOKEN };
    assert.throws(
      () => readOAuth({ env, ...stores() }),
      (e) => /claude-work/.test(e.message) && /ignored/.test(e.message) && !e.message.includes(WORK_TOKEN),
    );
  });

  test('only CLAUDE_WORK_ACCOUNT=1 marks a claude-work session', () => {
    for (const value of ['0', 'true', '', ' 1']) {
      const oauth = readOAuth({ env: { CLAUDE_WORK_ACCOUNT: value, CLAUDE_CODE_OAUTH_TOKEN: 'env-token' }, ...stores({ keychain: MAIN }) });
      assert.equal(oauth.accessToken, 'env-token', `CLAUDE_WORK_ACCOUNT=${JSON.stringify(value)}`);
    }
  });
});
