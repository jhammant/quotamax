// Cross-platform lookup of the Claude Code OAuth access token. The token is
// read-only for this tool: it is never logged, stored, or transmitted anywhere
// except the Anthropic usage endpoint.
//
// Lookup order:
//   1. CLAUDE_CODE_OAUTH_TOKEN env var (raw access token)
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

export function readOAuth() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN, subscriptionType: null };
  }
  const oauth = fromKeychain() ?? fromCredentialsFile();
  if (!oauth?.accessToken) {
    throw new Error(
      'No Claude Code credentials found. Sign in to Claude Code first (the token is read from the macOS Keychain or ~/.claude/.credentials.json), or set CLAUDE_CODE_OAUTH_TOKEN.',
    );
  }
  return oauth;
}
