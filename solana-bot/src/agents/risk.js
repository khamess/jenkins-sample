// RISK — surveille chaque position : stop -6 % posé avant l'entrée, trailing stop après +12 %,
// durée max, et coupe-circuit journalier.
import { config } from '../config.js';
import { data } from '../data/index.js';
import { state, log, changed } from '../state.js';
import { closePosition, computeEquity, refreshWallet, fmtPrice } from './executor.js';

export async function runRisk() {
  const a = state.agents.risk;
  const r = config.risk;
  if (state.positions.length) {
    a.status = 'watch';
    let pairs;
    try {
      pairs = await data.getPairs(state.positions.map((p) => p.address));
    } catch (e) {
      log('risk', `prix indisponibles : ${e.message}`, 'warn');
      pairs = new Map();
    }
    const now = Date.now();
    for (const pos of [...state.positions]) {
      if (pos.status !== 'open') continue;
      const pr = pairs.get(pos.address)?.priceUsd;
      if (pr) {
        pos.lastPrice = pr;
        pos.history.push({ t: now, p: pr });
        if (pos.history.length > 400) pos.history.splice(0, pos.history.length - 400);
        if (pr > pos.peakPrice) pos.peakPrice = pr;
      }
      pos.pnlPct = (pos.lastPrice / pos.entryPrice - 1) * 100;
      pos.pnlUsd = pos.tokens * pos.lastPrice - pos.sizeUsd;

      // Activation du trailing
      const gainPeak = (pos.peakPrice / pos.entryPrice - 1) * 100;
      if (!pos.trailing && gainPeak >= r.trailActivatePct) {
        pos.trailing = true;
        a.trails++;
        log('risk', `$${pos.symbol} +${gainPeak.toFixed(1)}% → trailing stop activé (${r.trailPct}% sous le plus haut)`);
      }
      if (pos.trailing) pos.stopPrice = Math.max(pos.stopPrice, pos.peakPrice * (1 - r.trailPct / 100));

      let reason = null;
      if (pos.lastPrice <= pos.stopPrice) reason = pos.trailing ? 'trailing stop' : 'stop-loss';
      else if (r.takeProfitPct > 0 && pos.pnlPct >= r.takeProfitPct) reason = 'take-profit';
      else if (r.maxHoldMin > 0 && now - pos.openedAt > r.maxHoldMin * 60_000) reason = 'durée max';
      if (pos.forceClose) reason = 'fermeture manuelle';
      if (pos.sellFailures > 0 && !reason) reason = 'nouvel essai de vente';

      if (reason) {
        if (reason.includes('stop')) a.stops++;
        a.last = { symbol: pos.symbol, reason, t: now };
        log('risk', `$${pos.symbol} ${reason} déclenché @ ${fmtPrice(pos.lastPrice)} (${pos.pnlPct.toFixed(1)}%)`);
        await closePosition(pos, reason);
      }
    }
  }

  // Coupe-circuit journalier
  await refreshWallet().catch(() => computeEquity());
  const w = state.wallet;
  if (state.halted && state.haltedDay && state.haltedDay !== w.day) {
    state.halted = null;
    state.haltedDay = null;
    log('risk', 'nouveau jour : coupe-circuit levé');
  }
  if (!state.halted && w.dayStartEquity > 0 && r.dailyMaxLossPct > 0) {
    const ddPct = (1 - w.equityUsd / w.dayStartEquity) * 100;
    if (ddPct >= r.dailyMaxLossPct) {
      state.halted = `perte du jour ${ddPct.toFixed(1)}% ≥ ${r.dailyMaxLossPct}%`;
      state.haltedDay = w.day;
      log('risk', `COUPE-CIRCUIT : ${state.halted}. Plus aucun nouvel achat aujourd'hui.`, 'error');
    }
  }
  a.status = state.positions.length ? 'armed' : 'idle';
  changed();
}
