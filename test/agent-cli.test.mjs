// `quotamax agent` end to end, offline: a temp HOME and XDG dirs, a fresh
// on-disk quota cache (so no credentials are read and no usage request is
// made), snapshots for the burn rate, no transcripts (a flat weekday rhythm)
// and a blank DeepSeek key so the backstop makes no request either.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const HOUR = 3.6e6;

// snapshots: [[hoursAgo, weeklyPercent], ...]; the weekly reset is 72h away.
function runAgent({ weekly, snapshots, flags = ['--json'] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-agent-'));
  const dir = (...parts) => {
    const full = path.join(root, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };
  const state = dir('state', 'quotamax');
  const now = Date.now();
  const quota = {
    at: new Date(now).toISOString(),
    subscription: 'max',
    session: { percent: 10, resetsAt: new Date(now + 2 * HOUR).toISOString() },
    weekly: { percent: weekly, resetsAt: new Date(now + 72 * HOUR).toISOString() },
    scoped: [],
  };
  fs.writeFileSync(path.join(state, 'quota-cache.json'), JSON.stringify({ fetchedAt: now, quota }));
  const lines = snapshots.map(([hoursAgo, percent]) =>
    JSON.stringify({ at: new Date(now - hoursAgo * HOUR).toISOString(), weekly: { percent } }),
  );
  fs.writeFileSync(path.join(state, 'snapshots.jsonl'), lines.join('\n') + '\n');
  const env = {
    PATH: process.env.PATH,
    HOME: dir('home'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: dir('cache'),
    XDG_CONFIG_HOME: dir('config'),
    DEEPSEEK_API_KEY: ' ',
  };
  return spawnSync(process.execPath, [cli, 'agent', ...flags], { env, encoding: 'utf8' });
}

describe('quotamax agent --json forecast', () => {
  test('burning 24 pts/day with 50% left and 72h to go: runs out in ~50h', () => {
    const res = runAgent({ weekly: 50, snapshots: [[20, 30], [0.05, 50]] });
    assert.equal(res.status, 0, res.stderr);
    const { forecast } = JSON.parse(res.stdout);
    assert.equal(forecast.runsOut, true);
    assert.equal(forecast.shapedEndPercent, 100);
    assert.ok(Math.abs(forecast.exhaustsInHours - 50) < 1, `got ${forecast.exhaustsInHours}`);
  });

  test('burning ~10 pts/day from 20%: ends near 49%, never runs out', () => {
    const res = runAgent({ weekly: 20, snapshots: [[20, 12], [0.05, 20]] });
    assert.equal(res.status, 0, res.stderr);
    const { forecast, headroom } = JSON.parse(res.stdout);
    assert.equal(headroom, 'abundant');
    assert.deepEqual(Object.keys(forecast).sort(), ['exhaustsInHours', 'runsOut', 'shapedEndPercent']);
    assert.equal(forecast.runsOut, false);
    assert.equal(forecast.exhaustsInHours, null);
    assert.ok(Math.abs(forecast.shapedEndPercent - 49) < 1, `got ${forecast.shapedEndPercent}`);
  });

  test('--line hook mode still prints its one line', () => {
    const res = runAgent({ weekly: 20, snapshots: [[0.05, 20]], flags: ['--line'] });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^Claude quota headroom: abundant/);
  });
});
