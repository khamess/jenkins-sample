// Orchestrateur : un prompt, six agents, passages de relais stricts, aucun token choisi à la main.
//   SCOUT → FILTER → ANALYST → EXECUTOR → RISK → LOGGER
import { config, validateConfig } from './config.js';
import { state, log, load, save, changed } from './state.js';
import { runScout, releaseCandidate } from './agents/scout.js';
import { runFilter } from './agents/filter.js';
import { runAnalyst } from './agents/analyst.js';
import { openPosition, refreshWallet, canOpen, computeEquity } from './agents/executor.js';
import { runRisk } from './agents/risk.js';
import { startServer } from './server.js';
import * as wallet from './wallet.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function init() {
  validateConfig();
  const restored = load();
  if (config.mode === 'live') {
    const pub = await wallet.initWallet();
    log('executor', `MODE LIVE — portefeuille ${pub}. Argent réel en jeu.`, 'warn');
    await refreshWallet();
    if (!restored || !state.wallet.startUsd) state.wallet.startUsd = state.wallet.equityUsd;
  } else {
    if (!restored || !state.wallet.startUsd) {
      state.wallet.startUsd = config.paper.startUsd;
      state.wallet.cashUsd = config.paper.startUsd;
    }
    await refreshWallet().catch(() => computeEquity());
    log('executor', `MODE PAPER${config.sim ? ' + SIMULATION' : ''} — argent fictif, solde $${state.wallet.equityUsd.toFixed(2)}`);
  }
  if (restored) log('logger', `état restauré : ${state.positions.length} position(s) ouverte(s), ${state.closed.length} trade(s) fermé(s)`);
}

let pipelineBusy = false;
async function pipelineTick() {
  if (pipelineBusy) return;
  pipelineBusy = true;
  try {
    if (canOpen()) {
      state.agents.scout.status = 'wait';
      changed();
      return; // pause, coupe-circuit, cooldown ou positions pleines : pas de scan inutile
    }
    const candidates = await runScout();
    for (let i = 0; i < candidates.length; i++) {
      const pair = candidates[i];
      if (canOpen()) {
        candidates.slice(i).forEach((c) => releaseCandidate(c.address));
        break;
      }
      const f = await runFilter(pair);
      if (!f.pass) continue;
      const a = await runAnalyst(pair, f.ctx);
      if (!a.pass) continue;
      await openPosition(pair, a, f.ctx);
    }
  } catch (e) {
    state.agents.scout.status = 'error';
    log('scout', `erreur : ${e.message}`, 'error');
  } finally {
    pipelineBusy = false;
  }
}

let riskBusy = false;
async function riskTick() {
  if (riskBusy) return;
  riskBusy = true;
  try {
    await runRisk();
  } catch (e) {
    log('risk', `erreur : ${e.message}`, 'error');
  } finally {
    riskBusy = false;
  }
}

function equityTick() {
  computeEquity();
  state.equityHistory.push({ t: Date.now(), v: +state.wallet.equityUsd.toFixed(4) });
  if (state.equityHistory.length > 5000) state.equityHistory.splice(0, state.equityHistory.length - 5000);
  changed();
}

async function main() {
  try {
    await init();
  } catch (e) {
    console.error(`\nDémarrage impossible : ${e.message}\n`);
    process.exit(1);
  }
  startServer();
  equityTick();
  pipelineTick();
  setInterval(pipelineTick, config.scout.intervalSec * 1000);
  setInterval(riskTick, config.risk.pollSec * 1000);
  setInterval(equityTick, 30_000);

  const stop = async () => {
    console.log('\nArrêt… (les positions ouvertes restent ouvertes et seront reprises au prochain démarrage)');
    save();
    await sleep(200);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('unhandledRejection', (e) => log('logger', `erreur non gérée : ${e?.message || e}`, 'error'));
}

main();
