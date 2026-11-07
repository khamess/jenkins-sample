// STRATÉGIE — fonction pure, utilisée à l'identique par le bot (liste du matin) et par le backtest.
// Entrées : bougies jour et 4 h CLÔTURÉES au moment de la décision, prix courant, funding, bougies jour du BTC.
// Sortie : sens, score 0-100, niveaux (stop structurel, objectifs), et filtres de qualité.
import { ema, rsi, last, lin } from './indicators.js';

export const DEFAULT_PARAMS = {
  minScore: 65,
  requireAlign: true, // tendance jour ET 4 h dans le même sens
  minAtrPct: 2,
  maxAtrPct: 9,
  stopAtrBuffer: 0.3, // marge sous le dernier creux 4 h (en ATR 4 h)
  minStopPct: 1.2,
  maxStopPct: 4.5,
  minRR1: 1.2, // objectif 1 (prochain pivot journalier) ≥ 1,2 × le risque
  maxExtAtr: 1.5, // pas d'entrée trop loin de l'EMA20 4 h (en ATR 4 h)
  rangeEdge: 0.1, // pas de short dans les 10 % bas du range 30 j (ni de long dans les 10 % hauts)
};

function atrAbs(c, n = 14) {
  let s = 0;
  const k = Math.min(n, c.length - 1);
  for (let i = c.length - k; i < c.length; i++) s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  return s / k;
}

function pivots(c, k = 3) {
  const hi = [];
  const lo = [];
  for (let i = k; i < c.length - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (c[j].h > c[i].h) isH = false;
      if (c[j].l < c[i].l) isL = false;
    }
    if (isH) hi.push(c[i].h);
    if (isL) lo.push(c[i].l);
  }
  return { hi, lo };
}

function logRets(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0.8;
  a = a.slice(-n);
  b = b.slice(-n);
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * @param d    bougies jour clôturées [{t,o,h,l,c,amount}] (≥ 60)
 * @param f    bougies 4 h clôturées (≥ 60)
 * @param price prix courant
 * @param fundingPct funding courant en %
 * @param btcD bougies jour clôturées du BTC
 */
export function analyze(symbol, d, f, price, fundingPct, btcD, params = DEFAULT_PARAMS) {
  const P = { ...DEFAULT_PARAMS, ...params };
  if (d.length < 60 || f.length < 60) return null;
  const dc = d.map((k) => k.c);
  const fc = f.map((k) => k.c);
  const e20s = ema(dc, 20);
  const e20 = last(e20s);
  const e50 = last(ema(dc, 50));
  const e200 = dc.length >= 200 ? last(ema(dc, 200)) : null;
  const slope = e20 - e20s[e20s.length - 6];
  const f20 = last(ema(fc, 20));
  const f50 = last(ema(fc, 50));
  const rD = rsi(dc, 14);
  const atrD = atrAbs(d);
  const atr4 = atrAbs(f);
  const atrPct = (atrD / price) * 100;
  const ret7 = (last(dc) / dc[dc.length - 8] - 1) * 100;
  const btcC = btcD.map((k) => k.c);
  const btcRet7 = btcC.length > 8 ? (last(btcC) / btcC[btcC.length - 8] - 1) * 100 : 0;
  const rs = symbol === 'BTC_USDT' ? 0 : ret7 - btcRet7;
  const avgAmt = d.slice(-21, -1).reduce((s, k) => s + k.amount, 0) / 20;
  const volRatio = avgAmt > 0 ? last(d).amount / avgAmt : 1;
  const corr = symbol === 'BTC_USDT' ? 1 : correlation(logRets(dc.slice(-31)), logRets(btcC.slice(-31)));

  // ----- score long / short (0-100) -----
  const L = { trendD: 0, trend4h: 0, momentum: 0, rs: 0, volume: 0, funding: 0 };
  const S = { ...L };
  (price > e20 ? L : S).trendD += 10;
  (e20 > e50 ? L : S).trendD += 10;
  (slope > 0 ? L : S).trendD += 5;
  (price > f20 ? L : S).trend4h += 10;
  (f20 > f50 ? L : S).trend4h += 10;
  L.momentum = rD >= 50 && rD <= 68 ? 20 : rD > 68 && rD <= 75 ? 10 : rD >= 45 && rD < 50 ? 8 : 0;
  S.momentum = rD >= 32 && rD <= 50 ? 20 : rD >= 25 && rD < 32 ? 10 : rD > 50 && rD <= 55 ? 8 : 0;
  L.rs = symbol === 'BTC_USDT' ? 7.5 : lin(rs, -10, 10, 15);
  S.rs = symbol === 'BTC_USDT' ? 7.5 : lin(-rs, -10, 10, 15);
  const vScore = lin(volRatio, 0.8, 2, 10);
  (last(dc) >= dc[dc.length - 2] ? L : S).volume = vScore;
  L.funding = lin(-fundingPct, -0.05, -0.01, 10);
  S.funding = lin(fundingPct, -0.05, -0.01, 10);
  const sum = (o) => Math.round(Object.values(o).reduce((s, v) => s + v, 0));
  const longScore = sum(L);
  const shortScore = sum(S);
  const side = longScore >= shortScore ? 'long' : 'short';
  const isL = side === 'long';
  const score = Math.max(longScore, shortScore);
  const parts = isL ? L : S;

  // ----- niveaux : stop structurel + objectifs -----
  const p4 = pivots(f.slice(-120), 3);
  const pD = pivots(d.slice(-120), 3);
  const opp = (isL ? p4.lo.filter((p) => p < price) : p4.hi.filter((p) => p > price)).slice(-1)[0];
  let stop = opp != null ? (isL ? opp - P.stopAtrBuffer * atr4 : opp + P.stopAtrBuffer * atr4) : isL ? price - 1.5 * atr4 : price + 1.5 * atr4;
  let riskPct = Math.abs(stop / price - 1) * 100;
  if (riskPct < P.minStopPct) {
    riskPct = P.minStopPct;
    stop = isL ? price * (1 - riskPct / 100) : price * (1 + riskPct / 100);
  }
  const R = Math.abs(price - stop);
  const tgts = (isL ? pD.hi.filter((p) => p > price + 0.25 * R) : pD.lo.filter((p) => p < price - 0.25 * R)).sort((a, b) => (isL ? a - b : b - a));
  const tp1 = tgts[0] ?? (isL ? price + 2 * R : price - 2 * R);
  const tp2 = tgts[1] ?? (isL ? price + 3.5 * R : price - 3.5 * R);
  const rr1 = Math.abs(tp1 - price) / R;
  const rr2 = Math.abs(tp2 - price) / R;
  const ext = ((price - f20) / atr4) * (isL ? 1 : -1);
  const hi30 = Math.max(...d.slice(-30).map((k) => k.h));
  const lo30 = Math.min(...d.slice(-30).map((k) => k.l));
  const pos30 = hi30 > lo30 ? (price - lo30) / (hi30 - lo30) : 0.5;

  // ----- filtres de qualité -----
  const rejects = [];
  const aligned = isL ? price > e20 && e20 > e50 && price > f20 && f20 > f50 : price < e20 && e20 < e50 && price < f20 && f20 < f50;
  if (score < P.minScore) rejects.push(`score ${score} < ${P.minScore}`);
  if (P.requireAlign && !aligned) rejects.push('jour et 4 h pas alignés');
  if (atrPct < P.minAtrPct || atrPct > P.maxAtrPct) rejects.push(`volatilité ${atrPct.toFixed(1)} % hors plage`);
  if (riskPct > P.maxStopPct) rejects.push(`stop structurel trop loin (${riskPct.toFixed(1)} %)`);
  if (rr1 < P.minRR1) rejects.push(`objectif 1 trop proche (${rr1.toFixed(1)} R)`);
  if (ext > P.maxExtAtr) rejects.push(`trop étiré (${ext.toFixed(1)} ATR de l'EMA20 4 h)`);
  if (P.rangeEdge > 0 && (isL ? pos30 > 1 - P.rangeEdge : pos30 < P.rangeEdge)) rejects.push(isL ? 'au plus haut du mois' : 'au plus bas du mois');

  const why = [];
  if (parts.trendD >= 20) why.push(isL ? 'tendance jour haussière' : 'tendance jour baissière');
  if (parts.trend4h >= 20) why.push('4 h aligné');
  if (parts.momentum >= 20) why.push(`RSI ${rD.toFixed(0)}`);
  if (parts.rs >= 10) why.push(`${isL ? 'surperforme' : 'sous-performe'} BTC (${rs >= 0 ? '+' : ''}${rs.toFixed(1)} % / 7 j)`);
  if (parts.volume >= 6) why.push(`volume x${volRatio.toFixed(1)}`);
  if (e200 != null && (isL ? price > e200 : price < e200)) why.push('du bon côté de l’EMA200');
  why.push(`stop ${riskPct.toFixed(1)} % · objectif ${rr1.toFixed(1)} R`);

  return {
    symbol,
    side,
    score,
    price,
    stop,
    riskPct: +riskPct.toFixed(3),
    tp1,
    tp2,
    rr1: +rr1.toFixed(2),
    rr2: +rr2.toFixed(2),
    ext: +ext.toFixed(2),
    pos30: +pos30.toFixed(2),
    corr: +corr.toFixed(2),
    atrPct: +atrPct.toFixed(2),
    rsi: +rD.toFixed(1),
    ret7d: +ret7.toFixed(2),
    rsBtc: +rs.toFixed(2),
    volRatio: +volRatio.toFixed(2),
    fundingPct: +fundingPct.toFixed(4),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
    why,
    rejects,
    ok: rejects.length === 0,
  };
}

/** Sélection : meilleurs scores, plafonds par côté et budget de corrélation BTC. */
export function selectCandidates(rows, { listSize = 5, maxPerSide = 3, maxCorrBudget = 2.4 } = {}) {
  const chosen = [];
  const corrUsed = { long: 0, short: 0 };
  for (const r of [...rows].filter((x) => x.ok).sort((a, b) => b.score - a.score || b.rr1 - a.rr1)) {
    const sameSide = chosen.filter((c) => c.side === r.side).length;
    if (sameSide >= Math.min(listSize, maxPerSide)) continue;
    const w = Math.max(0, r.corr);
    if (corrUsed[r.side] + w > maxCorrBudget) continue;
    corrUsed[r.side] += w;
    chosen.push(r);
  }
  return chosen;
}
