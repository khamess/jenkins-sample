// EXECUTOR — passe les ordres. Max MAX_POSITION_PCT % du solde par trade.
// Le stop est fixé AVANT l'entrée (agent RISK).
import { config } from '../config.js';
import { data } from '../data/index.js';
import { state, log, updateFlow, changed, recordTrade } from '../state.js';
import * as wallet from '../wallet.js';

const isLive = () => config.mode === 'live';

export function computeEquity() {
  const w = state.wallet;
  const posValue = state.positions.reduce((s, p) => s + p.tokens * (p.lastPrice || p.entryPrice), 0);
  w.equityUsd = w.cashUsd + posValue;
  return w.equityUsd;
}

export async function refreshWallet() {
  const w = state.wallet;
  try {
    w.solPrice = await data.getSolPrice();
  } catch {
    /* garde l'ancien prix */
  }
  if (isLive()) {
    w.sol = await wallet.getSolBalance();
    w.cashUsd = w.sol * w.solPrice;
  }
  const eq = computeEquity();
  const day = new Date().toISOString().slice(0, 10);
  if (w.day !== day) {
    w.day = day;
    w.dayStartEquity = eq;
  }
  return eq;
}

export function canOpen(address) {
  if (state.paused) return 'en pause';
  if (state.halted) return `coupe-circuit : ${state.halted}`;
  if (Date.now() < state.cooldownUntil) return 'cooldown après perte';
  if (state.positions.length >= config.executor.maxOpenPositions) return `déjà ${state.positions.length} positions ouvertes`;
  if (address && state.positions.some((p) => p.address === address)) return 'déjà en position';
  return null;
}

export async function openPosition(pair, analysis, ctx = {}) {
  const a = state.agents.executor;
  const blocked = canOpen(pair.address);
  if (blocked) {
    log('executor', `$${pair.symbol} non acheté : ${blocked}`);
    updateFlow(pair.address, { verdict: 'blocked' });
    return null;
  }
  a.status = 'buy';
  changed();
  const c = config.executor;
  const equity = await refreshWallet();
  let sizeUsd = (equity * c.maxPositionPct) / 100;
  const w = state.wallet;

  try {
    // Prix frais juste avant l'achat
    const fresh = (await data.getPairs([pair.address])).get(pair.address) || pair;
    let entryPrice;
    let tokens;
    let tokensRaw = null;
    let decimals = null;
    let sig = null;

    if (!isLive()) {
      sizeUsd = Math.min(sizeUsd, w.cashUsd);
      if (sizeUsd < c.minPositionUsd) throw new Error(`taille trop faible ($${sizeUsd.toFixed(2)})`);
      const slip = config.paper.slippagePct / 100;
      entryPrice = fresh.priceUsd * (1 + slip);
      tokens = sizeUsd / entryPrice;
      w.cashUsd -= sizeUsd;
    } else {
      const spendSol = Math.min(sizeUsd / w.solPrice, w.sol - c.solReserve);
      if (spendSol * w.solPrice < c.minPositionUsd) throw new Error(`solde SOL insuffisant (${w.sol.toFixed(3)} SOL)`);
      const lamports = BigInt(Math.floor(spendSol * 1e9));
      decimals = ctx.mint?.decimals ?? (await data.getMintInfo(pair.address))?.decimals;
      if (decimals == null) throw new Error('décimales du token introuvables');
      const res = await wallet.swap({ inputMint: wallet.SOL_MINT, outputMint: pair.address, amount: lamports });
      sig = res.sig;
      // Solde réel reçu (le quote peut différer à cause du slippage)
      await new Promise((r) => setTimeout(r, 2000));
      tokensRaw = await wallet.getTokenBalanceRaw(pair.address).catch(() => res.outAmount);
      if (tokensRaw === 0n) tokensRaw = res.outAmount;
      tokens = Number(tokensRaw) / 10 ** decimals;
      sizeUsd = (Number(lamports) / 1e9) * w.solPrice;
      entryPrice = sizeUsd / tokens;
      await refreshWallet();
    }

    const pos = {
      id: `${pair.address}-${Date.now()}`,
      address: pair.address,
      symbol: pair.symbol,
      url: pair.url,
      openedAt: Date.now(),
      entryPrice,
      sizeUsd,
      tokens,
      tokensRaw: tokensRaw?.toString() ?? null,
      decimals,
      score: analysis.score,
      stopPrice: entryPrice * (1 - config.risk.stopLossPct / 100),
      peakPrice: entryPrice,
      trailing: false,
      lastPrice: entryPrice,
      pnlPct: 0,
      pnlUsd: 0,
      status: 'open',
      sellFailures: 0,
      buySig: sig,
      history: [{ t: Date.now(), p: entryPrice }],
    };
    state.positions.push(pos);
    a.trades++;
    a.last = { symbol: pair.symbol, sizeUsd, t: Date.now() };
    computeEquity();
    updateFlow(pair.address, { stage: 'risk', verdict: 'bought' });
    log('executor', `ACHAT $${pair.symbol} $${sizeUsd.toFixed(2)} (${((sizeUsd / equity) * 100).toFixed(1)}%) @ ${fmtPrice(entryPrice)}${sig ? ' · tx ' + sig.slice(0, 10) + '…' : ''}`);
    log('risk', `$${pair.symbol} stop armé à -${config.risk.stopLossPct}% (${fmtPrice(pos.stopPrice)}), trailing après +${config.risk.trailActivatePct}%`);
    recordTrade({ type: 'buy', t: pos.openedAt, address: pos.address, symbol: pos.symbol, sizeUsd, entryPrice, score: analysis.score, sig, mode: config.mode });
    return pos;
  } catch (e) {
    log('executor', `$${pair.symbol} achat échoué : ${e.message}`, 'error');
    updateFlow(pair.address, { verdict: 'error' });
    return null;
  } finally {
    a.status = 'idle';
    changed();
  }
}

export async function closePosition(pos, reason) {
  if (pos.status === 'closing') return;
  pos.status = 'closing';
  const a = state.agents.executor;
  a.status = 'sell';
  changed();
  try {
    let proceedsUsd;
    let sig = null;
    if (!isLive()) {
      const slip = config.paper.slippagePct / 100;
      proceedsUsd = pos.tokens * pos.lastPrice * (1 - slip);
      state.wallet.cashUsd += proceedsUsd;
    } else {
      const raw = await wallet.getTokenBalanceRaw(pos.address);
      if (raw === 0n) {
        proceedsUsd = 0;
        log('executor', `$${pos.symbol} : plus aucun token en portefeuille, position clôturée`, 'warn');
      } else {
        // Slippage élargi si les ventes précédentes ont échoué (on DOIT sortir).
        const slippageBps = Math.min(5000, config.executor.slippageBps * (1 + pos.sellFailures * 2));
        const res = await wallet.swap({ inputMint: pos.address, outputMint: wallet.SOL_MINT, amount: raw, slippageBps });
        sig = res.sig;
        proceedsUsd = (Number(res.outAmount) / 1e9) * state.wallet.solPrice;
      }
      await refreshWallet();
    }
    const pnlUsd = proceedsUsd - pos.sizeUsd;
    const pnlPct = (pnlUsd / pos.sizeUsd) * 100;
    state.positions = state.positions.filter((p) => p !== pos);
    const closed = {
      address: pos.address,
      symbol: pos.symbol,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      entryPrice: pos.entryPrice,
      exitPrice: pos.lastPrice,
      sizeUsd: pos.sizeUsd,
      proceedsUsd,
      pnlUsd,
      pnlPct,
      reason,
      score: pos.score,
      sig,
    };
    state.closed.push(closed);
    if (pnlUsd >= 0) state.stats.wins++;
    else state.stats.losses++;
    state.stats.realizedUsd += pnlUsd;
    if (pnlUsd < 0 && config.risk.cooldownMin > 0) state.cooldownUntil = Date.now() + config.risk.cooldownMin * 60_000;
    computeEquity();
    log('executor', `VENTE $${pos.symbol} (${reason}) ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`, pnlUsd >= 0 ? 'info' : 'warn');
    recordTrade({ type: 'sell', t: closed.closedAt, ...closed, mode: config.mode });
  } catch (e) {
    pos.status = 'open';
    pos.sellFailures++;
    log('executor', `$${pos.symbol} vente échouée (${pos.sellFailures}) : ${e.message} — nouvel essai au prochain tick`, 'error');
  } finally {
    a.status = 'idle';
    changed();
  }
}

export function fmtPrice(p) {
  if (!p) return '$0';
  if (p >= 1) return '$' + p.toFixed(4);
  const s = p.toPrecision(4);
  return '$' + (s.includes('e') ? p.toFixed(10) : s);
}
