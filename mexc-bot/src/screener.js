// LISTE DU MATIN — analyse les contrats crypto les plus liquides de MEXC Futures
// avec la stratégie de src/strategy.js (la même que celle du backtest).
//
// Score 0-100 (même logique, inversée pour le short) :
//   tendance journalière (25) · tendance 4 h (20) · momentum RSI jour (20)
//   force relative vs BTC (15) · volume (10) · funding (10)
// + régime BTC : seulement des longs si le BTC est au-dessus de sa moyenne 50 j, seulement des shorts sinon.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as mexc from './mexc.js';
import { last } from './indicators.js';
import { analyze, selectCandidates } from './strategy.js';
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

/** Régime de marché : BTC au-dessus / en dessous de sa moyenne mobile 50 jours. */
export function btcRegime(btcClosed) {
  const c = btcClosed.map((k) => k.c);
  if (c.length < 50) return null;
  const sma50 = c.slice(-50).reduce((a, b) => a + b, 0) / 50;
  return { side: last(c) > sma50 ? 'long' : 'short', price: last(c), sma50 };
}

/** Génère la liste du jour, l'écrit dans listes/AAAA-MM-JJ.json et .md, et la renvoie. */
export async function generateList(onProgress = () => {}) {
  const manual = readManual();
  const { universe } = await buildUniverse(manual);
  log(`Liste du matin : analyse de ${universe.length} contrats crypto MEXC…`);

  const now = Date.now();
  const closedD = (k) => k.filter((x) => x.t + 86_400_000 <= now);
  const btcD = closedD(await mexc.getKlines('BTC_USDT', 'Day1', 260));
  const regime = config.btcRegime ? btcRegime(btcD) : null;
  const btcRet7 = (last(btcD).c / btcD[btcD.length - 8].c - 1) * 100;
  if (regime) log(`Régime BTC : ${regime.side === 'long' ? 'HAUSSIER' : 'BAISSIER'} (BTC ${Math.round(regime.price)} vs moyenne 50 j ${Math.round(regime.sma50)}) → seulement des ${regime.side === 'long' ? 'LONGS' : 'SHORTS'}`);

  const params = config.strategy;
  const results = [];
  let i = 0;
  for (const { contract, ticker } of universe) {
    i++;
    onProgress(i, universe.length, contract.symbol);
    try {
      const d = closedD(await mexc.getKlines(contract.symbol, 'Day1', 260));
      const f = (await mexc.getKlines(contract.symbol, 'Hour4', 150)).filter((x) => x.t + 14_400_000 <= now);
      const a = analyze(contract.symbol, d, f, +ticker.lastPrice, +ticker.fundingRate * 100, btcD.slice(-60), params);
      if (!a) continue;
      a.turnover24 = +ticker.amount24;
      // Le bot utilise un stop ATR (validé par backtest), pas le stop structurel de l'analyse.
      a.why = a.why.filter((w) => !w.startsWith('stop ')).concat(`stop ${(config.stopAtr * a.atrPct).toFixed(1)} % (${config.stopAtr} ATR)`);
      if (regime && a.side !== regime.side && !manual.forcerLong.includes(a.symbol) && !manual.forcerShort.includes(a.symbol)) {
        a.ok = false;
        a.rejects.push(`contre le régime BTC (${regime.side})`);
      }
      results.push(a);
    } catch (e) {
      log(`${contract.symbol} ignoré : ${e.message}`, 'warn');
    }
  }

  // Forçages manuels
  for (const r of results) {
    if (manual.forcerLong.includes(r.symbol) || manual.forcerShort.includes(r.symbol)) {
      r.side = manual.forcerLong.includes(r.symbol) ? 'long' : 'short';
      r.forced = true;
      r.ok = true;
    }
  }
  const forced = results.filter((r) => r.forced);
  const auto = selectCandidates(
    results.filter((r) => !r.forced),
    { listSize: config.listSize, maxPerSide: config.maxPerSide, maxCorrBudget: config.corrBudget }
  ).slice(0, Math.max(0, config.listSize - forced.length));
  const picked = [...forced, ...auto];
  const longs = picked.filter((r) => r.side === 'long');
  const shorts = picked.filter((r) => r.side === 'short');

  const list = {
    date: today(),
    generatedAt: Date.now(),
    btcRet7d: +btcRet7.toFixed(2),
    regime: regime ? regime.side : null,
    analyzed: results.length,
    longs,
    shorts,
    rejected: results
      .filter((r) => !picked.includes(r))
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map((r) => ({ symbol: r.symbol, side: r.side, score: r.score, why: r.rejects.join(', ') || 'liste pleine / budget corrélation' })),
  };
  writeList(list);
  log(`Liste du ${list.date} : ${longs.length} LONG (${longs.map((x) => x.symbol).join(', ') || '—'}) · ${shorts.length} SHORT (${shorts.map((x) => x.symbol).join(', ') || '—'})`);
  return list;
}

function writeList(list) {
  fs.writeFileSync(path.join(config.listDir, `${list.date}.json`), JSON.stringify(list, null, 2));
  const row = (r) =>
    `| ${r.symbol}${r.forced ? ' (forcé)' : ''} | ${r.score} | ${r.price} | ${r.rsi} | ${r.ret7d} % | ${r.atrPct} % | ${r.fundingPct} % | ${r.why.join(', ')} |`;
  const head = '| Contrat | Score | Prix | RSI | 7 j | ATR jour | Funding | Pourquoi |\n|---|---|---|---|---|---|---|---|';
  const md = `# Liste du ${list.date}

Générée le ${new Date(list.generatedAt).toLocaleString('fr-FR')} · ${list.analyzed} contrats analysés · BTC 7 j : ${list.btcRet7d} % · régime BTC : ${list.regime ?? 'désactivé'}

## LONG
${list.longs.length ? head + '\n' + list.longs.map(row).join('\n') : 'Aucun candidat.'}

## SHORT
${list.shorts.length ? head + '\n' + list.shorts.map(row).join('\n') : 'Aucun candidat.'}

_Analyse technique automatique. Ce n'est pas un conseil financier._
`;
  fs.writeFileSync(path.join(config.listDir, `${list.date}.md`), md);
}
