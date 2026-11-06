// SCOUT — trouve des paires Solana fraîches : 20 min à 48 h, market cap 250 k$ à 15 M$.
import { config } from '../config.js';
import { data } from '../data/index.js';
import { state, log, pushFlow, changed } from '../state.js';

const seen = new Map(); // adresse -> { until } : ne pas re-scanner avant cette date
const recentFound = []; // timestamps pour calculer les paires/min
export const killed = new Set(); // tokens éliminés définitivement

export async function runScout() {
  const a = state.agents.scout;
  a.status = 'scan';
  changed();
  const now = Date.now();
  const all = await data.getNewTokens();
  const held = new Set(state.positions.map((p) => p.address));
  const todo = all.filter((addr) => !killed.has(addr) && !held.has(addr) && !((seen.get(addr)?.until || 0) > now));
  if (todo.length === 0) {
    a.status = 'idle';
    return [];
  }
  const pairs = await data.getPairs(todo);
  const c = config.scout;
  const candidates = [];
  for (const addr of todo) {
    const p = pairs.get(addr);
    a.seen++;
    if (!p) {
      seen.set(addr, { until: now + 10 * 60_000 });
      continue;
    }
    const ageMin = p.createdAt ? (now - p.createdAt) / 60_000 : null;
    let reason = null;
    if (ageMin === null) reason = 'âge inconnu';
    else if (ageMin < c.minAgeMin) reason = `trop jeune (${ageMin.toFixed(0)} min)`;
    else if (ageMin > c.maxAgeHours * 60) reason = 'trop vieux';
    else if (p.mcap < c.minMcap) reason = `mcap trop faible ($${fmtK(p.mcap)})`;
    else if (p.mcap > c.maxMcap) reason = `mcap trop haute ($${fmtK(p.mcap)})`;

    if (reason) {
      // trop jeune ou mcap trop basse : on repassera plus tard ; sinon on oublie longtemps
      const retry = reason.startsWith('trop jeune') || reason.startsWith('mcap trop faible') ? 8 : 180;
      seen.set(addr, { until: now + retry * 60_000 });
      continue;
    }
    seen.set(addr, { until: now + 60 * 60_000 });
    a.fresh++;
    a.lastNew = p.symbol;
    recentFound.push(now);
    pushFlow({ address: addr, symbol: p.symbol, ageMin, mcap: p.mcap, stage: 'scout', verdict: 'new', t: now });
    candidates.push(p);
  }
  while (recentFound.length && recentFound[0] < now - 10 * 60_000) recentFound.shift();
  a.pairsPerMin = +(recentFound.length / 10).toFixed(1);
  if (candidates.length) log('scout', `${candidates.length} nouvelle(s) paire(s) : ${candidates.map((p) => '$' + p.symbol).join(', ')}`);
  // purge mémoire
  if (seen.size > 20_000) for (const [k, v] of seen) if (v.until < now) seen.delete(k);
  a.status = 'idle';
  changed();
  return candidates;
}

/** Un candidat non traité (positions pleines, pause) sera re-scanné au prochain tour. */
export function releaseCandidate(address) {
  seen.delete(address);
  const i = state.flow.findIndex((f) => f.address === address && f.stage === 'scout');
  if (i >= 0) state.flow.splice(i, 1);
}

export function fmtK(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'k';
  return Math.round(v).toString();
}
