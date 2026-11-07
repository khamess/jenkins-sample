// État partagé, journal et persistance (reprise après redémarrage du PC).
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

export const bus = new EventEmitter();
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.listDir, { recursive: true });

const STATE_FILE = path.join(config.dataDir, `state-${config.exchange}-${config.mode}.json`);
const TRADES_FILE = path.join(config.dataDir, `trades-${config.exchange}-${config.mode}.csv`);
const LOG_FILE = path.join(config.dataDir, 'bot.log');

export const state = {
  startedAt: Date.now(),
  mode: config.mode,
  paused: false,
  halted: null,
  haltedDay: null,
  status: 'démarrage',
  list: null, // liste du jour
  approved: config.autoTrade,
  wallet: { startUsdt: 0, cashUsdt: 0, equityUsdt: 0, day: '', dayStartEquity: 0 },
  positions: [],
  closed: [],
  stats: { wins: 0, losses: 0, realizedUsdt: 0, feesUsdt: 0 },
  equityHistory: [],
  log: [],
  nextScanAt: null,
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
    closed: state.closed.slice(-500),
    stats: state.stats,
    equityHistory: state.equityHistory.slice(-3000),
    halted: state.halted,
    haltedDay: state.haltedDay,
    list: state.list,
    approved: state.approved,
  };
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data, null, 1));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) {
    console.error('Sauvegarde impossible :', e.message);
  }
}

export function load() {
  if (!fs.existsSync(STATE_FILE)) return false;
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(state.wallet, d.wallet || {});
    state.positions = d.positions || [];
    state.closed = d.closed || [];
    Object.assign(state.stats, d.stats || {});
    state.equityHistory = d.equityHistory || [];
    state.halted = d.halted || null;
    state.haltedDay = d.haltedDay || null;
    state.list = d.list || null;
    state.approved = config.autoTrade || !!d.approved;
    return true;
  } catch (e) {
    console.error('État illisible, on repart de zéro :', e.message);
    return false;
  }
}

export function log(msg, level = 'info') {
  const entry = { t: Date.now(), msg, level };
  state.log.push(entry);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  const line = `${new Date(entry.t).toLocaleString('fr-FR')} ${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
  bus.emit('change');
}

export function recordTrade(t) {
  const header = 'date_ouverture;date_fermeture;symbole;sens;levier;marge;prix_entree;prix_sortie;pnl;pnl_pct_marge;frais;raison;plateforme;mode\n';
  const row = [
    new Date(t.openedAt).toISOString(),
    new Date(t.closedAt).toISOString(),
    t.symbol,
    t.side,
    t.leverage,
    t.marginUsdt.toFixed(2),
    t.entryPrice,
    t.exitPrice,
    t.pnlUsdt.toFixed(4),
    t.pnlPctMargin.toFixed(2),
    t.feesUsdt.toFixed(4),
    t.reason,
    config.exchange,
    config.mode,
  ].join(';');
  const exists = fs.existsSync(TRADES_FILE);
  fs.appendFile(TRADES_FILE, (exists ? '' : header) + row + '\n', () => {});
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function snapshot() {
  return {
    now: Date.now(),
    startedAt: state.startedAt,
    mode: state.mode,
    exchange: config.exchange === 'mexc' ? 'MEXC' : 'OKX',
    quote: config.exchange === 'mexc' ? 'USDT' : 'USD',
    paused: state.paused,
    halted: state.halted,
    status: state.status,
    list: state.list,
    approved: state.approved,
    wallet: state.wallet,
    positions: state.positions,
    closed: state.closed.slice(-50).reverse(),
    stats: state.stats,
    equityHistory: state.equityHistory.slice(-600),
    log: state.log.slice(-120).reverse(),
    nextScanAt: state.nextScanAt,
    config: {
      leverage: config.leverage,
      riskPerTradePct: config.riskPerTradePct,
      maxMarginPct: config.maxMarginPct,
      maxPositions: config.maxPositions,
      maxPerSide: config.maxPerSide,
      stopAtr: config.stopAtr,
      trailActivateR: config.trailActivateR,
      trailR: config.trailR,
      maxHoldHours: config.maxHoldHours,
      morningTime: config.morningTime,
      minScore: config.strategy.minScore,
      btcRegime: config.btcRegime,
      dailyMaxLossPct: config.dailyMaxLossPct,
      autoTrade: config.autoTrade,
    },
  };
}
