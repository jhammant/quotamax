// User-declared quota priorities, persisted in ~/.config/quotamax/priorities.json:
//   reservations — "save N% of the weekly quota for <name>": treated as
//     already-spent by the agent advisor (and honored by external burners
//     that read this file, e.g. TokenMaxing lowers its ramp target).
//   priorities — "<name> matters": advisory weighting for tools that choose
//     what to build/spend on.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './store.mjs';

export const PRIORITIES_PATH = path.join(CONFIG_DIR, 'priorities.json');

export function loadPriorities() {
  try {
    const p = JSON.parse(fs.readFileSync(PRIORITIES_PATH, 'utf8'));
    // Preserve unknown keys (e.g. override) — earlier this stripped them, so
    // any reserve/prioritize write silently erased the manual override.
    return { ...p, reservations: p.reservations ?? [], priorities: p.priorities ?? [] };
  } catch {
    return { reservations: [], priorities: [] };
  }
}

export function savePriorities(p) {
  fs.writeFileSync(PRIORITIES_PATH, JSON.stringify(p, null, 2) + '\n');
}

export function activeReservations(p = loadPriorities(), nowMs = Date.now()) {
  return p.reservations.filter((r) => !r.until || Date.parse(r.until) > nowMs);
}

export function reservedPercent(p = loadPriorities(), nowMs = Date.now()) {
  return Math.min(
    90,
    activeReservations(p, nowMs).reduce((s, r) => s + (Number(r.percent) || 0), 0),
  );
}

export function reserve({ percent, name, note, until }) {
  const p = loadPriorities();
  p.reservations = p.reservations.filter((r) => r.name !== name);
  p.reservations.push({ name, percent: Number(percent), note: note ?? null, until: until ?? null, createdAt: new Date().toISOString() });
  savePriorities(p);
  return p;
}

export function unreserve(name) {
  const p = loadPriorities();
  p.reservations = p.reservations.filter((r) => r.name !== name);
  savePriorities(p);
  return p;
}

export function prioritize(name, note) {
  const p = loadPriorities();
  p.priorities = p.priorities.filter((r) => r.name !== name);
  p.priorities.push({ name, note: note ?? null, createdAt: new Date().toISOString() });
  savePriorities(p);
  return p;
}

export function deprioritize(name) {
  const p = loadPriorities();
  p.priorities = p.priorities.filter((r) => r.name !== name);
  savePriorities(p);
  return p;
}

// Manual headroom override: force the advice level (e.g. run everything on a
// simpler model for the next few hours) regardless of measured quota.
export function setOverride(level, hours, note) {
  const p = loadPriorities();
  p.override = {
    level,
    note: note ?? null,
    until: hours ? new Date(Date.now() + hours * 3.6e6).toISOString() : null,
    createdAt: new Date().toISOString(),
  };
  savePriorities(p);
  return p.override;
}

export function clearOverride() {
  const p = loadPriorities();
  delete p.override;
  savePriorities(p);
}

export function activeOverride(p = loadPriorities(), nowMs = Date.now()) {
  const o = p.override;
  if (!o) return null;
  if (o.until && Date.parse(o.until) <= nowMs) return null;
  return o;
}
