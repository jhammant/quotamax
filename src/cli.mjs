#!/usr/bin/env node
// quotamax — Claude Code quota intelligence.
//
//   quotamax [status]     live limits, pace, projections
//   quotamax trend        ASCII burn-up chart + week forecast + baseline
//   quotamax history      daily/weekly usage and API-cost history
//   quotamax costs        what your usage would cost as API traffic
//   quotamax agent        machine-readable capacity advice for agents
//
// Global flags: --json (machine output), --quiet (agent: headroom word only)
import { getQuota } from './quota.mjs';
import { readSnapshots, loadConfig } from './store.mjs';
import { loadUsage, byDayModel, dailyOutput } from './transcripts.mjs';
import { burnStats, metricsFor, renderChart, usageComparison, sparkline, weekdayProfile, shapedProjection } from './trends.mjs';
import { costUSD, fmtUSD, fmtTokens, priceFor } from './pricing.mjs';
import { advise, exitCodeFor } from './agent.mjs';
import {
  loadPriorities, activeReservations, reservedPercent,
  reserve, unreserve, prioritize, deprioritize, PRIORITIES_PATH,
} from './priorities.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const cmd = args.find((a) => !a.startsWith('--')) ?? 'status';
const asJson = flags.has('--json');
const HOUR = 3.6e6;

function bar(percent, width = 28) {
  const filled = Math.round((Math.min(percent, 100) / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${Math.round(percent)}%`;
}

function fmtReset(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return 'window not started';
  const h = (Date.parse(iso) - Date.now()) / HOUR;
  const when = new Date(iso).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `resets ${when} (${h < 48 ? h.toFixed(1) + 'h' : (h / 24).toFixed(1) + 'd'})`;
}

// Cached data under ~30 min is business as usual; only genuinely old data warns.
function cachedNote(quota) {
  if (!quota.stale) return '';
  const min = Math.round((quota.cacheAgeMs ?? 0) / 60e3);
  return min > 30 ? `  (⚠ data ${min}m old: ${quota.staleReason})` : `  (cached ${min}m ago)`;
}

function weekPoints(quota) {
  const resetMs = Date.parse(quota.weekly.resetsAt) || Date.now() + 168 * HOUR;
  const weekStart = resetMs - 168 * HOUR;
  const points = readSnapshots()
    .map((s) => ({ t: Date.parse(s.at), v: s.weekly?.percent }))
    .filter((p) => p.t >= weekStart && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (!points.some((p) => p.t >= Date.now() - 30 * 60e3)) {
    points.push({ t: Date.now(), v: quota.weekly.percent });
  }
  return { points, resetMs };
}

async function status() {
  const quota = await getQuota();
  const m = metricsFor(quota);
  if (asJson) {
    console.log(JSON.stringify({ quota, metrics: m }, null, 2));
    return;
  }
  console.log(`quotamax — plan: ${quota.subscription ?? 'unknown'}${cachedNote(quota)}\n`);
  console.log(`  5h session   ${bar(quota.session.percent)}  ${fmtReset(quota.session.resetsAt)}`);
  console.log(`  weekly (all) ${bar(quota.weekly.percent)}  ${fmtReset(quota.weekly.resetsAt)}`);
  for (const s of quota.scoped) {
    console.log(`  weekly ${s.label.padEnd(6).slice(0, 6)}${bar(s.percent)}  ${fmtReset(s.resetsAt)}`);
  }
  console.log(`\n  pace: expected ${m.expectedPercent.toFixed(0)}% by now → ${m.paceDelta <= 0 ? `${Math.abs(m.paceDelta).toFixed(0)} pts behind (headroom)` : `${m.paceDelta.toFixed(0)} pts ahead`}`);
  console.log(`  run \`quotamax trend\` for the forecast, \`quotamax costs\` for API-cost equivalence`);
}

async function trend() {
  const quota = await getQuota();
  const now = Date.now();
  const { points, resetMs } = weekPoints(quota);
  const s = burnStats(points, resetMs, now);
  const cache = await loadUsage({ log: asJson ? () => {} : (msg) => console.log(`  [${msg}]`) });
  const daily = dailyOutput(cache);
  const cmp = usageComparison(daily, resetMs, now);
  const intensity = weekdayProfile(daily, now);
  const shapedEnd = shapedProjection(s.current, s.ratePerDay, intensity, now, resetMs);

  if (asJson) {
    console.log(JSON.stringify({ quota, stats: s, comparison: cmp, weekdayIntensity: intensity, shapedProjectedEnd: shapedEnd }, null, 2));
    return;
  }
  console.log(`quotamax — week trend & forecast${cachedNote(quota)}`);
  console.log(`day ${(s.elapsedH / 24).toFixed(1)} of 7 · resets ${new Date(resetMs).toLocaleString()}\n`);
  console.log(renderChart(points, resetMs, now, s.ratePerDay));
  console.log('');
  console.log(`  now:        ${s.current}% used · expected ${s.expected.toFixed(0)}% · ${s.paceDelta <= 0 ? Math.abs(s.paceDelta).toFixed(0) + ' pts BEHIND pace' : s.paceDelta.toFixed(0) + ' pts AHEAD of pace'}`);
  console.log(`  burn rate:  ${s.ratePerDay.toFixed(1)} pts/day (recent) · ${s.neededPerDay.toFixed(1)} pts/day would use it all`);
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const shaped = Math.max(...intensity) - Math.min(...intensity) > 0.3; // meaningful pattern
  if (s.paceDelta > 0 && s.exhaustsInH != null && s.exhaustsInH < s.remainH) {
    console.log(`  projection: hits 100% in ~${(s.exhaustsInH / 24).toFixed(1)} days — ${((s.remainH - s.exhaustsInH) / 24).toFixed(1)} days early. Slow down or budget for the gap.`);
  } else if (shaped) {
    const expire = Math.max(0, 100 - shapedEnd);
    console.log(`  projection: ends ~${shapedEnd.toFixed(0)}% by your weekday pattern → ~${expire.toFixed(0)}% expires${shapedEnd >= 99.5 ? '!' : ''} (linear: ${s.projectedEnd.toFixed(0)}%)`);
    console.log(`  your week:  ${intensity.map((v, i) => `${names[i]} ${v.toFixed(1)}×`).join(' ')}`);
  } else {
    console.log(`  projection: week ends at ~${s.projectedEnd.toFixed(0)}% → ~${s.wouldExpire.toFixed(0)}% of the quota would expire unused`);
  }
  if (cmp.pctDiff != null) {
    const dir = cmp.pctDiff >= 0 ? `${cmp.pctDiff.toFixed(0)}% MORE` : `${Math.abs(cmp.pctDiff).toFixed(0)}% LESS`;
    console.log(`  vs usual:   ${fmtTokens(cmp.thisAvg)} out-tokens/day vs ${fmtTokens(cmp.priorAvg)} (3-wk avg) → ${dir}`);
  }
}

async function history() {
  const cache = await loadUsage({ log: asJson ? () => {} : (msg) => console.log(`  [${msg}]`) });
  const dayModels = byDayModel(cache);
  const days = Object.keys(dayModels).sort();
  const perDay = days.map((day) => {
    let tokens = 0;
    let cost = 0;
    for (const [model, t] of Object.entries(dayModels[day])) {
      tokens += t.in + t.out + t.cw + t.cr;
      cost += costUSD(model, t);
    }
    return { day, tokens, cost };
  });

  // ISO-week rollup
  const weeks = {};
  for (const { day, tokens, cost } of perDay) {
    const d = new Date(day + 'T00:00:00Z');
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    const w = (weeks[key] ??= { tokens: 0, cost: 0, days: 0 });
    w.tokens += tokens;
    w.cost += cost;
    w.days++;
  }

  if (asJson) {
    console.log(JSON.stringify({ daily: perDay, weekly: weeks }, null, 2));
    return;
  }
  console.log('quotamax — usage history (from local transcripts)\n');
  const last14 = perDay.slice(-14);
  if (last14.length) {
    console.log(`  last ${last14.length} days  ${sparkline(last14.map((d) => d.cost))}   (API-cost equivalent per day)`);
    console.log('');
  }
  console.log('  week of      total tokens   API-cost equiv   avg/day');
  for (const [key, w] of Object.entries(weeks).slice(-8)) {
    console.log(`  ${key}   ${fmtTokens(w.tokens).padStart(10)}   ${fmtUSD(w.cost).padStart(12)}   ${fmtUSD(w.cost / w.days).padStart(8)}`);
  }
  console.log('\n  costs are API list-price equivalents of your subscription usage, incl. cache pricing');
}

async function costs() {
  const cache = await loadUsage({ log: asJson ? () => {} : (msg) => console.log(`  [${msg}]`) });
  const dayModels = byDayModel(cache);
  const now = Date.now();
  const windows = { '7d': 7, '30d': 30, '90d': 90 };
  const result = {};
  for (const [label, daysBack] of Object.entries(windows)) {
    const cutoff = new Date(now - daysBack * 24 * HOUR).toISOString().slice(0, 10);
    const perModel = {};
    for (const [day, models] of Object.entries(dayModels)) {
      if (day < cutoff) continue;
      for (const [model, t] of Object.entries(models)) {
        const m = (perModel[model] ??= { in: 0, out: 0, cw: 0, cr: 0 });
        m.in += t.in;
        m.out += t.out;
        m.cw += t.cw;
        m.cr += t.cr;
      }
    }
    let total = 0;
    const rows = Object.entries(perModel)
      .map(([model, t]) => {
        const cost = costUSD(model, t);
        total += cost;
        return { model, ...t, cost };
      })
      .sort((a, b) => b.cost - a.cost);
    result[label] = { total, rows };
  }

  const cfg = loadConfig();
  if (asJson) {
    console.log(JSON.stringify({ windows: result, planMonthlyCost: cfg.planMonthlyCost ?? null }, null, 2));
    return;
  }
  console.log('quotamax — API-cost equivalence (what this usage would cost pay-as-you-go)\n');
  const w = result['30d'];
  console.log('  last 30 days, by model:');
  console.log('  model                          output      input     cache-w    cache-r        cost');
  for (const r of w.rows.filter((r) => r.cost >= 0.01)) {
    console.log(
      `  ${r.model.padEnd(28).slice(0, 28)} ${fmtTokens(r.out).padStart(8)} ${fmtTokens(r.in).padStart(10)} ${fmtTokens(r.cw).padStart(11)} ${fmtTokens(r.cr).padStart(10)} ${fmtUSD(r.cost).padStart(11)}`,
    );
  }
  console.log(`  ${'total'.padEnd(28)} ${''.padStart(8)} ${''.padStart(10)} ${''.padStart(11)} ${''.padStart(10)} ${fmtUSD(w.total).padStart(11)}`);
  console.log(`\n  7 days: ${fmtUSD(result['7d'].total)}   30 days: ${fmtUSD(w.total)}   90 days: ${fmtUSD(result['90d'].total)}`);
  if (cfg.planMonthlyCost) {
    const mult = w.total / cfg.planMonthlyCost;
    console.log(`  plan value: ~${fmtUSD(w.total)} of API-equivalent usage on a ${cfg.currency ?? '$'}${cfg.planMonthlyCost}/mo plan → ${mult.toFixed(1)}x`);
  } else {
    console.log('  tip: set {"planMonthlyCost": 100} in ~/.config/quotamax/config.json to see your plan multiple');
  }
  console.log('  note: list-price estimate from local transcripts; cache writes 1.25x, reads 0.1x input price');
}

async function agent() {
  let payload;
  try {
    const pri = loadPriorities();
    payload = advise(await getQuota(), Date.now(), reservedPercent(pri));
    payload.reservations = activeReservations(pri);
    payload.priorities = pri.priorities;
  } catch (e) {
    payload = { ok: false, error: e.message, headroom: 'unknown', advice: null };
  }
  if (flags.has('--line')) {
    // Hook mode: one compact context line, silent on failure, always exit 0.
    if (payload.ok) {
      const a = payload.advice;
      const d = payload.weekly.resetsInMinutes != null ? (payload.weekly.resetsInMinutes / 1440).toFixed(1) : '?';
      const res = payload.weekly.reservedPercent > 0
        ? `, ${payload.weekly.reservedPercent}% reserved for: ${payload.reservations.map((r) => r.name).join(', ')}`
        : '';
      console.log(
        `Claude quota headroom: ${payload.headroom} — cap parallel subagents at ${a.parallelism}, model tier ${a.modelTier}, thinking ${a.thinkingEffort} (session ${payload.session.percentUsed}%, weekly ${payload.weekly.percentUsed}%${res}, resets in ${d}d)`,
      );
    }
    process.exit(0);
  }
  if (flags.has('--quiet')) {
    console.log(payload.headroom);
  } else {
    console.log(JSON.stringify(payload, null, asJson ? 0 : 2));
  }
  process.exit(payload.ok ? exitCodeFor(payload.headroom) : 5);
}

try {
  switch (cmd) {
    case 'status': await status(); break;
    case 'trend':
    case 'forecast': await trend(); break;
    case 'history': await history(); break;
    case 'costs':
    case 'cost': await costs(); break;
    case 'agent':
    case 'check': await agent(); break;
    case 'pricing':
      console.log(JSON.stringify(priceFor(args[1] ?? 'claude-opus-4-8'), null, 2));
      break;
    case 'reserve': {
      const [, pct, ...nameParts] = args.filter((a) => !a.startsWith('--'));
      const name = nameParts.join(' ');
      if (!Number(pct) || !name) {
        console.error('usage: quotamax reserve <percent> <name…>   (reserves weekly % until the next reset)');
        process.exit(1);
      }
      let until = null;
      try {
        until = (await getQuota()).weekly.resetsAt;
      } catch { /* no live reset time: reservation persists until removed */ }
      reserve({ percent: Number(pct), name, until });
      console.log(`reserved ${pct}% of the weekly quota for "${name}"${until ? ` until ${new Date(until).toLocaleString()}` : ''}`);
      break;
    }
    case 'unreserve':
      unreserve(args.filter((a) => !a.startsWith('--')).slice(1).join(' '));
      console.log('removed.');
      break;
    case 'prioritize':
      prioritize(args.filter((a) => !a.startsWith('--')).slice(1).join(' '));
      console.log('prioritized.');
      break;
    case 'deprioritize':
      deprioritize(args.filter((a) => !a.startsWith('--')).slice(1).join(' '));
      console.log('removed.');
      break;
    case 'priorities': {
      const p = loadPriorities();
      if (asJson) {
        console.log(JSON.stringify({ ...p, activeReservedPercent: reservedPercent(p), path: PRIORITIES_PATH }, null, 2));
        break;
      }
      const act = activeReservations(p);
      console.log(`quotamax priorities (${PRIORITIES_PATH})\n`);
      console.log(`  reservations (${reservedPercent(p)}% of weekly quota held back):`);
      for (const r of act) console.log(`    • ${r.percent}% — ${r.name}${r.until ? ` (until ${new Date(r.until).toLocaleDateString()})` : ''}`);
      if (!act.length) console.log('    (none)');
      console.log(`  priority projects:`);
      for (const r of p.priorities) console.log(`    • ${r.name}${r.note ? ` — ${r.note}` : ''}`);
      if (!p.priorities.length) console.log('    (none)');
      break;
    }
    default:
      console.log(`Unknown command: ${cmd}\nCommands: status | trend | history | costs | agent [--quiet|--line] | priorities | reserve <pct> <name> | unreserve <name> | prioritize <name> | deprioritize <name> | pricing <model>\nFlags: --json`);
      process.exit(1);
  }
} catch (e) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: e.message }));
  else console.error(`quotamax: ${e.message}`);
  process.exit(1);
}
