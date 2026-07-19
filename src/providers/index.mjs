// Extra provider pools beyond Claude. quotamax reads Claude natively (quota.mjs);
// this layer adds the other coding-agent subscriptions a user may run alongside
// it — Codex (ChatGPT) and Kimi Code (Moonshot) — so `quotamax status` /
// `quotamax providers` can show every pool's headroom in one place.
//
// Each provider returns a normalized shape:
//   { id, label, configured, ok, note?, limits: [{ label, percent, unit,
//     resetsAt, surplus }] }
import { codexProvider } from './codex.mjs';
import { kimiProvider } from './kimi.mjs';

const PROVIDERS = [codexProvider, kimiProvider];

// A limit has "surplus" when usage trails the linear pace of its cycle by 15+ pts
// — i.e. quota that's on track to expire unused.
export function paceSurplus(percent, resetsAt, cycleDays) {
  if (percent == null || !resetsAt) return false;
  const hoursToReset = (Date.parse(resetsAt) - Date.now()) / 3.6e6;
  const cycleHours = cycleDays * 24;
  const expected = Math.min(100, Math.max(0, ((cycleHours - hoursToReset) / cycleHours) * 100));
  return expected - percent >= 15;
}

// Fan out to every non-Claude provider, isolating failures so one broken pool
// never takes down the others.
export async function getOtherProviders() {
  return Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        return await p();
      } catch (e) {
        return { id: 'unknown', label: 'unknown', configured: true, ok: false, note: e.message, limits: [] };
      }
    }),
  );
}
