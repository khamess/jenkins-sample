// Toute la configuration passe par des variables d'environnement (voir .env.example).
import fs from 'node:fs';
import path from 'node:path';

// Chargement minimal d'un fichier .env (sans dépendance).
const envFile = path.resolve(process.env.ENV_FILE || '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

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
  mode: str('MODE', 'paper'), // paper | live
  sim: bool('SIM', false), // données simulées (démo hors ligne)
  rpcUrl: str('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  jupApiUrl: str('JUP_API_URL', 'https://lite-api.jup.ag/swap/v1'),
  jupApiKey: str('JUP_API_KEY', ''),
  dataDir: path.resolve(str('DATA_DIR', 'data')),

  dashboard: {
    host: str('HOST', '127.0.0.1'),
    port: num('PORT', 8787),
    token: str('DASHBOARD_TOKEN', ''),
  },

  paper: {
    startUsd: num('PAPER_START_USD', 100),
    slippagePct: num('PAPER_SLIPPAGE_PCT', 1.5), // coût simulé par côté (frais + slippage)
  },

  scout: {
    intervalSec: num('SCOUT_INTERVAL_SEC', 20),
    minAgeMin: num('MIN_AGE_MIN', 20),
    maxAgeHours: num('MAX_AGE_HOURS', 48),
    minMcap: num('MIN_MCAP', 250_000),
    maxMcap: num('MAX_MCAP', 15_000_000),
  },

  filter: {
    minLiquidityUsd: num('MIN_LIQUIDITY_USD', 45_000),
    minVolume1hUsd: num('MIN_VOLUME_1H_USD', 60_000),
    maxPump1hPct: num('MAX_PUMP_1H_PCT', 75),
    minLpLockedPct: num('MIN_LP_LOCKED_PCT', 95),
    maxTop10Pct: num('MAX_TOP10_PCT', 20),
    maxDevPct: num('MAX_DEV_PCT', 2),
    maxInsiderPct: num('MAX_INSIDER_PCT', 8),
    // strict : une donnée introuvable = règle échouée
    strict: bool('FILTER_STRICT', true),
  },

  analyst: {
    minScore: num('MIN_SCORE', 70),
  },

  executor: {
    maxPositionPct: num('MAX_POSITION_PCT', 8),
    maxOpenPositions: num('MAX_OPEN_POSITIONS', 3),
    minPositionUsd: num('MIN_POSITION_USD', 2),
    slippageBps: num('SLIPPAGE_BPS', 300),
    maxPriorityLamports: num('MAX_PRIORITY_LAMPORTS', 2_000_000),
    solReserve: num('SOL_RESERVE', 0.05), // SOL gardés pour les frais
  },

  risk: {
    pollSec: num('RISK_POLL_SEC', 8),
    stopLossPct: num('STOP_LOSS_PCT', 6),
    trailActivatePct: num('TRAIL_ACTIVATE_PCT', 12),
    trailPct: num('TRAIL_PCT', 6),
    takeProfitPct: num('TAKE_PROFIT_PCT', 0), // 0 = désactivé (on laisse courir le trailing)
    maxHoldMin: num('MAX_HOLD_MIN', 240),
    dailyMaxLossPct: num('DAILY_MAX_LOSS_PCT', 20), // coupe-circuit journalier
    cooldownMin: num('COOLDOWN_MIN', 0), // pause après une perte
  },

  live: {
    confirm: str('LIVE_CONFIRM', ''),
    privateKey: str('PRIVATE_KEY', ''),
    keypairPath: str('KEYPAIR_PATH', ''),
  },
};

export function validateConfig() {
  if (!['paper', 'live'].includes(config.mode)) throw new Error(`MODE doit être "paper" ou "live" (reçu "${config.mode}")`);
  if (config.mode === 'live') {
    if (config.sim) throw new Error('SIM=1 est interdit en mode live.');
    if (config.live.confirm !== 'JE_COMPRENDS_LES_RISQUES') {
      throw new Error('Mode live refusé : mets LIVE_CONFIRM=JE_COMPRENDS_LES_RISQUES pour confirmer que tu acceptes de perdre cet argent.');
    }
    if (!config.live.privateKey && !config.live.keypairPath) throw new Error('Mode live : PRIVATE_KEY ou KEYPAIR_PATH requis.');
  }
  if (config.executor.maxPositionPct <= 0 || config.executor.maxPositionPct > 50) throw new Error('MAX_POSITION_PCT doit être entre 0 et 50.');
  if (config.risk.stopLossPct <= 0) throw new Error('STOP_LOSS_PCT doit être > 0.');
  if (config.dashboard.host !== '127.0.0.1' && config.dashboard.host !== 'localhost' && !config.dashboard.token) {
    throw new Error('Tableau de bord exposé sur le réseau : définis DASHBOARD_TOKEN.');
  }
}
