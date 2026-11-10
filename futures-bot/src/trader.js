// EXÉCUTION + RISQUE — ouvre les positions de la liste, pose le stop chez la plateforme,
// gère le trailing stop (en R), la durée max et le coupe-circuit journalier.
// Mode paper : simulation avec les vrais prix. Mode live : vrais ordres (OKX ou MEXC, via src/exchange.js).
import { config } from './config.js';
import { ex } from './exchange.js';
import { state, log, changed, recordTrade, today } from './state.js';

const isLive = () => config.mode === 'live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let contracts = new Map();
let contractsLoadedAt = 0;

export async function loadContracts(force = false) {
  if (!force && Date.now() - contractsLoadedAt < 6 * 3600_000 && contracts.size) return contracts;
  contracts = new Map((await ex.getContracts()).map((c) => [c.symbol, c]));
  contractsLoadedAt = Date.now();
  return contracts;
}

const decimals = (step) => {
  const s = String(step);
  return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length;
};
const roundTick = (c, p) => +(Math.round(p / c.tickSz) * c.tickSz).toFixed(decimals(c.tickSz));
const roundLot = (c, q) => +(Math.floor(q / c.lotSz + 1e-9) * c.lotSz).toFixed(decimals(c.lotSz));
const isLong = (p) => p.side === 'long';
const fmt = (v) => +Number(v).toPrecision(6);
const pnlOf = (p, price) => (isLong(p) ? price - p.entryPrice : p.entryPrice - price) * p.contracts * p.contractSize;
const short = (sym) => contracts.get(sym)?.display || sym;

// ---------- Solde ----------
export async function refreshEquity() {
  const w = state.wallet;
  if (isLive()) {
    const b = await ex.getBalance();
    w.equityUsdt = b.equity;
    w.cashUsdt = b.available;
  } else {
    w.equityUsdt = w.cashUsdt + state.positions.reduce((s, p) => s + p.marginUsdt + p.pnlUsdt, 0);
  }
  const day = today();
  if (w.day !== day) {
    w.day = day;
    w.dayStartEquity = w.equityUsdt;
  }
  return w.equityUsdt;
}

export async function initTrader() {
  await loadContracts(true);
  if (isLive()) {
    const info = await ex.init();
    if (Math.abs(info.offset) > 5000) log(`Horloge du PC décalée de ${(info.offset / 1000).toFixed(1)} s par rapport à ${ex.label} (corrigé automatiquement)`, 'warn');
    const b = await ex.getBalance();
    log(`MODE LIVE — compte ${ex.label} : ${b.equity.toFixed(2)} ${ex.quote} (disponible ${b.available.toFixed(2)}) · ${info.notes.join(' · ')}`, 'warn');
    if (!state.wallet.startUsdt) state.wallet.startUsdt = b.equity;
    await reconcileLive(new Map());
  } else if (!state.wallet.startUsdt) {
    state.wallet.startUsdt = config.paper.startUsdt;
    state.wallet.cashUsdt = config.paper.startUsdt;
  }
  await refreshEquity();
}

// ---------- Ouverture ----------
export function blockedReason() {
  if (state.paused) return 'en pause';
  if (state.halted) return `coupe-circuit : ${state.halted}`;
  if (!state.approved) return 'liste en attente de validation';
  if (state.positions.length >= config.maxPositions) return 'positions pleines';
  return null;
}

/** Candidats de la liste du jour encore à ouvrir, par score. */
export function pendingCandidates() {
  const l = state.list;
  if (!l || l.date !== today()) return [];
  if (Date.now() > l.generatedAt + config.entryWindowHours * 3600_000) return [];
  return [...l.longs, ...l.shorts].sort((a, b) => b.score - a.score).filter((c) => !c.done && !state.positions.some((p) => p.symbol === c.symbol));
}

/** Distance du stop en % : STOP_ATR × ATR journalier (validé par backtest). */
export const stopPctOf = (cand) => config.stopAtr * (cand.atrPct || 5);

export async function tryEntries(tickers) {
  for (const cand of pendingCandidates()) {
    if (blockedReason()) return;
    if (state.positions.filter((p) => p.side === cand.side).length >= config.maxPerSide) continue;
    const t = tickers.get(cand.symbol);
    if (!t) continue;
    const price = t.last;
    const move = ((price / cand.price - 1) * 100) * (cand.side === 'long' ? 1 : -1);
    if (move > config.maxChasePct) {
      markDone(cand, `prix déjà parti (${move.toFixed(1)} % depuis la liste)`);
      continue;
    }
    if (move < -stopPctOf(cand)) {
      markDone(cand, `prix déjà passé au-delà du stop prévu (${move.toFixed(1)} %)`);
      continue;
    }
    await openPosition(cand, price);
  }
}

function markDone(cand, note) {
  cand.done = true;
  cand.note = note;
  log(`${short(cand.symbol)} ${cand.side.toUpperCase()} non ouvert : ${note}`);
  changed();
}

async function openPosition(cand, price) {
  const c = contracts.get(cand.symbol);
  if (!c) return markDone(cand, 'contrat introuvable');
  const equity = await refreshEquity();
  const lev = Math.min(config.leverage, c.maxLeverage);
  const stopPct = stopPctOf(cand);
  // Taille au risque : si le stop est touché, on perd RISK_PER_TRADE_PCT % du capital (hors frais),
  // dans la limite de MAX_MARGIN_PCT % de marge.
  const notional = Math.min((equity * config.riskPerTradePct) / stopPct, ((equity * config.maxMarginPct) / 100) * lev);
  let qty = Math.min(roundLot(c, notional / (price * c.ctVal)), c.maxSz);
  if (qty < c.minSz) return markDone(cand, `capital trop faible pour le minimum de ${c.minSz} contrat(s) (${(price * c.ctVal * c.minSz).toFixed(2)} ${ex.quote} notionnel)`);
  const side = cand.side;
  const dir = side === 'long' ? 1 : -1;
  cand.done = true;

  try {
    let entry;
    let positionId = null;
    let serverStop = null;
    let stop = roundTick(c, price * (1 - (dir * stopPct) / 100));

    if (!isLive()) {
      const margin = (price * qty * c.ctVal) / lev;
      if (state.wallet.cashUsdt < margin) throw new Error('marge disponible insuffisante');
      entry = price * (1 + (dir * config.paper.slippagePct) / 100);
      stop = roundTick(c, entry * (1 - (dir * stopPct) / 100));
      state.wallet.cashUsdt -= margin + entry * qty * c.ctVal * c.takerFee;
    } else {
      await ex.setLeverage(c.symbol, side, lev).catch((e) => log(`${short(c.symbol)} levier : ${e.message}`, 'warn'));
      const res = await ex.openMarket({ symbol: c.symbol, side, contracts: qty, leverage: lev, stopPrice: stop });
      let pos = null;
      for (let i = 0; i < 6 && !pos; i++) {
        await sleep(1000);
        pos = (await ex.getPositions().catch(() => [])).find((p) => p.symbol === c.symbol && p.side === side);
      }
      if (!pos) throw new Error(`ordre ${res.orderId} envoyé mais position introuvable — vérifie sur ${ex.label}`);
      positionId = pos.positionId;
      qty = pos.contracts;
      entry = pos.entryPrice || price;
      if (res.stopAttached) serverStop = stop;
      else if (ex.serverStopsAvailable && !ex.serverStopsAvailable()) {
        log(`${short(c.symbol)} compte démo : stop surveillé par le bot (pas d'ordre stop côté ${ex.label})`);
      } else {
        try {
          await ex.placeStop({ symbol: c.symbol, side, contracts: qty, stopPrice: stop, leverage: lev });
          serverStop = stop;
        } catch (e) {
          log(`${short(c.symbol)} STOP NON POSÉ chez ${ex.label} (${e.message}) — le bot le surveille localement, garde le PC allumé !`, 'error');
        }
      }
    }

    const p = {
      id: `${c.symbol}-${Date.now()}`,
      symbol: c.symbol,
      display: c.display,
      side,
      leverage: lev,
      contracts: qty,
      contractSize: c.ctVal,
      takerFee: c.takerFee,
      entryPrice: entry,
      marginUsdt: (entry * qty * c.ctVal) / lev,
      openedAt: Date.now(),
      listDate: state.list?.date,
      score: cand.score,
      stopPrice: stop,
      initialStop: stop,
      riskPct: stopPct,
      serverStop,
      bestPrice: entry,
      trailing: false,
      lastPrice: entry,
      pnlUsdt: 0,
      pnlPctMargin: 0,
      feesUsdt: entry * qty * c.ctVal * c.takerFee,
      positionId,
      status: 'open',
      history: [{ t: Date.now(), p: entry }],
    };
    state.positions.push(p);
    cand.note = 'ouvert';
    log(`OUVERTURE ${side.toUpperCase()} ${c.display} x${lev} · ${c.ctVal === 1 ? `${qty} ${c.display}` : `${qty} contrat(s)`} · marge ${p.marginUsdt.toFixed(2)} ${ex.quote} · entrée ${fmt(entry)} · stop ${fmt(stop)}${serverStop ? ` (posé chez ${ex.label})` : ''}`);
    await refreshEquity();
  } catch (e) {
    cand.note = `échec : ${e.message}`;
    log(`${short(c.symbol)} ouverture échouée : ${e.message}`, 'error');
  }
  changed();
}

// ---------- Gestion des positions ----------
export async function managePositions(tickers) {
  if (isLive()) await reconcileLive(tickers);
  const now = Date.now();
  for (const p of [...state.positions]) {
    if (p.status !== 'open') continue;
    const t = tickers.get(p.symbol);
    if (t) {
      p.lastPrice = t.last;
      p.history.push({ t: now, p: p.lastPrice });
      if (p.history.length > 500) p.history.splice(0, p.history.length - 500);
    }
    p.pnlUsdt = pnlOf(p, p.lastPrice);
    p.pnlPctMargin = (p.pnlUsdt / p.marginUsdt) * 100;
    const riskPct = p.riskPct || Math.abs(p.initialStop / p.entryPrice - 1) * 100 || 2.5;
    p.rMultiple = (((p.lastPrice / p.entryPrice - 1) * 100) * (isLong(p) ? 1 : -1)) / riskPct;

    if (isLong(p) ? p.lastPrice > p.bestPrice : p.lastPrice < p.bestPrice) p.bestPrice = p.lastPrice;
    const bestMove = ((p.bestPrice / p.entryPrice - 1) * 100) * (isLong(p) ? 1 : -1);
    if (!p.trailing && bestMove >= config.trailActivateR * riskPct) {
      p.trailing = true;
      log(`${short(p.symbol)} +${(bestMove / riskPct).toFixed(1)} R → trailing stop activé (${config.trailR} R = ${(config.trailR * riskPct).toFixed(1)} % derrière le meilleur prix)`);
    }
    const c = contracts.get(p.symbol);
    if (p.trailing && c) {
      const trail = roundTick(c, p.bestPrice * (1 + ((isLong(p) ? -1 : 1) * config.trailR * riskPct) / 100));
      if (isLong(p) ? trail > p.stopPrice : trail < p.stopPrice) p.stopPrice = trail;
      await maybeMoveServerStop(p);
    }

    let reason = null;
    if (isLong(p) ? p.lastPrice <= p.stopPrice : p.lastPrice >= p.stopPrice) reason = p.trailing ? 'trailing stop' : 'stop-loss';
    else if (config.maxHoldHours > 0 && now - p.openedAt > config.maxHoldHours * 3600_000) reason = 'durée max';
    else if (p.forceClose) reason = p.forceClose;
    if (reason) await closePosition(p, reason);
  }
  await refreshEquity();
  checkCircuitBreaker();
  changed();
}

async function maybeMoveServerStop(p) {
  if (!isLive() || !p.serverStop) return;
  // Déplacement par paliers de 0,5 % pour limiter les appels.
  const gain = ((p.stopPrice / p.serverStop - 1) * 100) * (isLong(p) ? 1 : -1);
  if (gain < 0.5) return;
  try {
    await ex.cancelStops(p.symbol);
    await ex.placeStop({ symbol: p.symbol, side: p.side, contracts: p.contracts, stopPrice: p.stopPrice, leverage: p.leverage });
    p.serverStop = p.stopPrice;
    log(`${short(p.symbol)} stop déplacé chez ${ex.label} à ${fmt(p.stopPrice)}`);
  } catch (e) {
    log(`${short(p.symbol)} déplacement du stop échoué : ${e.message} — re-pose du stop précédent`, 'warn');
    await ex.placeStop({ symbol: p.symbol, side: p.side, contracts: p.contracts, stopPrice: p.serverStop, leverage: p.leverage }).catch(() => {});
  }
}

/** Live : détecte les positions fermées par le stop de la plateforme (ou à la main). */
async function reconcileLive(tickers) {
  if (!state.positions.length) return;
  let open;
  try {
    open = await ex.getPositions();
  } catch (e) {
    log(`Lecture des positions ${ex.label} impossible : ${e.message}`, 'warn');
    return;
  }
  for (const p of [...state.positions]) {
    if (p.status !== 'open') continue; // une fermeture est déjà en cours : c'est elle qui enregistre
    const o = open.find((x) => x.symbol === p.symbol && x.side === p.side);
    if (o) {
      p.contracts = o.contracts;
      p.positionId = o.positionId;
      continue;
    }
    const last = tickers.get(p.symbol)?.last || p.lastPrice;
    const hitStop = isLong(p) ? last <= p.stopPrice * 1.003 : last >= p.stopPrice * 0.997;
    p.lastPrice = hitStop ? p.stopPrice : last;
    finalize(p, hitStop ? `stop ${ex.label}` : 'fermée hors du bot');
  }
}

export async function closePosition(p, reason) {
  if (p.status !== 'open') return;
  p.status = 'closing';
  changed();
  try {
    if (isLive()) {
      await ex.closeMarket({ symbol: p.symbol, side: p.side, contracts: p.contracts, leverage: p.leverage, positionId: p.positionId });
      await sleep(1200);
    } else {
      p.lastPrice *= 1 + ((isLong(p) ? -1 : 1) * config.paper.slippagePct) / 100;
    }
    finalize(p, reason);
  } catch (e) {
    p.status = 'open';
    log(`${short(p.symbol)} fermeture échouée : ${e.message} — nouvel essai au prochain passage`, 'error');
  }
  changed();
}

function finalize(p, reason) {
  if (p.finalized) return; // jamais deux enregistrements pour la même position
  p.finalized = true;
  const exitFee = p.lastPrice * p.contracts * p.contractSize * p.takerFee;
  const gross = pnlOf(p, p.lastPrice);
  const fees = p.feesUsdt + exitFee;
  const net = gross - fees;
  if (!isLive()) state.wallet.cashUsdt += p.marginUsdt + gross - exitFee;
  state.positions = state.positions.filter((x) => x !== p);
  const closed = {
    symbol: p.symbol,
    display: p.display || short(p.symbol),
    side: p.side,
    leverage: p.leverage,
    marginUsdt: p.marginUsdt,
    entryPrice: p.entryPrice,
    exitPrice: p.lastPrice,
    openedAt: p.openedAt,
    closedAt: Date.now(),
    pnlUsdt: net,
    pnlPctMargin: (net / p.marginUsdt) * 100,
    feesUsdt: fees,
    reason,
    estimated: isLive(),
  };
  state.closed.push(closed);
  const cand = [...(state.list?.longs || []), ...(state.list?.shorts || [])].find((c) => c.symbol === p.symbol);
  if (cand) cand.note = `fermé · ${reason} · ${net >= 0 ? '+' : ''}${net.toFixed(2)} ${ex.quote}`;
  if (net >= 0) state.stats.wins++;
  else state.stats.losses++;
  state.stats.realizedUsdt += net;
  state.stats.feesUsdt += fees;
  recordTrade(closed);
  log(
    `FERMETURE ${p.side.toUpperCase()} ${closed.display} (${reason}) ${net >= 0 ? '+' : ''}${net.toFixed(2)} ${ex.quote} (${closed.pnlPctMargin >= 0 ? '+' : ''}${closed.pnlPctMargin.toFixed(1)} % de la marge)${isLive() ? ` · estimation, voir ${ex.label} pour le montant exact` : ''}`,
    net >= 0 ? 'info' : 'warn'
  );
}

export async function closeWhere(predicate, reason) {
  for (const p of [...state.positions]) if (predicate(p)) await closePosition(p, reason);
}

function checkCircuitBreaker() {
  const w = state.wallet;
  if (state.halted && state.haltedDay && state.haltedDay !== today()) {
    state.halted = null;
    state.haltedDay = null;
    log('Nouveau jour : coupe-circuit levé');
  }
  if (!state.halted && w.dayStartEquity > 0 && config.dailyMaxLossPct > 0) {
    const dd = (1 - w.equityUsdt / w.dayStartEquity) * 100;
    if (dd >= config.dailyMaxLossPct) {
      state.halted = `perte du jour ${dd.toFixed(1)} % ≥ ${config.dailyMaxLossPct} %`;
      state.haltedDay = today();
      log(`COUPE-CIRCUIT : ${state.halted}. Plus aucune ouverture aujourd'hui (les stops restent actifs).`, 'error');
    }
  }
}
