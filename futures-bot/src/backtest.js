// BACKTEST — rejoue la stratégie sur l'historique de la plateforme (EXCHANGE) pour comparer des réglages.
// Sur OKX, l'historique vient des perpétuels USDT (même sous-jacent, historique plus long que les X-Perps).
//   node src/backtest.js [--days=180] [--hour=6] [--top=35] [--refresh]
// Chaque matin (heure UTC --hour) : liste calculée avec les SEULES bougies clôturées à cet instant,
// entrée à l'ouverture de la bougie 1 h suivante, gestion bougie 1 h par bougie 1 h, frais + slippage.
// Limites : univers = contrats liquides AUJOURD'HUI (biais du survivant), funding non simulé.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ex } from './exchange.js';
import { analyze, selectCandidates, DEFAULT_PARAMS } from './strategy.js';
import { buildUniverse } from './screener.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true']));
const DAYS = +(args.days || 180);
const HOUR = +(args.hour ?? 6);
const TOP = +(args.top || 35);
const SKIP = +(args.skip || 0); // ignore les N derniers jours (test hors échantillon)
const DAY = 86_400_000;
const CACHE = path.join(config.dataDir, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

async function cached(symbol, interval, startMs) {
  const file = path.join(CACHE, `${ex.name}-${symbol}-${interval}.json`);
  if (!args.refresh && fs.existsSync(file)) {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.startMs <= startMs && Date.now() - c.at < 12 * 3600_000) return c.data;
  }
  const data = await ex.getKlinesRange(symbol, interval, startMs);
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), startMs, data }));
  return data;
}

// recherche binaire : nombre de bougies clôturées avant T
function closedBefore(arr, T, len) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].t + len <= T) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export async function loadData() {
  const { universe } = await buildUniverse({ exclure: [], forcerLong: [], forcerShort: [] });
  const list = universe.slice(0, TOP).map((u) => u.contract);
  const btc = ex.btcSymbol();
  if (!list.some((c) => c.symbol === btc)) list.push((await ex.getContracts()).find((c) => c.symbol === btc));
  const now = Date.now();
  const start = Math.floor((now - (DAYS + SKIP) * DAY) / DAY) * DAY;
  const data = {};
  let i = 0;
  for (const c of list) {
    i++;
    process.stdout.write(`\r  historique ${i}/${list.length} ${c.display.padEnd(10)}`);
    try {
      const h = c.histSymbol;
      data[c.symbol] = {
        d: await cached(h, '1D', start - 260 * DAY),
        f: await cached(h, '4H', start - 40 * DAY),
        h: await cached(h, '1H', start - 2 * DAY),
      };
      if (data[c.symbol].h.length < 48) throw new Error('historique insuffisant');
    } catch (e) {
      delete data[c.symbol];
      console.log(`\n  ${c.display} ignoré : ${e.message}`);
    }
  }
  console.log('');
  return { data, start, syms: Object.keys(data), btc };
}

function simulate(trade, bars, V) {
  const isL = trade.side === 'long';
  const dir = isL ? 1 : -1;
  const cost = (V.feePct + V.slipPct) / 100;
  if (!bars.length) return null;
  const entry = bars[0].o;
  let stop;
  let tp1 = null;
  if (V.stopMode === 'fixed') stop = entry * (1 - (dir * V.fixedStopPct) / 100);
  else if (V.stopMode === 'atr') {
    // stop calé sur la volatilité journalière
    stop = entry * (1 - (dir * V.stopAtr * trade.atrPct) / 100);
    if (V.tp1Frac > 0) tp1 = entry * (1 + (dir * V.tp1R * V.stopAtr * trade.atrPct) / 100);
  } else {
    // garde la distance structurelle (en %) calculée à la décision
    stop = entry * (1 - (dir * trade.riskPct) / 100);
    if (V.tp1Frac > 0) tp1 = entry * (1 + (dir * Math.abs(trade.tp1 / trade.price - 1)));
  }
  const riskPct = Math.abs(stop / entry - 1) * 100;
  let remaining = 1;
  let realized = 0; // en fraction du notionnel
  let best = entry;
  let trailing = false;
  let exitReason = 'durée max';
  let exitIdx = Math.min(bars.length, V.maxHoldH) - 1;
  const n = Math.min(bars.length, V.maxHoldH);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    // 1) stop (prioritaire, hypothèse prudente)
    if (isL ? b.l <= stop : b.h >= stop) {
      const px = isL ? Math.min(b.o, stop) : Math.max(b.o, stop);
      realized += remaining * dir * (px / entry - 1);
      remaining = 0;
      exitReason = trailing ? 'trailing' : realized >= 0 ? 'stop gagnant' : 'stop';
      exitIdx = i;
      break;
    }
    // 2) objectif 1 partiel
    if (tp1 && remaining === 1 && (isL ? b.h >= tp1 : b.l <= tp1)) {
      realized += V.tp1Frac * dir * (tp1 / entry - 1);
      remaining -= V.tp1Frac;
      if (V.breakeven) stop = isL ? Math.max(stop, entry * 1.001) : Math.min(stop, entry * 0.999);
    }
    // 3) trailing (appliqué à partir de la bougie suivante)
    best = isL ? Math.max(best, b.h) : Math.min(best, b.l);
    const gain = (dir * (best / entry - 1)) * 100;
    const actPct = V.trailInR ? V.trailAct * riskPct : V.trailAct;
    const distPct = V.trailInR ? V.trailDist * riskPct : V.trailDist;
    if (gain >= actPct) {
      trailing = true;
      const ts = best * (1 - (dir * distPct) / 100);
      stop = isL ? Math.max(stop, ts) : Math.min(stop, ts);
    }
    if (i === n - 1 && remaining > 0) {
      realized += remaining * dir * (b.c / entry - 1);
      remaining = 0;
    }
  }
  return { ret: realized - 2 * cost, riskPct, exitReason, entry, exitT: bars[exitIdx].t + 3600_000 };
}

export function runVariant(D, V) {
  const P = { ...DEFAULT_PARAMS, ...V.params };
  const btc = D.data[D.btc];
  const days = [];
  const trades = [];
  const open = []; // positions en cours : { symbol, side, exitT, pnl }
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (let day = D.start; day < Date.now() - DAY - SKIP * DAY; day += DAY) {
    const T = day + HOUR * 3600_000;
    // clôtures entre la liste précédente et celle-ci : P&L comptabilisé maintenant
    let dayRet = 0;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].exitT <= T) {
        dayRet += open[i].pnl;
        open.splice(i, 1);
      }
    }
    const btcD = btc.d.slice(0, closedBefore(btc.d, T, DAY));
    const btcC = btcD.map((k) => k.c);
    const btcE50 = btcC.length > 50 ? btcC.slice(-50).reduce((a, b) => a + b, 0) / 50 : null;
    const regime = btcE50 == null ? null : btcC.at(-1) > btcE50 ? 'long' : 'short';
    const rows = [];
    for (const s of D.syms) {
      if (open.some((o) => o.symbol === s)) continue;
      const x = D.data[s];
      const nd = closedBefore(x.d, T, DAY);
      const nf = closedBefore(x.f, T, 4 * 3600_000);
      const nh = closedBefore(x.h, T, 3600_000);
      if (nd < 60 || nf < 60 || nh < 1) continue;
      const d = x.d.slice(Math.max(0, nd - 250), nd);
      const f = x.f.slice(Math.max(0, nf - 150), nf);
      const price = x.h[nh - 1].c;
      const a = analyze(s, d, f, price, 0, btcD.slice(-60), { ...P, isBtc: s === D.btc });
      if (!a) continue;
      if (V.btcRegime && regime && a.side !== regime) continue;
      if (V.invert) a.side = a.side === 'long' ? 'short' : 'long';
      rows.push({ ...a, _nh: nh });
    }
    const freeSlots = V.maxPositions - open.length;
    const picks = freeSlots > 0 ? selectCandidates(rows, { listSize: V.listSize, maxPerSide: V.maxPerSide, maxCorrBudget: V.corrBudget }) : [];
    for (const p of picks) {
      if (open.length >= V.maxPositions) break;
      if (open.filter((o) => o.side === p.side).length >= V.maxPerSide) continue;
      const bars = D.data[p.symbol].h.slice(p._nh, p._nh + V.maxHoldH);
      const r = simulate(p, bars, V);
      if (!r) continue;
      let notional = (V.marginPct / 100) * V.leverage;
      if (V.riskPerTradePct) notional = Math.min((V.riskPerTradePct / 100) / (r.riskPct / 100), (V.maxMarginPct / 100) * V.leverage);
      const pnl = notional * r.ret;
      open.push({ symbol: p.symbol, side: p.side, exitT: r.exitT, pnl });
      trades.push({ day, symbol: p.symbol, side: p.side, score: p.score, pnl, ret: r.ret, R: r.ret / (r.riskPct / 100), exit: r.exitReason, holdH: (r.exitT - T) / 3600_000 });
    }
    equity *= 1 + dayRet;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, 1 - equity / peak);
    days.push({ day, ret: dayRet, equity });
  }
  for (const o of open) equity *= 1 + o.pnl; // positions encore ouvertes à la fin
  const wins = trades.filter((t) => t.pnl > 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const dr = days.map((x) => x.ret);
  const mean = dr.reduce((s, v) => s + v, 0) / (dr.length || 1);
  const sd = Math.sqrt(dr.reduce((s, v) => s + (v - mean) ** 2, 0) / (dr.length || 1));
  const half = Math.floor(days.length / 2);
  const ret1 = days[half - 1] ? days[half - 1].equity - 1 : 0;
  const ret2 = days.length ? days.at(-1).equity / (days[half - 1]?.equity || 1) - 1 : 0;
  return {
    name: V.name,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgR: trades.length ? trades.reduce((s, t) => s + t.R, 0) / trades.length : 0,
    profitFactor: gl ? gp / gl : gp ? 99 : 0,
    totalRet: equity - 1,
    firstHalf: ret1,
    secondHalf: ret2,
    maxDD,
    sharpe: sd ? (mean / sd) * Math.sqrt(365) : 0,
    longs: trades.filter((t) => t.side === 'long').length,
    trades_: trades,
    days_: days,
  };
}

// ---------- Variantes comparées ----------
const BASE = {
  // OKX X-Perps : moins liquides → frais et slippage plus prudents
  feePct: ex.name === 'okx' ? 0.05 : 0.04,
  slipPct: ex.name === 'okx' ? 0.1 : 0.05,
  leverage: 5,
  marginPct: 5,
  maxMarginPct: 10,
  maxPositions: 5,
  listSize: 5,
  maxPerSide: 3,
  corrBudget: 99,
  maxHoldH: 24,
  stopMode: 'fixed',
  fixedStopPct: 2.5,
  trailInR: false,
  trailAct: 4,
  trailDist: 2,
  tp1Frac: 0,
  breakeven: false,
  riskPerTradePct: 0,
  stopAtr: 1.5,
  tp1R: 1.5,
  btcRegime: false,
  invert: false,
};
const LOOSE = { requireAlign: false, minRR1: 0, maxExtAtr: 99, rangeEdge: 0, maxStopPct: 99 };

export const VARIANTS = [
  { ...BASE, name: 'A · bot actuel (stop fixe 2,5 %, sans filtres)', params: LOOSE },
  { ...BASE, name: 'B · A + filtres qualité', params: {} },
  { ...BASE, name: 'C · B + stop structurel', stopMode: 'structure', params: {} },
  { ...BASE, name: 'D · C + objectif 1 (50 %) + seuil de rentabilité', stopMode: 'structure', tp1Frac: 0.5, breakeven: true, params: {} },
  { ...BASE, name: 'E · D + taille au risque (0,6 %/trade)', stopMode: 'structure', tp1Frac: 0.5, breakeven: true, riskPerTradePct: 0.6, params: {} },
  { ...BASE, name: 'F · E + budget corrélation BTC 2,4', stopMode: 'structure', tp1Frac: 0.5, breakeven: true, riskPerTradePct: 0.6, corrBudget: 2.4, params: {} },
  { ...BASE, name: 'G · F + trailing en R (1,5 R / 1 R)', stopMode: 'structure', tp1Frac: 0.5, breakeven: true, riskPerTradePct: 0.6, corrBudget: 2.4, trailInR: true, trailAct: 1.5, trailDist: 1, params: {} },
  { ...BASE, name: 'H · F + détention 48 h', stopMode: 'structure', tp1Frac: 0.5, breakeven: true, riskPerTradePct: 0.6, corrBudget: 2.4, maxHoldH: 48, params: {} },
  { ...BASE, name: 'I · F + score min 75', stopMode: 'structure', tp1Frac: 0.5, breakeven: true, riskPerTradePct: 0.6, corrBudget: 2.4, params: { minScore: 75 } },
  { ...BASE, name: 'J · F sans filtre "bord de range"', stopMode: 'structure', tp1Frac: 0.5, breakeven: true, riskPerTradePct: 0.6, corrBudget: 2.4, params: { rangeEdge: 0 } },
  // --- hypothèse 2 : laisser respirer (stop sur la volatilité, plusieurs jours) ---
  ...[
    ['K · stop 1×ATR jour, 3 j, trailing 1,5 R/1 R', { stopAtr: 1, maxHoldH: 72 }],
    ['L · stop 1,5×ATR jour, 5 j, trailing 1,5 R/1 R', { stopAtr: 1.5, maxHoldH: 120 }],
    ['M · stop 2×ATR jour, 10 j, trailing 1,5 R/1 R', { stopAtr: 2, maxHoldH: 240 }],
  ].map(([name, o]) => ({ ...BASE, name, stopMode: 'atr', trailInR: true, trailAct: 1.5, trailDist: 1, riskPerTradePct: 0.6, corrBudget: 2.4, params: { ...LOOSE, maxStopPct: 99 }, ...o })),
  // --- hypothèse 3 : ne trader que dans le sens du BTC (BTC vs moyenne 50 j) ---
  { ...BASE, name: 'N · L + régime BTC', stopMode: 'atr', stopAtr: 1.5, maxHoldH: 120, trailInR: true, trailAct: 1.5, trailDist: 1, riskPerTradePct: 0.6, corrBudget: 2.4, btcRegime: true, params: { ...LOOSE } },
  { ...BASE, name: 'O · N + filtres qualité', stopMode: 'atr', stopAtr: 1.5, maxHoldH: 120, trailInR: true, trailAct: 1.5, trailDist: 1, riskPerTradePct: 0.6, corrBudget: 2.4, btcRegime: true, params: { maxStopPct: 99, minRR1: 0 } },
  // --- diagnostic (pas une stratégie à suivre) : signal inversé sur 24 h ---
  { ...BASE, name: 'Z · diagnostic : signal A inversé', params: LOOSE, invert: true },
];

const N = { ...BASE, stopMode: 'atr', stopAtr: 1.5, maxHoldH: 120, trailInR: true, trailAct: 1.5, trailDist: 1, riskPerTradePct: 0.6, corrBudget: 2.4, btcRegime: true, params: { ...LOOSE } };
export const ROBUST = [
  { ...N, name: 'N · référence (1,5 ATR, 5 j, 1,5 R/1 R)' },
  { ...N, name: 'stop 1,25 ATR', stopAtr: 1.25 },
  { ...N, name: 'stop 1,75 ATR', stopAtr: 1.75 },
  { ...N, name: 'stop 2 ATR', stopAtr: 2 },
  { ...N, name: 'détention 3 j', maxHoldH: 72 },
  { ...N, name: 'détention 7 j', maxHoldH: 168 },
  { ...N, name: 'trailing 1 R / 1 R', trailAct: 1, trailDist: 1 },
  { ...N, name: 'trailing 2 R / 1,5 R', trailAct: 2, trailDist: 1.5 },
  { ...N, name: '+ objectif 50 % à 1,5 R + seuil rentab.', tp1Frac: 0.5, breakeven: true },
  { ...N, name: 'score min 55', params: { ...LOOSE, minScore: 55 } },
  { ...N, name: 'score min 75', params: { ...LOOSE, minScore: 75 } },
  { ...N, name: '3 positions max', maxPositions: 3 },
  { ...N, name: '8 positions max, 4/côté', maxPositions: 8, maxPerSide: 4, listSize: 8 },
  { ...N, name: 'sans budget corrélation', corrBudget: 99 },
  { ...N, name: 'marge fixe 5 % x5 (au lieu du risque)', riskPerTradePct: 0 },
  { ...N, name: 'risque 1 %/trade', riskPerTradePct: 1 },
  { ...N, name: 'sans régime BTC (= L)', btcRegime: false },
];

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  console.log(`Backtest ${ex.label} · ${DAYS} jours${SKIP ? ` (hors échantillon : se termine ${SKIP} j avant aujourd'hui)` : ''} · liste à ${HOUR}h UTC · top ${TOP} contrats`);
  const D = await loadData();
  const pct = (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + ' %';
  const results = (args.set === 'robust' ? ROBUST : VARIANTS).map((V) => runVariant(D, V));
  console.log('\nVariante'.padEnd(54) + 'trades  réussite  R moyen  PF    total     1re moitié 2e moitié  DD max   Sharpe');
  for (const r of results) {
    console.log(
      r.name.padEnd(53),
      String(r.trades).padStart(6),
      (r.winRate * 100).toFixed(0).padStart(7) + ' %',
      r.avgR.toFixed(2).padStart(8),
      r.profitFactor.toFixed(2).padStart(5),
      pct(r.totalRet).padStart(9),
      pct(r.firstHalf).padStart(10),
      pct(r.secondHalf).padStart(10),
      pct(-r.maxDD).padStart(8),
      r.sharpe.toFixed(2).padStart(7)
    );
  }
  const out = path.join(config.dataDir, 'backtest.json');
  fs.writeFileSync(out, JSON.stringify(results.map(({ trades_, days_, ...r }) => ({ ...r, days: days_.map((d) => ({ t: d.day, eq: +d.equity.toFixed(5) })) })), null, 1));
  console.log(`\nDétail : ${out}`);
  console.log('Attention : univers = contrats liquides aujourd’hui (biais du survivant), funding non simulé. Un bon backtest ne garantit rien.');
}
