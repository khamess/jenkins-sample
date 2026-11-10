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
import { ex, baseOf } from './exchange.js';
import { last } from './indicators.js';
import { analyze, selectCandidates } from './strategy.js';
import { log, today } from './state.js';

function readManual() {
  const file = path.join(config.listDir, 'manuel.json');
  const empty = { exclure: [], forcerLong: [], forcerShort: [] };
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      JSON.stringify({ _aide: 'Noms de cryptos (ex. "SOL", "BTC"). exclure = jamais tradé ; forcerLong / forcerShort = ajouté à la liste même avec un score faible.', ...empty }, null, 2)
    );
    return empty;
  }
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const norm = (a) => (Array.isArray(a) ? a.map(baseOf) : []); // accepte "SOL", "SOL_USDT", "SOL-USDT"…
    return { exclure: norm(m.exclure), forcerLong: norm(m.forcerLong), forcerShort: norm(m.forcerShort) };
  } catch (e) {
    log(`manuel.json illisible (${e.message}), ignoré`, 'warn');
    return empty;
  }
}

const defaultTurnover = () => config.minTurnoverUsdt || { okx: 500_000, weex: 10_000_000 }[ex.name] || 8_000_000;

/** Univers : contrats crypto de la plateforme, triés par volume 24 h. */
export async function buildUniverse(manual) {
  const [contracts, tickers] = await Promise.all([ex.getContracts(), ex.getTickers()]);
  const excluded = new Set([...config.exclude.map(baseOf), ...manual.exclure]);
  const forcedBases = new Set([...manual.forcerLong, ...manual.forcerShort]);
  const out = [];
  for (const c of contracts) {
    const t = tickers.get(c.symbol);
    if (!t || excluded.has(c.base)) continue;
    if (t.turnover24 < defaultTurnover() && !forcedBases.has(c.base)) continue;
    out.push({ contract: c, ticker: t });
  }
  out.sort((x, y) => y.ticker.turnover24 - x.ticker.turnover24);
  const top = out.slice(0, config.universeSize);
  for (const f of out) if (forcedBases.has(f.contract.base) && !top.includes(f)) top.push(f);
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
  log(`Liste du matin : analyse de ${universe.length} contrats crypto ${ex.label}…`);

  const now = Date.now();
  const closedD = (k) => k.filter((x) => x.t + 86_400_000 <= now);
  const btcSym = ex.btcSymbol();
  if (!btcSym) throw new Error(`contrat BTC introuvable sur ${ex.label}`);
  const btcD = closedD(await ex.getKlines(btcSym, '1D', 260));
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
      const d = closedD(await ex.getKlines(contract.symbol, '1D', 260));
      const f = (await ex.getKlines(contract.symbol, '4H', 150)).filter((x) => x.t + 14_400_000 <= now);
      const funding = ticker.fundingPct ?? (await ex.getFundingPct(contract.symbol));
      const a = analyze(contract.symbol, d, f, ticker.last, funding, btcD.slice(-60), { ...params, isBtc: contract.base === 'BTC' });
      if (!a) continue;
      a.turnover24 = ticker.turnover24;
      a.base = contract.base;
      a.display = contract.display;
      // Le bot utilise un stop ATR (validé par backtest), pas le stop structurel de l'analyse.
      a.why = a.why.filter((w) => !w.startsWith('stop ')).concat(`stop ${(config.stopAtr * a.atrPct).toFixed(1)} % (${config.stopAtr} ATR)`);
      if (regime && a.side !== regime.side && !manual.forcerLong.includes(a.base) && !manual.forcerShort.includes(a.base)) {
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
    if (manual.forcerLong.includes(r.base) || manual.forcerShort.includes(r.base)) {
      r.side = manual.forcerLong.includes(r.base) ? 'long' : 'short';
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
    exchange: ex.label,
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
  log(`Liste du ${list.date} (${ex.label}) : ${longs.length} LONG (${longs.map((x) => x.display).join(', ') || '—'}) · ${shorts.length} SHORT (${shorts.map((x) => x.display).join(', ') || '—'})`);
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
