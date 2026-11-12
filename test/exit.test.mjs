import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const exitModule = fileURLToPath(new URL('../src/exit.mjs', import.meta.url));

test('exitAfterFlush delivers everything written to a piped stdout, then exits with the code', () => {
  const script = `import(${JSON.stringify(exitModule)}).then(({ exitAfterFlush }) => {
    console.log('x'.repeat(200000));
    exitAfterFlush(3);
  });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.equal(result.stdout.length, 200001);
});
