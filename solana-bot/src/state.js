// État partagé + agent LOGGER (journal, historique des trades, persistance).
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

export const bus = new EventEmitter();
fs.mkdirSync(config.dataDir, { recursive: true });

const STATE_FILE = path.join(config.dataDir, `state-${config.mode}${config.sim ? '-sim' : ''}.json`);
const TRADES_FILE = path.join(config.dataDir, `trades-${config.mode}${config.sim ? '-sim' : ''}.jsonl`);
const LOG_FILE = path.join(config.dataDir, 'bot.log');

export const state = {
  startedAt: Date.now(),
  mode: config.mode,
  sim: config.sim,
  paused: false,
  halted: null, // raison du coupe-circuit
  haltedDay: null,
  cooldownUntil: 0,
  agents: {
    scout: { status: 'idle', seen: 0, fresh: 0, lastNew: null, pairsPerMin: 0 },
    filter: { status: 'idle', checked: 0, killed: 0 },
    analyst: { status: 'idle', scored: 0, passed: 0, last: null },
    executor: { status: 'idle', trades: 0, last: null },
    risk: { status: 'armed', stops: 0, trails: 0, last: null },
    logger: { status: 'live', lines: 0 },
  },
  flow: [], // tokens récemment vus
  filterView: null, // évaluation en cours
  analystView: null,
  wallet: { startUsd: 0, cashUsd: 0, equityUsd: 0, sol: 0, solPrice: 0, dayStartEquity: 0, day: '' },
  positions: [],
  closed: [],
  equityHistory: [],
  stats: { wins: 0, losses: 0, realizedUsd: 0 },
  log: [],
};

let saveTimer = null;
export function changed() {
  bus.emit('change');
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 1000);
}

export function save() {
  const data = {
    wallet: state.wallet,
    positions: state.positions,
    closed: state.closed.slice(-300),
    stats: state.stats,
    equityHistory: state.equityHistory.slice(-2000),
    halted: state.halted,
    haltedDay: state.haltedDay,
  };
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) {
    console.error('Sauvegarde impossible :', e.message);
  }
}

export function load() {
  if (!fs.existsSync(STATE_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(state.wallet, data.wallet || {});
    state.positions = data.positions || [];
    state.closed = data.closed || [];
    state.stats = { ...state.stats, ...(data.stats || {}) };
    state.equityHistory = data.equityHistory || [];
    state.halted = data.halted || null;
    state.haltedDay = data.haltedDay || null;
    return true;
  } catch (e) {
    console.error('État illisible, on repart de zéro :', e.message);
    return false;
  }
}

export function log(agent, msg, level = 'info') {
  const entry = { t: Date.now(), agent, msg, level };
  state.log.push(entry);
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
  state.agents.logger.lines++;
  const line = `${new Date(entry.t).toISOString()} [${agent.toUpperCase()}] ${level !== 'info' ? level.toUpperCase() + ' ' : ''}${msg}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
  bus.emit('change');
}

export function recordTrade(trade) {
  fs.appendFile(TRADES_FILE, JSON.stringify(trade) + '\n', () => {});
}

export function pushFlow(item) {
  const i = state.flow.findIndex((f) => f.address === item.address);
  if (i >= 0) state.flow.splice(i, 1);
  state.flow.unshift(item);
  if (state.flow.length > 30) state.flow.length = 30;
}

export function updateFlow(address, patch) {
  const f = state.flow.find((x) => x.address === address);
  if (f) Object.assign(f, patch);
}

export function snapshot() {
  return {
    now: Date.now(),
    startedAt: state.startedAt,
    mode: state.mode,
    sim: state.sim,
    paused: state.paused,
    halted: state.halted,
    cooldownUntil: state.cooldownUntil,
    agents: state.agents,
    flow: state.flow.slice(0, 12),
    filterView: state.filterView,
    analystView: state.analystView,
    wallet: state.wallet,
    positions: state.positions,
    closed: state.closed.slice(-40).reverse(),
    stats: state.stats,
    equityHistory: state.equityHistory.slice(-500),
    log: state.log.slice(-80).reverse(),
    config: {
      minScore: config.analyst.minScore,
      stopLossPct: config.risk.stopLossPct,
      trailActivatePct: config.risk.trailActivatePct,
      trailPct: config.risk.trailPct,
      maxPositionPct: config.executor.maxPositionPct,
      maxOpenPositions: config.executor.maxOpenPositions,
      scout: config.scout,
    },
  };
}
