// Configuration : fichier .env + arguments (--mode=paper|live, --scan-only, --test-api).
// Fonctionne pareil sous Windows, macOS et Linux.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const val = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);

const num = (k, d) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Variable ${k} invalide : "${v}"`);
  return n;
};
const str = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const bool = (k, d) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'oui'].includes(v.toLowerCase());
};

export const config = {
  root: ROOT,
  mode: args.mode || str('MODE', 'paper'), // paper | live
  scanOnly: args['scan-only'] === 'true',
  testApi: args['test-api'] === 'true',
  baseUrl: str('MEXC_BASE_URL', 'https://api.mexc.com').replace(/\/$/, ''),
  apiKey: str('MEXC_API_KEY', ''),
  apiSecret: str('MEXC_API_SECRET', ''),
  liveConfirm: str('LIVE_CONFIRM', ''),
  dataDir: path.join(ROOT, 'data'),
  listDir: path.join(ROOT, 'listes'),

  dashboard: {
    host: str('HOST', '127.0.0.1'),
    port: num('PORT', 8790),
    token: str('DASHBOARD_TOKEN', ''),
  },

  // --- Liste du matin ---
  morningTime: str('MORNING_TIME', '08:00'), // heure locale du PC
  minTurnoverUsdt: num('MIN_TURNOVER_USDT', 8_000_000), // volume 24 h minimum
  universeSize: num('UNIVERSE_SIZE', 60), // les N contrats crypto les plus liquides
  listSize: num('LIST_SIZE', 5),
  btcRegime: bool('BTC_REGIME', true), // ne trader que dans le sens du BTC (vs moyenne 50 j)
  corrBudget: num('CORR_BUDGET', 2.4), // somme des corrélations BTC autorisée par côté
  exclude: str('EXCLUDE', 'USDC_USDT,FDUSD_USDT,TUSD_USDT,USDE_USDT,DAI_USDT,PAXG_USDT,XAUT_USDT')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  // Paramètres de src/strategy.js. Les filtres "qualité" sont désactivés par défaut :
  // le backtest montre qu'ils n'apportent rien de fiable (voir README).
  strategy: {
    minScore: num('MIN_SCORE', 65),
    requireAlign: bool('REQUIRE_ALIGN', false),
    minAtrPct: num('MIN_ATR_PCT', 2),
    maxAtrPct: num('MAX_ATR_PCT', 9),
    minRR1: num('MIN_RR1', 0),
    maxExtAtr: num('MAX_EXT_ATR', 99),
    rangeEdge: num('RANGE_EDGE', 0),
    maxStopPct: num('MAX_STOP_PCT', 99),
  },

  // --- Exécution ---
  autoTrade: bool('AUTO_TRADE', true), // false = attend ta validation dans le tableau de bord
  leverage: num('LEVERAGE', 5), // levier maximum (la taille réelle vient du risque par trade)
  riskPerTradePct: num('RISK_PER_TRADE_PCT', 0.75), // perte si le stop est touché, en % du capital
  maxMarginPct: num('MAX_MARGIN_PCT', 10), // plafond de marge par position
  maxPositions: num('MAX_POSITIONS', 5),
  maxPerSide: num('MAX_PER_SIDE', 3),
  entryWindowHours: num('ENTRY_WINDOW_HOURS', 8),
  maxChasePct: num('MAX_CHASE_PCT', 3), // n'entre pas si le prix est déjà parti de plus de X %
  pollSec: num('POLL_SEC', 15),

  // --- Risque (validé par backtest, voir README) ---
  stopAtr: num('STOP_ATR', 1.5), // stop = 1,5 × ATR journalier
  trailActivateR: num('TRAIL_ACTIVATE_R', 1.5), // trailing activé à +1,5 R
  trailR: num('TRAIL_R', 1), // puis suit le meilleur prix à 1 R
  maxHoldHours: num('MAX_HOLD_HOURS', 120), // 5 jours
  closeOnNewList: bool('CLOSE_ON_NEW_LIST', false),
  dailyMaxLossPct: num('DAILY_MAX_LOSS_PCT', 4), // coupe-circuit

  paper: {
    startUsdt: num('PAPER_START_USDT', 1000),
    slippagePct: num('PAPER_SLIPPAGE_PCT', 0.05),
  },
};

export function validateConfig() {
  const c = config;
  if (!['paper', 'live'].includes(c.mode)) throw new Error(`MODE doit être "paper" ou "live" (reçu "${c.mode}")`);
  if (c.mode === 'live' || c.testApi) {
    if (!c.apiKey || !c.apiSecret) throw new Error('MEXC_API_KEY et MEXC_API_SECRET sont requis (fichier .env).');
  }
  if (c.mode === 'live' && c.liveConfirm !== 'JE_COMPRENDS_LES_RISQUES') {
    throw new Error('Mode live refusé : ajoute LIVE_CONFIRM=JE_COMPRENDS_LES_RISQUES dans .env pour confirmer que tu acceptes de perdre cet argent.');
  }
  if (c.leverage < 1 || c.leverage > 20) throw new Error('LEVERAGE doit être entre 1 et 20.');
  if (c.riskPerTradePct <= 0 || c.riskPerTradePct > 3) throw new Error('RISK_PER_TRADE_PCT doit être entre 0 et 3.');
  if (c.maxMarginPct <= 0 || c.maxMarginPct > 25) throw new Error('MAX_MARGIN_PCT doit être entre 0 et 25.');
  if (c.stopAtr <= 0) throw new Error('STOP_ATR doit être > 0.');
  if (!/^\d{1,2}:\d{2}$/.test(c.morningTime)) throw new Error('MORNING_TIME doit être au format HH:MM.');
  if (!['127.0.0.1', 'localhost'].includes(c.dashboard.host) && !c.dashboard.token) {
    throw new Error('Tableau de bord exposé sur le réseau : définis DASHBOARD_TOKEN.');
  }
}
