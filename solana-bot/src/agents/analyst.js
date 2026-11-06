// ANALYST — note ce qui a passé le filtre, de 0 à 100. Seuls les ≥ MIN_SCORE passent.
import { config } from '../config.js';
import { state, log, updateFlow, changed } from '../state.js';

const clamp = (v) => Math.max(0, Math.min(100, v));
const lin = (v, lo, hi) => clamp(((v - lo) / (hi - lo)) * 100);

export function scorePair(p, ctx = {}) {
  const buys = p.txns.h1.buys;
  const sells = p.txns.h1.sells;
  const ratio = buys / Math.max(1, sells);
  const avgHourVol6h = p.volume.h6 / 6;
  const accel = avgHourVol6h > 0 ? p.volume.h1 / avgHourVol6h : 1;
  const liqRatio = p.mcap > 0 ? p.liquidityUsd / p.mcap : 0;

  // Momentum : on veut une hausse, mais une hausse trop verticale est pénalisée.
  const h1 = p.change.h1;
  const m5 = p.change.m5;
  let momentum = 50 + h1 * 0.6 + m5 * 2;
  if (h1 > 60) momentum -= (h1 - 60) * 1.2;
  if (m5 < -8) momentum -= 25; // en train de dumper

  const factors = [
    { id: 'momentum', label: 'momentum', score: clamp(momentum), weight: 0.22, raw: `1h ${h1.toFixed(0)}% · 5m ${m5.toFixed(1)}%` },
    { id: 'buyers', label: 'acheteurs 1h', score: lin(buys, 50, 500), weight: 0.18, raw: `${buys} achats` },
    { id: 'ratio', label: 'ratio achat / vente', score: lin(ratio, 0.85, 1.8), weight: 0.2, raw: ratio.toFixed(2) },
    { id: 'accel', label: 'accélération volume', score: lin(accel, 0.6, 2.2), weight: 0.15, raw: `x${accel.toFixed(2)}` },
    { id: 'liq', label: 'liquidité / mcap', score: lin(liqRatio, 0.04, 0.2), weight: 0.15, raw: `${(liqRatio * 100).toFixed(1)}%` },
  ];
  if (ctx.rug?.totalHolders != null) {
    factors.push({ id: 'holders', label: 'holders', score: lin(ctx.rug.totalHolders, 200, 3000), weight: 0.1, raw: `${ctx.rug.totalHolders}` });
  }
  const wsum = factors.reduce((s, f) => s + f.weight, 0);
  const score = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0) / wsum);
  return { score, factors: factors.map((f) => ({ ...f, score: Math.round(f.score) })) };
}

export async function runAnalyst(pair, ctx) {
  const a = state.agents.analyst;
  a.status = 'score';
  changed();
  const { score, factors } = scorePair(pair, ctx);
  const min = config.analyst.minScore;
  const pass = score >= min;
  a.scored++;
  if (pass) a.passed++;
  a.last = { symbol: pair.symbol, score };
  state.analystView = { symbol: pair.symbol, address: pair.address, score, factors, pass, min, t: Date.now() };
  updateFlow(pair.address, pass ? { stage: 'executor', score } : { stage: 'analyst', verdict: 'low', score });
  log('analyst', `$${pair.symbol} score ${score}/100 ${pass ? `≥ ${min} → EXECUTOR` : `< ${min}, abandonné`}`);
  if (state.sim) await new Promise((r) => setTimeout(r, 600));
  a.status = 'idle';
  changed();
  return { score, factors, pass };
}
