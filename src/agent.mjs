// Machine-readable capacity advice for agents and orchestrators:
// "can I fan out subagents right now, and how hard should each one think?"
//
// Headroom levels (binding constraint of session window + weekly pace):
//   abundant     → burn freely: parallelize wide, top model, deep thinking
//   comfortable  → normal operation
//   constrained  → economize: fewer parallel tasks, lighter models/thinking
//   critical     → minimum footprint; interactive use is at risk of blocking
import { metricsFor } from './trends.mjs';

const LEVELS = ['abundant', 'comfortable', 'constrained', 'critical'];

export const ADVICE_BY_LEVEL = {
  abundant: { parallelism: 8, modelTier: 'top', thinkingEffort: 'xhigh' },
  comfortable: { parallelism: 4, modelTier: 'top', thinkingEffort: 'high' },
  constrained: { parallelism: 2, modelTier: 'mid', thinkingEffort: 'medium' },
  critical: { parallelism: 1, modelTier: 'economy', thinkingEffort: 'low' },
};

export function advise(quota, nowMs = Date.now(), reservedPct = 0, override = null) {
  const m = metricsFor(quota, nowMs);
  const session = quota.session.percent;
  // Reserved quota is treated as already spent: headroom shrinks accordingly.
  const weekly = Math.min(100, quota.weekly.percent + reservedPct);
  m.paceDelta = weekly - m.expectedPercent;
  const sessionResetMin = quota.session.resetsAt
    ? Math.max(0, Math.round((Date.parse(quota.session.resetsAt) - nowMs) / 60e3))
    : null;

  let level;
  if (session >= 90 || weekly >= 97) level = 'critical';
  else if (session >= 70 || weekly >= 85 || m.paceDelta > 15) level = 'constrained';
  else if (session >= 40 || m.paceDelta > -10) level = 'comfortable';
  else level = 'abundant'; // cool session window AND well behind weekly pace

  if (override && ADVICE_BY_LEVEL[override.level]) level = override.level;
  const advice = ADVICE_BY_LEVEL[level];

  const rationale =
    (override ? `MANUAL OVERRIDE to "${override.level}"${override.until ? ` until ${new Date(override.until).toLocaleTimeString()}` : ''} — measured: ` : '') +
    `session window ${session}% used` +
    (sessionResetMin != null ? ` (resets in ${sessionResetMin}m)` : '') +
    `; weekly ${quota.weekly.percent}% used` +
    (reservedPct > 0 ? ` +${reservedPct}% reserved` : '') +
    `, ` +
    (m.paceDelta <= 0
      ? `${Math.abs(m.paceDelta).toFixed(0)} pts behind linear pace`
      : `${m.paceDelta.toFixed(0)} pts ahead of linear pace`) +
    ` with ${(m.hoursToReset / 24).toFixed(1)}d to reset`;

  return {
    ok: true,
    stale: quota.stale ?? false,
    override: override ? { level: override.level, until: override.until ?? null } : null,
    session: { percentUsed: session, resetsInMinutes: sessionResetMin },
    weekly: {
      percentUsed: quota.weekly.percent,
      reservedPercent: reservedPct,
      effectivePercent: weekly,
      resetsInMinutes: Number.isFinite(Date.parse(quota.weekly.resetsAt))
        ? Math.max(0, Math.round((Date.parse(quota.weekly.resetsAt) - nowMs) / 60e3))
        : null,
      paceDelta: Number(m.paceDelta.toFixed(1)),
    },
    headroom: level,
    advice: { ...advice, rationale },
  };
}

/** Exit code for shell scripting: 0 abundant/comfortable, 3 constrained, 4 critical. */
export function exitCodeFor(level) {
  return { abundant: 0, comfortable: 0, constrained: 3, critical: 4 }[level] ?? 0;
}

export { LEVELS };
