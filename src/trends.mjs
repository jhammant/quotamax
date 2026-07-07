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

export function sparkline(values, width = values.length) {
  const blocks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);
  return values
    .slice(-width)
    .map((v) => blocks[Math.min(7, Math.floor((v / max) * 8))])
    .join('');
}
