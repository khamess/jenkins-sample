// Plateforme OKX — contrats X-Perps (futures à 5 ans réglés en USD, agréés MiFID II pour l'EEE).
// API v5. Signature : base64(HMAC-SHA256(secret, horodatage ISO + MÉTHODE + chemin?query + corps)).
// Les comptes EEE utilisent le domaine eea.okx.com (une clé créée sur my.okx.com ne marche que là).
import crypto from 'node:crypto';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAR = { '1D': '1Dutc', '4H': '4H', '1H': '1H' };
const BAR_MS = { '1D': 86_400_000, '4H': 14_400_000, '1H': 3_600_000 };
let offset = 0;
let lastPublic = 0;
let posMode = 'net_mode';

export const name = 'okx';
export const label = 'OKX';
export const quote = 'USD';
export const btcSymbol = () => contractsByBase.get('BTC')?.symbol;

export class OkxError extends Error {
  constructor(code, msg, path) {
    super(`OKX ${path} → ${code}: ${msg}`);
    this.code = code;
  }
}

async function request(method, path, { params, body, signed = false, retries = 2 } = {}) {
  const qs = params && Object.keys(params).length ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString() : '';
  const reqPath = path + qs;
  const bodyStr = body ? JSON.stringify(body) : '';
  for (let attempt = 0; ; attempt++) {
    const headers = { 'Content-Type': 'application/json' };
    if (signed) {
      const ts = new Date(Date.now() + offset).toISOString();
      headers['OK-ACCESS-KEY'] = config.okx.apiKey;
      headers['OK-ACCESS-PASSPHRASE'] = config.okx.passphrase;
      headers['OK-ACCESS-TIMESTAMP'] = ts;
      headers['OK-ACCESS-SIGN'] = crypto.createHmac('sha256', config.okx.apiSecret).update(ts + method + reqPath + bodyStr).digest('base64');
      if (config.okx.demo) headers['x-simulated-trading'] = '1';
    } else {
      const wait = lastPublic + 110 - Date.now(); // ~20 req / 2 s sur l'historique
      if (wait > 0) await sleep(wait);
      lastPublic = Date.now();
    }
    try {
      const res = await fetch(config.okx.baseUrl + reqPath, { method, headers, body: method === 'POST' ? bodyStr : undefined, signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Réponse non JSON (HTTP ${res.status}) : ${text.slice(0, 150)}`);
      }
      if (res.status === 429 || json.code === '50011') throw Object.assign(new Error('rate limit'), { retry: true });
      if (json.code !== '0') {
        const item = Array.isArray(json.data) ? json.data.find((d) => d && d.sCode && d.sCode !== '0') : null;
        throw new OkxError(item?.sCode || json.code, item?.sMsg || json.msg || 'erreur', path);
      }
      return json.data;
    } catch (e) {
      const canRetry = attempt < retries && !(signed && method === 'POST') && !(e instanceof OkxError);
      if (!canRetry) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

// ---------- Contrats ----------
let contractsByBase = new Map();

/** Contrats X-Perps crypto ouverts, normalisés. */
export async function getContracts() {
  const list = await request('GET', '/api/v5/public/instruments', { params: { instType: 'FUTURES' } });
  const out = [];
  for (const i of list) {
    if (!String(i.instFamily || '').endsWith('_UM_XPERP')) continue; // X-Perps uniquement
    if (i.instCategory !== '1' || i.state !== 'live') continue; // 1 = crypto (3 = actions, 4 = matières premières)
    const base = i.ctValCcy || i.instFamily.split('-')[0];
    out.push({
      symbol: i.instId,
      base,
      display: base,
      ctVal: +i.ctVal,
      lotSz: +i.lotSz,
      minSz: +i.minSz,
      maxSz: +i.maxMktSz || Infinity,
      tickSz: +i.tickSz,
      maxLeverage: +i.lever || 10,
      takerFee: 0.0005,
      histSymbol: `${base}-USDT-SWAP`, // historique long pour le backtest (même sous-jacent)
      expTime: +i.expTime,
    });
  }
  // une seule échéance par crypto : la plus lointaine
  const byBase = new Map();
  for (const c of out) if (!byBase.has(c.base) || byBase.get(c.base).expTime < c.expTime) byBase.set(c.base, c);
  contractsByBase = byBase;
  return [...byBase.values()];
}

/** Map symbole -> { last, turnover24 (USD) } */
export async function getTickers() {
  const list = await request('GET', '/api/v5/market/tickers', { params: { instType: 'FUTURES' } });
  const m = new Map();
  for (const t of list) {
    const last = +t.last;
    m.set(t.instId, { last, turnover24: +t.volCcy24h * last });
  }
  return m;
}

export async function getFundingPct(symbol) {
  try {
    const d = await request('GET', '/api/v5/public/funding-rate', { params: { instId: symbol } });
    return +d[0].fundingRate * 100;
  } catch {
    return 0;
  }
}

/** Bougies [{t,o,h,l,c,amount}] triées, en remontant l'historique par pages de 100. */
export async function getKlinesRange(symbol, interval, startMs, endMs = Date.now()) {
  const out = new Map();
  let after = endMs + 1;
  for (let guard = 0; guard < 200; guard++) {
    const d = await request('GET', '/api/v5/market/history-candles', { params: { instId: symbol, bar: BAR[interval], after, limit: 100 } });
    if (!d?.length) break;
    for (const k of d) out.set(+k[0], { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], amount: +k[7] || +k[6] * +k[4] });
    const oldest = +d[d.length - 1][0];
    if (oldest <= startMs) break;
    after = oldest;
  }
  return [...out.values()].filter((k) => k.t >= startMs).sort((a, b) => a.t - b.t);
}

export const getKlines = (symbol, interval, count) => getKlinesRange(symbol, interval, Date.now() - BAR_MS[interval] * (count + 2));

// ---------- Privé ----------
export async function init() {
  try {
    const t = await request('GET', '/api/v5/public/time');
    offset = +t[0].ts - Date.now();
  } catch {
    /* horloge locale */
  }
  const cfg = await request('GET', '/api/v5/account/config', { signed: true });
  posMode = cfg[0]?.posMode || 'net_mode';
  const acctLv = cfg[0]?.acctLv;
  const notes = [`mode de position : ${posMode === 'long_short_mode' ? 'long/short séparés' : 'net'}`];
  if (acctLv === '1') throw new Error("le compte OKX est en mode « Spot » : passe-le en mode « Futures » ou plus (Paramètres > Mode de compte) pour trader les X-Perps");
  if (config.okx.demo) notes.push('COMPTE DÉMO OKX (argent fictif)');
  return { offset, notes };
}

export async function getBalance() {
  const d = await request('GET', '/api/v5/account/balance', { signed: true });
  const acc = d[0] || {};
  const det = (acc.details || []).find((x) => ['USD', 'USDC', 'USDT'].includes(x.ccy)) || {};
  return { equity: +acc.totalEq || 0, available: +det.availEq || +det.availBal || 0 };
}

/** Positions ouvertes normalisées : [{ symbol, side, contracts, entryPrice, positionId }] */
export async function getPositions() {
  const d = await request('GET', '/api/v5/account/positions', { signed: true, params: { instType: 'FUTURES' } });
  return (d || [])
    .filter((p) => +p.pos !== 0)
    .map((p) => ({
      symbol: p.instId,
      side: p.posSide === 'long' ? 'long' : p.posSide === 'short' ? 'short' : +p.pos > 0 ? 'long' : 'short',
      contracts: Math.abs(+p.pos),
      entryPrice: +p.avgPx,
      positionId: p.posId,
    }));
}

const posSideOf = (side) => (posMode === 'long_short_mode' ? side : undefined);

export function setLeverage(symbol, side, leverage) {
  return request('POST', '/api/v5/account/set-leverage', { signed: true, body: { instId: symbol, lever: String(leverage), mgnMode: 'isolated', posSide: posSideOf(side) } });
}

/** Ordre au marché en marge isolée, avec le stop-loss attaché (créé chez OKX dès l'exécution). */
export async function openMarket({ symbol, side, contracts, stopPrice }) {
  const body = {
    instId: symbol,
    tdMode: 'isolated',
    side: side === 'long' ? 'buy' : 'sell',
    posSide: posSideOf(side),
    ordType: 'market',
    sz: String(contracts),
    clOrdId: `bot${Date.now()}`,
  };
  if (stopPrice) body.attachAlgoOrds = [{ slTriggerPx: String(stopPrice), slOrdPx: '-1', slTriggerPxType: 'last' }];
  const d = await request('POST', '/api/v5/trade/order', { signed: true, body });
  return { orderId: d[0]?.ordId, stopAttached: !!stopPrice };
}

/** Stop-loss seul (ordre conditionnel au marché qui réduit la position). */
export function placeStop({ symbol, side, contracts, stopPrice }) {
  const body = {
    instId: symbol,
    tdMode: 'isolated',
    side: side === 'long' ? 'sell' : 'buy',
    posSide: posSideOf(side),
    ordType: 'conditional',
    sz: String(contracts),
    slTriggerPx: String(stopPrice),
    slOrdPx: '-1',
    slTriggerPxType: 'last',
  };
  if (posMode !== 'long_short_mode') body.reduceOnly = true;
  return request('POST', '/api/v5/trade/order-algo', { signed: true, body });
}

export async function cancelStops(symbol) {
  const pending = await request('GET', '/api/v5/trade/orders-algo-pending', { signed: true, params: { ordType: 'conditional', instId: symbol } });
  const ids = (pending || []).map((a) => ({ algoId: a.algoId, instId: symbol }));
  if (ids.length) await request('POST', '/api/v5/trade/cancel-algos', { signed: true, body: ids });
  return ids.length;
}

/** Ferme toute la position au marché et annule ses ordres en attente (stops compris). */
export function closeMarket({ symbol, side }) {
  return request('POST', '/api/v5/trade/close-position', { signed: true, body: { instId: symbol, mgnMode: 'isolated', posSide: posMode === 'long_short_mode' ? side : 'net', autoCxl: true } });
}
