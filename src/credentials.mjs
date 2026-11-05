// Cross-platform lookup of the Claude Code OAuth access token. The token is
// read-only for this tool: it is never logged, stored, or transmitted anywhere
// except the Anthropic usage endpoint.
//
// Lookup order:
//   1. CLAUDE_CODE_OAUTH_TOKEN env var (raw access token), except inside a
//      claude-work session (CLAUDE_WORK_ACCOUNT=1): there it holds the second
//      account's inference-only token, which the usage endpoint refuses and
//      which isn't the main account anyway, so it is skipped
//   2. macOS Keychain item "Claude Code-credentials" (written by Claude Code)
//   3. ~/.claude/.credentials.json (Linux/Windows Claude Code credential store)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return JSON.parse(raw).claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function fromCredentialsFile() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    return JSON.parse(raw).claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

// The stores are injectable so tests can stand in for the Keychain and the
// credentials file without touching the real ones.
export function readOAuth({ env = process.env, keychain = fromKeychain, credentialsFile = fromCredentialsFile } = {}) {
  const workSession = env.CLAUDE_WORK_ACCOUNT === '1';
  if (env.CLAUDE_CODE_OAUTH_TOKEN && !workSession) {
    return { accessToken: env.CLAUDE_CODE_OAUTH_TOKEN, subscriptionType: null };
  }
  const oauth = keychain() ?? credentialsFile();
  if (!oauth?.accessToken) {
    throw new Error(
      workSession
        ? 'No Claude Code credentials found for the main account. Inside claude-work, CLAUDE_CODE_OAUTH_TOKEN is the second account\'s token and is ignored; sign in to Claude Code with the main account (the token is read from the macOS Keychain or ~/.claude/.credentials.json).'
        : 'No Claude Code credentials found. Sign in to Claude Code first (the token is read from the macOS Keychain or ~/.claude/.credentials.json), or set CLAUDE_CODE_OAUTH_TOKEN.',
    );
  }
  return oauth;
}
