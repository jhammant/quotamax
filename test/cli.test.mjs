import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

describe('package metadata', () => {
  test('uses npm-normalized bin metadata for the quotamax command', () => {
    assert.equal(pkg.name, 'quotamax');
    assert.deepEqual(pkg.bin, { quotamax: 'src/cli.mjs' });
  });
});

describe('cli version flag', () => {
  test('--version prints package version without loading quota data', () => {
    const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), pkg.version);
  });

  test('-v prints package version', () => {
    const result = spawnSync(process.execPath, [cli, '-v'], { encoding: 'utf8' });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), pkg.version);
  });
});
