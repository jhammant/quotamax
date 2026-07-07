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
import { burnStats, metricsFor, renderChart, usageComparison, sparkline } from './trends.mjs';
import { costUSD, fmtUSD, fmtTokens, priceFor } from './pricing.mjs';
import { advise, exitCodeFor } from './agent.mjs';

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
  return `resets ${new Date(iso).toLocaleString()} (in ${h < 48 ? h.toFixed(1) + 'h' : (h / 24).toFixed(1) + 'd'})`;
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
  console.log(`quotamax — plan: ${quota.subscription ?? 'unknown'}${quota.stale ? `  (⚠ stale: ${quota.staleReason})` : ''}\n`);
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
  const cmp = usageComparison(dailyOutput(cache), resetMs, now);

  if (asJson) {
    console.log(JSON.stringify({ quota, stats: s, comparison: cmp }, null, 2));
    return;
  }
  console.log(`quotamax — week trend & forecast${quota.stale ? '  (⚠ stale quota)' : ''}`);
  console.log(`day ${(s.elapsedH / 24).toFixed(1)} of 7 · resets ${new Date(resetMs).toLocaleString()}\n`);
  console.log(renderChart(points, resetMs, now, s.ratePerDay));
  console.log('');
  console.log(`  now:        ${s.current}% used · expected ${s.expected.toFixed(0)}% · ${s.paceDelta <= 0 ? Math.abs(s.paceDelta).toFixed(0) + ' pts BEHIND pace' : s.paceDelta.toFixed(0) + ' pts AHEAD of pace'}`);
  console.log(`  burn rate:  ${s.ratePerDay.toFixed(1)} pts/day (recent) · ${s.neededPerDay.toFixed(1)} pts/day would use it all`);
  if (s.paceDelta > 0 && s.exhaustsInH != null && s.exhaustsInH < s.remainH) {
    console.log(`  projection: hits 100% in ~${(s.exhaustsInH / 24).toFixed(1)} days — ${((s.remainH - s.exhaustsInH) / 24).toFixed(1)} days early. Slow down or budget for the gap.`);
  } else {
    console.log(`  projection: week ends at ~${s.projectedEnd.toFixed(0)}% → ~${s.wouldExpire.toFixed(0)}% of the quota would expire unused`);
  }
  if (cmp.pctDiff != null) {
    const dir = cmp.pctDiff >= 0 ? `${cmp.pctDiff.toFixed(0)}% MORE` : `${Math.abs(cmp.pctDiff).toFixed(0)}% LESS`;
    console.log(`  vs usual:   ${fmtTokens(cmp.thisAvg)} output tokens/day this week vs ${fmtTokens(cmp.priorAvg)}/day prior 3 weeks → ${dir} than usual`);
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
    payload = advise(await getQuota());
  } catch (e) {
    payload = { ok: false, error: e.message, headroom: 'unknown', advice: null };
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
    default:
      console.log(`Unknown command: ${cmd}\nCommands: status | trend | history | costs | agent [--quiet] | pricing <model>\nFlags: --json`);
      process.exit(1);
  }
} catch (e) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: e.message }));
  else console.error(`quotamax: ${e.message}`);
  process.exit(1);
}
