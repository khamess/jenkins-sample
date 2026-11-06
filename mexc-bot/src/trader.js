// EXÉCUTION + RISQUE — ouvre les positions de la liste du jour, pose le stop-loss,
// gère le trailing stop, la durée max et le coupe-circuit journalier.
// Mode paper : simulation avec les vrais prix MEXC. Mode live : vrais ordres MEXC Futures.
import { config } from './config.js';
import * as mexc from './mexc.js';
import { state, log, changed, recordTrade, today } from './state.js';

const isLive = () => config.mode === 'live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let contracts = new Map();
let contractsLoadedAt = 0;

export async function loadContracts(force = false) {
  if (!force && Date.now() - contractsLoadedAt < 6 * 3600_000 && contracts.size) return contracts;
  const list = await mexc.getContracts();
  contracts = new Map(list.map((c) => [c.symbol, c]));
  contractsLoadedAt = Date.now();
  return contracts;
}

const roundPrice = (c, p) => {
  const unit = +c.priceUnit || 10 ** -(c.priceScale ?? 4);
  return +(Math.round(p / unit) * unit).toFixed(c.priceScale ?? 8);
};
const isLong = (p) => p.side === 'long';
const fmt = (v) => +Number(v).toPrecision(6);
const pnlOf = (p, price) => (isLong(p) ? price - p.entryPrice : p.entryPrice - price) * p.contracts * p.contractSize;

// ---------- Solde ----------
export async function refreshEquity() {
  const w = state.wallet;
  if (isLive()) {
    const b = await mexc.getUsdtBalance();
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
    const offset = await mexc.syncTime();
    if (Math.abs(offset) > 5000) log(`Horloge du PC décalée de ${(offset / 1000).toFixed(1)} s par rapport à MEXC (corrigé automatiquement)`, 'warn');
    const b = await mexc.getUsdtBalance();
    log(`MODE LIVE — compte Futures MEXC : ${b.equity.toFixed(2)} USDT (disponible ${b.available.toFixed(2)})`, 'warn');
    try {
      const mode = await mexc.getPositionMode();
      log(`Mode de position MEXC : ${mode === 1 ? 'hedge (long et short séparés)' : 'one-way'}`);
    } catch (e) {
      log(`Mode de position illisible : ${e.message}`, 'warn');
    }
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

/** Candidats de la liste, entrelacés par score, encore à ouvrir. */
export function pendingCandidates() {
  const l = state.list;
  if (!l || l.date !== today()) return [];
  if (Date.now() > l.generatedAt + config.entryWindowHours * 3600_000) return [];
  const all = [...l.longs, ...l.shorts].sort((a, b) => b.score - a.score);
  return all.filter((c) => !c.done && !state.positions.some((p) => p.symbol === c.symbol));
}

export async function tryEntries(tickers) {
  for (const cand of pendingCandidates()) {
    const why = blockedReason();
    if (why) return;
    if (state.positions.filter((p) => p.side === cand.side).length >= config.maxPerSide) continue;
    const t = tickers.get(cand.symbol);
    if (!t) continue;
    const price = +t.lastPrice;
    const move = ((price / cand.price - 1) * 100) * (cand.side === 'long' ? 1 : -1);
    if (move > config.maxChasePct) {
      markDone(cand, `prix déjà parti (${move.toFixed(1)} % depuis la liste)`);
      continue;
    }
    if (move < -config.stopLossPct) {
      markDone(cand, `prix déjà passé sous le stop prévu (${move.toFixed(1)} %)`);
      continue;
    }
    await openPosition(cand, price);
  }
}

function markDone(cand, note) {
  cand.done = true;
  cand.note = note;
  log(`${cand.symbol} ${cand.side.toUpperCase()} non ouvert : ${note}`);
  changed();
}

async function openPosition(cand, price) {
  const c = contracts.get(cand.symbol);
  if (!c) return markDone(cand, 'contrat introuvable');
  const equity = await refreshEquity();
  const margin = (equity * config.marginPct) / 100;
  const lev = Math.min(config.leverage, c.maxLeverage || config.leverage);
  const notional = margin * lev;
  const cs = +c.contractSize;
  const unit = +c.volUnit || 1;
  let vol = Math.floor(notional / (price * cs) / unit) * unit;
  vol = Math.min(vol, +c.maxVol || vol);
  if (vol < (+c.minVol || unit)) return markDone(cand, `capital trop faible pour 1 contrat (${(price * cs * (c.minVol || 1)).toFixed(2)} USDT notionnel minimum)`);
  vol = +vol.toFixed(c.volScale ?? 0);

  cand.done = true;
  const side = cand.side;
  try {
    let entry;
    let positionId = null;
    let fees;
    let serverStop = null;
    const takerFee = +c.takerFeeRate || 0.0004;

    if (!isLive()) {
      if (state.wallet.cashUsdt < margin) throw new Error('marge disponible insuffisante');
      entry = price * (1 + ((side === 'long' ? 1 : -1) * config.paper.slippagePct) / 100);
      fees = entry * vol * cs * takerFee;
      state.wallet.cashUsdt -= margin + fees;
    } else {
      await mexc.changeLeverage({ symbol: c.symbol, leverage: lev, positionType: side === 'long' ? 1 : 2 }).catch((e) => log(`${c.symbol} levier : ${e.message}`, 'warn'));
      const orderId = await mexc.placeMarketOrder({ symbol: c.symbol, vol, side: side === 'long' ? 1 : 3, leverage: lev, externalOid: `bot${Date.now()}` });
      // Récupère la position réellement ouverte
      let pos = null;
      for (let i = 0; i < 6 && !pos; i++) {
        await sleep(1000);
        const list = await mexc.getOpenPositions(c.symbol).catch(() => []);
        pos = (list || []).find((p) => p.symbol === c.symbol && Number(p.positionType) === (side === 'long' ? 1 : 2) && +p.holdVol > 0);
      }
      if (!pos) throw new Error(`ordre ${orderId} envoyé mais position introuvable — vérifie sur MEXC`);
      positionId = pos.positionId;
      vol = +pos.holdVol;
      entry = +pos.holdAvgPrice || +pos.openAvgPrice || price;
      fees = entry * vol * cs * takerFee;
    }

    const stop = roundPrice(c, entry * (1 + ((side === 'long' ? -1 : 1) * config.stopLossPct) / 100));
    if (isLive()) {
      try {
        await mexc.placeStopOrder({ symbol: c.symbol, vol, isLong: side === 'long', leverage: lev, triggerPrice: stop });
        serverStop = stop;
      } catch (e) {
        log(`${c.symbol} STOP SERVEUR NON POSÉ (${e.message}) — le bot surveille le stop localement, garde le PC allumé !`, 'error');
      }
    }

    const p = {
      id: `${c.symbol}-${Date.now()}`,
      symbol: c.symbol,
      side,
      leverage: lev,
      contracts: vol,
      contractSize: cs,
      takerFee,
      entryPrice: entry,
      marginUsdt: (entry * vol * cs) / lev,
      openedAt: Date.now(),
      listDate: state.list?.date,
      score: cand.score,
      stopPrice: stop,
      serverStop,
      bestPrice: entry,
      trailing: false,
      lastPrice: entry,
      pnlUsdt: 0,
      pnlPctMargin: 0,
      feesUsdt: fees,
      positionId,
      status: 'open',
      history: [{ t: Date.now(), p: entry }],
    };
    state.positions.push(p);
    cand.note = 'ouvert';
    log(
      `OUVERTURE ${side.toUpperCase()} ${c.symbol} x${lev} · ${vol} contrats · marge ${p.marginUsdt.toFixed(2)} USDT · entrée ${fmt(entry)} · stop ${fmt(stop)}${serverStop ? ' (posé sur MEXC)' : ''}`
    );
    await refreshEquity();
  } catch (e) {
    cand.note = `échec : ${e.message}`;
    log(`${c.symbol} ouverture échouée : ${e.message}`, 'error');
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
      p.lastPrice = +t.lastPrice;
      p.history.push({ t: now, p: p.lastPrice });
      if (p.history.length > 500) p.history.splice(0, p.history.length - 500);
    }
    p.pnlUsdt = pnlOf(p, p.lastPrice);
    p.pnlPctMargin = (p.pnlUsdt / p.marginUsdt) * 100;
    const movePct = ((p.lastPrice / p.entryPrice - 1) * 100) * (isLong(p) ? 1 : -1);

    if (isLong(p) ? p.lastPrice > p.bestPrice : p.lastPrice < p.bestPrice) p.bestPrice = p.lastPrice;
    const bestMove = ((p.bestPrice / p.entryPrice - 1) * 100) * (isLong(p) ? 1 : -1);
    if (!p.trailing && bestMove >= config.trailActivatePct) {
      p.trailing = true;
      log(`${p.symbol} +${bestMove.toFixed(1)} % → trailing stop activé (${config.trailPct} % derrière le meilleur prix)`);
    }
    if (p.trailing) {
      const c = contracts.get(p.symbol);
      const trail = roundPrice(c, p.bestPrice * (1 + ((isLong(p) ? -1 : 1) * config.trailPct) / 100));
      if (isLong(p) ? trail > p.stopPrice : trail < p.stopPrice) p.stopPrice = trail;
      await maybeMoveServerStop(p, c);
    }

    let reason = null;
    if (isLong(p) ? p.lastPrice <= p.stopPrice : p.lastPrice >= p.stopPrice) reason = p.trailing ? 'trailing stop' : 'stop-loss';
    else if (config.takeProfitPct > 0 && movePct >= config.takeProfitPct) reason = 'take-profit';
    else if (config.maxHoldHours > 0 && now - p.openedAt > config.maxHoldHours * 3600_000) reason = 'durée max';
    else if (p.forceClose) reason = p.forceClose;
    if (reason) await closePosition(p, reason);
  }
  await refreshEquity();
  checkCircuitBreaker();
  changed();
}

async function maybeMoveServerStop(p, c) {
  if (!isLive() || !p.serverStop) return;
  // On ne déplace le stop serveur que par paliers de 0,5 % pour limiter les appels.
  const gain = ((p.stopPrice / p.serverStop - 1) * 100) * (isLong(p) ? 1 : -1);
  if (gain < 0.5) return;
  try {
    await mexc.cancelAllStopOrders(p.symbol);
    await mexc.placeStopOrder({ symbol: p.symbol, vol: p.contracts, isLong: isLong(p), leverage: p.leverage, triggerPrice: p.stopPrice });
    p.serverStop = p.stopPrice;
    log(`${p.symbol} stop serveur déplacé à ${fmt(p.stopPrice)}`);
  } catch (e) {
    log(`${p.symbol} déplacement du stop serveur échoué : ${e.message}`, 'warn');
  }
}

/** Live : détecte les positions fermées par le stop MEXC (ou à la main). */
async function reconcileLive(tickers) {
  if (!state.positions.length) return;
  let open;
  try {
    open = (await mexc.getOpenPositions()) || [];
  } catch (e) {
    log(`Lecture des positions MEXC impossible : ${e.message}`, 'warn');
    return;
  }
  for (const p of [...state.positions]) {
    const ex = open.find((o) => (p.positionId && String(o.positionId) === String(p.positionId)) || (o.symbol === p.symbol && Number(o.positionType) === (isLong(p) ? 1 : 2)));
    if (ex && +ex.holdVol > 0) {
      p.contracts = +ex.holdVol;
      p.positionId = ex.positionId;
      continue;
    }
    const last = +tickers.get(p.symbol)?.lastPrice || p.lastPrice;
    const hitStop = isLong(p) ? last <= p.stopPrice * 1.003 : last >= p.stopPrice * 0.997;
    p.lastPrice = hitStop ? p.stopPrice : last;
    finalize(p, hitStop ? 'stop MEXC' : 'fermée hors du bot');
  }
}

export async function closePosition(p, reason) {
  if (p.status !== 'open') return;
  p.status = 'closing';
  changed();
  try {
    if (isLive()) {
      await mexc.cancelAllStopOrders(p.symbol).catch(() => {});
      await mexc.placeMarketOrder({ symbol: p.symbol, vol: p.contracts, side: isLong(p) ? 4 : 2, leverage: p.leverage, positionId: p.positionId });
      await sleep(1200);
    } else {
      p.lastPrice *= 1 + ((isLong(p) ? -1 : 1) * config.paper.slippagePct) / 100;
    }
    finalize(p, reason);
  } catch (e) {
    p.status = 'open';
    log(`${p.symbol} fermeture échouée : ${e.message} — nouvel essai au prochain passage`, 'error');
    // Re-pose un stop serveur si on l'a annulé
    if (isLive()) await mexc.placeStopOrder({ symbol: p.symbol, vol: p.contracts, isLong: isLong(p), leverage: p.leverage, triggerPrice: p.stopPrice }).catch(() => {});
  }
  changed();
}

function finalize(p, reason) {
  const exitFee = p.lastPrice * p.contracts * p.contractSize * p.takerFee;
  const gross = pnlOf(p, p.lastPrice);
  const fees = p.feesUsdt + exitFee;
  const net = gross - fees;
  if (!isLive()) state.wallet.cashUsdt += p.marginUsdt + gross - exitFee;
  state.positions = state.positions.filter((x) => x !== p);
  const closed = {
    symbol: p.symbol,
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
  if (cand) cand.note = `fermé · ${reason} · ${net >= 0 ? '+' : ''}${net.toFixed(2)} USDT`;
  if (net >= 0) state.stats.wins++;
  else state.stats.losses++;
  state.stats.realizedUsdt += net;
  state.stats.feesUsdt += fees;
  recordTrade(closed);
  log(
    `FERMETURE ${p.side.toUpperCase()} ${p.symbol} (${reason}) ${net >= 0 ? '+' : ''}${net.toFixed(2)} USDT (${closed.pnlPctMargin >= 0 ? '+' : ''}${closed.pnlPctMargin.toFixed(1)} % de la marge)${isLive() ? ' · estimation, voir MEXC pour le montant exact' : ''}`,
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
