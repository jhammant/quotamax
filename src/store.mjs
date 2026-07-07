// Local state under XDG directories: quota snapshots (the trend history) and
// the transcript-aggregate cache. Contains usage numbers only — never tokens
// or message content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function xdg(envVar, fallback) {
  const base = process.env[envVar] || path.join(os.homedir(), ...fallback);
  const dir = path.join(base, 'quotamax');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const CACHE_DIR = xdg('XDG_CACHE_HOME', ['.cache']);
export const STATE_DIR = xdg('XDG_STATE_HOME', ['.local', 'state']);
export const CONFIG_DIR = xdg('XDG_CONFIG_HOME', ['.config']);

const SNAPSHOTS = path.join(STATE_DIR, 'snapshots.jsonl');
const CONFIG = path.join(CONFIG_DIR, 'config.json');

export function recordSnapshot(quota) {
  fs.appendFileSync(SNAPSHOTS, JSON.stringify(quota) + '\n');
}

export function readSnapshots() {
  let raw;
  try {
    raw = fs.readFileSync(SNAPSHOTS, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Optional user config: {"planMonthlyCost": 100, "currency": "GBP"}
export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

export { CONFIG as CONFIG_PATH };
