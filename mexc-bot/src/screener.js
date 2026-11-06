// LISTE DU MATIN — analyse les contrats crypto les plus liquides de MEXC Futures
// et classe chacun en LONG ou SHORT avec un score de 0 à 100.
//
// Critères (même logique, inversée pour le short) :
//   tendance journalière (25)  prix vs EMA20/EMA50 jour, pente de l'EMA20
//   tendance 4 h (20)          prix vs EMA20/EMA50 4 h
//   momentum RSI jour (20)     zone saine, pas de surachat / survente extrême
//   force relative (15)        perf 7 jours vs BTC
//   volume (10)                volume d'hier vs moyenne 20 jours
//   funding (10)               évite le côté déjà surchargé
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as mexc from './mexc.js';
import { ema, rsi, atrPct, last, lin } from './indicators.js';
import { log, today } from './state.js';

const STABLES = new Set(['USDC', 'USDT', 'FDUSD', 'TUSD', 'USDE', 'DAI', 'USD1', 'PYUSD', 'USDD', 'BUSD']);

function readManual() {
  const file = path.join(config.listDir, 'manuel.json');
  const empty = { exclure: [], forcerLong: [], forcerShort: [] };
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify(
        { _aide: 'Symboles au format BTC_USDT. exclure = jamais tradé ; forcerLong / forcerShort = ajouté à la liste même avec un score faible.', ...empty },
        null,
        2
      )
    );
    return empty;
  }
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const norm = (a) => (Array.isArray(a) ? a.map((s) => String(s).toUpperCase().trim()) : []);
    return { exclure: norm(m.exclure), forcerLong: norm(m.forcerLong), forcerShort: norm(m.forcerShort) };
  } catch (e) {
    log(`manuel.json illisible (${e.message}), ignoré`, 'warn');
    return empty;
  }
}

/** Univers : contrats perpétuels crypto en USDT, ouverts à l'API, triés par volume 24 h. */
export async function buildUniverse(manual) {
  const [contracts, tickers] = await Promise.all([mexc.getContracts(), mexc.getTickers()]);
  const tick = new Map(tickers.map((t) => [t.symbol, t]));
  const out = [];
  for (const c of contracts) {
    const t = tick.get(c.symbol);
    if (!t) continue;
    const plates = (c.conceptPlate || []).map((p) => String(p).toLowerCase());
    const isTradfi = plates.some((p) => p.includes('tradfi') || p.includes('stock') || p.includes('forex') || p.includes('commodit') || p.includes('metal'));
    if (
      c.quoteCoin !== 'USDT' ||
      c.settleCoin !== 'USDT' ||
      c.state !== 0 ||
      c.apiAllowed === false ||
      c.isHidden ||
      c.preMarket ||
      isTradfi ||
      STABLES.has(c.baseCoin) ||
      config.exclude.includes(c.symbol) ||
      manual.exclure.includes(c.symbol)
    )
      continue;
    if (+t.amount24 < config.minTurnoverUsdt && !manual.forcerLong.includes(c.symbol) && !manual.forcerShort.includes(c.symbol)) continue;
    out.push({ contract: c, ticker: t });
  }
  out.sort((a, b) => b.ticker.amount24 - a.ticker.amount24);
  const forced = out.filter((x) => manual.forcerLong.includes(x.contract.symbol) || manual.forcerShort.includes(x.contract.symbol));
  const top = out.slice(0, config.universeSize);
  for (const f of forced) if (!top.includes(f)) top.push(f);
  return { universe: top, contracts: new Map(contracts.map((c) => [c.symbol, c])) };
}

function analyze(symbol, daily, h4, ticker, btcRet7) {
  // On n'utilise que des bougies clôturées.
  const now = Date.now();
  const d = daily.filter((k) => k.t + 86_400_000 <= now);
  const f = h4.filter((k) => k.t + 14_400_000 <= now);
  if (d.length < 55 || f.length < 55) return null;

  const dc = d.map((k) => k.c);
  const fc = f.map((k) => k.c);
  const price = +ticker.lastPrice;
  const e20 = ema(dc, 20);
  const e50 = ema(dc, 50);
  const e20v = last(e20);
  const e50v = last(e50);
  const e20prev = e20[e20.length - 6];
  const f20 = last(ema(fc, 20));
  const f50 = last(ema(fc, 50));
  const r = rsi(dc, 14);
  const atr = atrPct(d, 14);
  const ret7 = (last(dc) / dc[dc.length - 8] - 1) * 100;
  const avgAmt = d.slice(-21, -1).reduce((s, k) => s + k.amount, 0) / 20;
  const volRatio = avgAmt > 0 ? last(d).amount / avgAmt : 1;
  const funding = +ticker.fundingRate * 100; // en %
  const rs = ret7 - btcRet7;

  const L = { trendD: 0, trend4h: 0, momentum: 0, rs: 0, volume: 0, funding: 0 };
  const S = { ...L };

  // Tendance journalière
  if (price > e20v) L.trendD += 10;
  else S.trendD += 10;
  if (e20v > e50v) L.trendD += 10;
  else S.trendD += 10;
  if (e20v > e20prev) L.trendD += 5;
  else S.trendD += 5;
  // Tendance 4 h
  if (price > f20) L.trend4h += 10;
  else S.trend4h += 10;
  if (f20 > f50) L.trend4h += 10;
  else S.trend4h += 10;
  // Momentum RSI
  L.momentum = r >= 50 && r <= 68 ? 20 : r > 68 && r <= 75 ? 10 : r >= 45 && r < 50 ? 8 : 0;
  S.momentum = r >= 32 && r <= 50 ? 20 : r >= 25 && r < 32 ? 10 : r > 50 && r <= 55 ? 8 : 0;
  // Force relative vs BTC (BTC lui-même : neutre)
  L.rs = symbol === 'BTC_USDT' ? 7.5 : lin(rs, -10, 10, 15);
  S.rs = symbol === 'BTC_USDT' ? 7.5 : lin(-rs, -10, 10, 15);
  // Volume : confirme le mouvement
  const vScore = lin(volRatio, 0.8, 2, 10);
  if (last(dc) >= dc[dc.length - 2]) L.volume = vScore;
  else S.volume = vScore;
  // Funding : longs surchargés si funding très positif, shorts surchargés si très négatif
  L.funding = lin(-funding, -0.05, -0.01, 10);
  S.funding = lin(funding, -0.05, -0.01, 10);

  const sum = (o) => Math.round(Object.values(o).reduce((s, v) => s + v, 0));
  const longScore = sum(L);
  const shortScore = sum(S);
  const side = longScore >= shortScore ? 'long' : 'short';
  const score = Math.max(longScore, shortScore);
  const parts = side === 'long' ? L : S;

  const why = [];
  if (parts.trendD >= 20) why.push(side === 'long' ? 'tendance jour haussière' : 'tendance jour baissière');
  if (parts.trend4h >= 20) why.push('4 h aligné');
  if (parts.momentum >= 20) why.push(`RSI ${r.toFixed(0)}`);
  if (parts.rs >= 10) why.push(`${side === 'long' ? 'surperforme' : 'sous-performe'} BTC (${rs >= 0 ? '+' : ''}${rs.toFixed(1)} % / 7 j)`);
  if (parts.volume >= 6) why.push(`volume x${volRatio.toFixed(1)}`);
  if (parts.funding < 4) why.push(`funding défavorable ${funding.toFixed(3)} %`);

  return {
    symbol,
    side,
    score,
    price,
    atrPct: +atr.toFixed(2),
    rsi: +r.toFixed(1),
    ret7d: +ret7.toFixed(2),
    rsBtc: +rs.toFixed(2),
    volRatio: +volRatio.toFixed(2),
    fundingPct: +funding.toFixed(4),
    turnover24: +ticker.amount24,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
    why,
  };
}

/** Génère la liste du jour, l'écrit dans listes/AAAA-MM-JJ.json et .md, et la renvoie. */
export async function generateList(onProgress = () => {}) {
  const manual = readManual();
  const { universe } = await buildUniverse(manual);
  log(`Liste du matin : analyse de ${universe.length} contrats crypto MEXC…`);

  const btcD = await mexc.getKlines('BTC_USDT', 'Day1', 90);
  const btcC = btcD.filter((k) => k.t + 86_400_000 <= Date.now()).map((k) => k.c);
  const btcRet7 = (last(btcC) / btcC[btcC.length - 8] - 1) * 100;

  const results = [];
  let i = 0;
  for (const { contract, ticker } of universe) {
    i++;
    onProgress(i, universe.length, contract.symbol);
    try {
      const daily = await mexc.getKlines(contract.symbol, 'Day1', 90);
      const h4 = await mexc.getKlines(contract.symbol, 'Hour4', 120);
      const a = analyze(contract.symbol, daily, h4, ticker, btcRet7);
      if (a) results.push(a);
    } catch (e) {
      log(`${contract.symbol} ignoré : ${e.message}`, 'warn');
    }
  }

  const volOk = (r) => r.atrPct >= config.minAtrPct && r.atrPct <= config.maxAtrPct;
  const pick = (side, forced) => {
    const forcedRows = results.filter((r) => forced.includes(r.symbol)).map((r) => ({ ...r, side, forced: true }));
    const auto = results
      .filter((r) => r.side === side && r.score >= config.minScore && volOk(r) && !forced.includes(r.symbol))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, config.listSize - forcedRows.length));
    return [...forcedRows, ...auto];
  };
  const longs = pick('long', manual.forcerLong);
  const shorts = pick('short', manual.forcerShort.filter((s) => !manual.forcerLong.includes(s)));

  const list = {
    date: today(),
    generatedAt: Date.now(),
    btcRet7d: +btcRet7.toFixed(2),
    analyzed: results.length,
    longs,
    shorts,
    rejected: results
      .filter((r) => !longs.some((x) => x.symbol === r.symbol) && !shorts.some((x) => x.symbol === r.symbol))
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map((r) => ({ symbol: r.symbol, side: r.side, score: r.score, atrPct: r.atrPct, why: !volOk(r) ? `volatilité ${r.atrPct} % hors plage` : r.score < config.minScore ? `score < ${config.minScore}` : 'liste pleine (moins bon score)' })),
  };
  writeList(list);
  log(`Liste du ${list.date} : ${longs.length} LONG (${longs.map((x) => x.symbol).join(', ') || '—'}) · ${shorts.length} SHORT (${shorts.map((x) => x.symbol).join(', ') || '—'})`);
  return list;
}

function writeList(list) {
  fs.writeFileSync(path.join(config.listDir, `${list.date}.json`), JSON.stringify(list, null, 2));
  const row = (r) =>
    `| ${r.symbol}${r.forced ? ' (forcé)' : ''} | ${r.score} | ${r.price} | ${r.rsi} | ${r.ret7d} % | ${r.atrPct} % | ${r.fundingPct} % | ${r.why.join(', ')} |`;
  const head = '| Contrat | Score | Prix | RSI | 7 j | ATR | Funding | Pourquoi |\n|---|---|---|---|---|---|---|---|';
  const md = `# Liste du ${list.date}

Générée le ${new Date(list.generatedAt).toLocaleString('fr-FR')} · ${list.analyzed} contrats analysés · BTC 7 j : ${list.btcRet7d} %

## LONG
${list.longs.length ? head + '\n' + list.longs.map(row).join('\n') : 'Aucun candidat.'}

## SHORT
${list.shorts.length ? head + '\n' + list.shorts.map(row).join('\n') : 'Aucun candidat.'}

_Analyse technique automatique. Ce n'est pas un conseil financier._
`;
  fs.writeFileSync(path.join(config.listDir, `${list.date}.md`), md);
}
