// Pure math for burn rates, projections, and the ASCII burn-up chart.
const WEEK_H = 168;
const HOUR = 3.6e6;
const PACE_PER_DAY = 100 / 7;

export function metricsFor(quota, nowMs = Date.now()) {
  const resetMs = Date.parse(quota.weekly.resetsAt);
  // resets_at is null until the new week's window opens with its first spend
  const hoursToReset = Number.isFinite(resetMs) ? (resetMs - nowMs) / HOUR : WEEK_H;
  const expectedPercent = ((WEEK_H - hoursToReset) / WEEK_H) * 100;
  return { hoursToReset, expectedPercent, paceDelta: quota.weekly.percent - expectedPercent };
}

/** points: [{t: ms, v: weekly percent}] sorted ascending, within current week */
export function burnStats(points, resetsAtMs, nowMs) {
  const weekStart = resetsAtMs - WEEK_H * HOUR;
  const elapsedH = Math.max(0, (nowMs - weekStart) / HOUR);
  const remainH = Math.max(0, (resetsAtMs - nowMs) / HOUR);
  const last = points.at(-1) ?? { t: nowMs, v: 0 };

  let ratePerDay;
  const base = points.find((p) => p.t >= nowMs - 24 * HOUR);
  if (base && last.t - base.t > 0.5 * HOUR) {
    ratePerDay = ((last.v - base.v) / ((last.t - base.t) / HOUR)) * 24;
  } else {
    ratePerDay = elapsedH > 0.5 ? last.v / (elapsedH / 24) : 0;
  }

  const expected = (elapsedH / WEEK_H) * 100;
  const projectedEnd = Math.min(100, last.v + ratePerDay * (remainH / 24));
  return {
    weekStart,
    elapsedH,
    remainH,
    current: last.v,
    expected,
    paceDelta: last.v - expected,
    ratePerDay,
    neededPerDay: remainH > 1 ? ((100 - last.v) / remainH) * 24 : 0,
    projectedEnd,
    wouldExpire: Math.max(0, 100 - projectedEnd),
    exhaustsInH:
      ratePerDay > 0 && last.v < 100 ? Math.min(remainH, ((100 - last.v) / ratePerDay) * 24) : null,
  };
}

export function renderChart(points, resetsAtMs, nowMs, ratePerDay) {
  const W = 56;
  const H = 11;
  const weekStart = resetsAtMs - WEEK_H * HOUR;
  const colOf = (t) => Math.min(W - 1, Math.max(0, Math.floor(((t - weekStart) / (WEEK_H * HOUR)) * W)));
  const rowOf = (v) => Math.min(H - 1, Math.max(0, Math.round((v / 100) * (H - 1))));
  const grid = Array.from({ length: H }, () => Array(W).fill(' '));

  for (let c = 0; c < W; c++) grid[rowOf(((c + 0.5) / W) * 100)][c] = '·';
  const last = points.at(-1);
  if (last) {
    for (let c = colOf(nowMs); c < W; c++) {
      const hAhead = ((c + 0.5) / W) * WEEK_H - (nowMs - weekStart) / HOUR;
      if (hAhead < 0) continue;
      grid[rowOf(Math.min(100, last.v + (ratePerDay / 24) * hAhead))][c] = '░';
    }
  }
  for (const p of points) grid[rowOf(p.v)][colOf(p.t)] = '█';

  const resetDow = new Date(resetsAtMs).getDay(); // labels start the day after reset
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const lines = [];
  for (let r = H - 1; r >= 0; r--) {
    const v = Math.round((r / (H - 1)) * 100);
    const label = r % 2 === 0 ? String(v).padStart(3) : '   ';
    lines.push(`  ${label} ${r === 0 ? '┼' : '┤'}${grid[r].join('')}`);
  }
  const days = Array.from({ length: 7 }, (_, i) => dayNames[(resetDow + i) % 7]);
  lines.push(`      ${days.map((d) => d.padEnd(8)).join('')}`);
  lines.push('      █ actual   ░ projected   · linear pace   (week runs reset→reset)');
  return lines.join('\n');
}

/** dailyOut: {'YYYY-MM-DD': outputTokens} → this week vs prior-3-week baseline */
export function usageComparison(dailyOut, resetsAtMs, nowMs) {
  const weekStart = resetsAtMs - WEEK_H * HOUR;
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const sumRange = (fromMs, toMs) => {
    let s = 0;
    for (let t = fromMs; t <= toMs; t += 24 * HOUR) s += dailyOut[day(t)] ?? 0;
    return s;
  };
  const daysElapsed = Math.max(0.25, (nowMs - weekStart) / (24 * HOUR));
  const thisAvg = sumRange(weekStart, nowMs) / daysElapsed;
  const priorAvg = sumRange(weekStart - 21 * 24 * HOUR, weekStart - 1) / 21;
  return {
    thisAvg,
    priorAvg,
    pctDiff: priorAvg > 0 ? ((thisAvg - priorAvg) / priorAvg) * 100 : null,
  };
}

/**
 * Relative usage intensity per weekday (index 0=Sun..6=Sat, mean 1.0),
 * from per-day output tokens. Days with no data count as zeros for observed
 * weekdays; a weekday never observed gets intensity 1 (no evidence).
 */
export function weekdayProfile(dailyOut, nowMs = Date.now(), weeks = 8) {
  const totals = Array(7).fill(0);
  const counts = Array(7).fill(0);
  const cutoff = new Date(nowMs - weeks * 7 * 24 * HOUR).toISOString().slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (const [day, v] of Object.entries(dailyOut)) {
    if (day < cutoff || day >= today) continue; // exclude partial today
    const dow = new Date(day + 'T12:00:00Z').getUTCDay();
    totals[dow] += v;
    counts[dow]++;
  }
  const avgs = totals.map((t, i) => (counts[i] ? t / counts[i] : null));
  const seen = avgs.filter((a) => a != null);
  if (seen.length < 3) return Array(7).fill(1); // not enough history: flat
  const mean = seen.reduce((a, b) => a + b, 0) / seen.length;
  if (mean <= 0) return Array(7).fill(1);
  return avgs.map((a) => (a == null ? 1 : a / mean));
}

/**
 * Week-end projection that walks the remaining days weighting the burn rate
 * by each weekday's observed intensity. With a flat profile this equals the
 * linear projection.
 */
export function shapedProjection(current, ratePerDay, intensity, nowMs, resetsAtMs) {
  const todayIntensity = intensity[new Date(nowMs).getDay()];
  // The observed recent rate happened on today's kind of day; normalize it.
  const base = todayIntensity > 0.1 ? ratePerDay / todayIntensity : ratePerDay;
  let v = current;
  let t = nowMs;
  while (t < resetsAtMs && v < 100) {
    const d = new Date(t);
    const endOfDay = new Date(d);
    endOfDay.setHours(24, 0, 0, 0);
    const chunkEnd = Math.min(endOfDay.getTime(), resetsAtMs);
    v += base * intensity[d.getDay()] * ((chunkEnd - t) / (24 * HOUR));
    t = chunkEnd;
  }
  return Math.min(100, v);
}

export function sparkline(values, width = values.length) {
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);
  return values
    .slice(-width)
    .map((v) => blocks[Math.min(7, Math.floor((v / max) * 8))])
    .join('');
}
