// Plateforme WEEX — contrats perpétuels USDT (API « capi v3 », proche de Binance).
// Signature : base64(HMAC-SHA256(secret, horodatage ms + MÉTHODE + /chemin?query + corps)), avec passphrase.
// Quantités exprimées en tokens (pas = 10^-quantityPrecision). Mode démo : endpoints capi/v3/sim/ et symboles XXXSUSDT.
// ⚠ WEEX n'a pas d'agrément MiCA : l'accès depuis la France peut être restreint à tout moment.
import crypto from 'node:crypto';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAR = { '1D': '1d', '4H': '4h', '1H': '1h' };
const BAR_MS = { '1D': 86_400_000, '4H': 14_400_000, '1H': 3_600_000 };
const STABLES = new Set(['USDC', 'USDT', 'FDUSD', 'TUSD', 'USDE', 'DAI', 'USD1', 'PYUSD', 'USDD', 'BUSD', 'PAXG', 'XAUT']);
let offset = 0;
let lastPublic = 0;
const demo = () => config.weex.demo;
const sim = (sym) => (demo() ? sym.replace(/USDT$/, 'SUSDT') : sym); // BTCUSDT -> BTCSUSDT en démo
const unsim = (sym) => (demo() && sym?.endsWith('SUSDT') ? sym.slice(0, -5) + 'USDT' : sym);

export const name = 'weex';
export const label = 'WEEX';
export const quote = 'USDT';
export const btcSymbol = () => 'BTCUSDT';
/** L'API démo WEEX n'accepte pas les ordres conditionnels : le bot surveille alors le stop lui-même. */
export const serverStopsAvailable = () => !demo();

export class WeexError extends Error {
  constructor(code, msg, path) {
    super(`WEEX ${path} → ${code}: ${msg}`);
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
      const ts = String(Date.now() + offset);
      headers['ACCESS-KEY'] = config.weex.apiKey;
      headers['ACCESS-PASSPHRASE'] = config.weex.passphrase;
      headers['ACCESS-TIMESTAMP'] = ts;
      headers['ACCESS-SIGN'] = crypto.createHmac('sha256', config.weex.apiSecret).update(ts + method + reqPath + bodyStr).digest('base64');
    } else {
      const wait = lastPublic + 120 - Date.now();
      if (wait > 0) await sleep(wait);
      lastPublic = Date.now();
    }
    try {
      const res = await fetch(config.weex.baseUrl + reqPath, { method, headers, body: method === 'POST' ? bodyStr || undefined : undefined, signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`Réponse non JSON (HTTP ${res.status}) : ${text.slice(0, 150)}`);
      }
      if (res.status === 429) throw Object.assign(new Error('rate limit'), { retry: true });
      const isErr = json && !Array.isArray(json) && json.code !== undefined && ![0, 200, '0', '200'].includes(json.code) && (json.msg || json.message);
      if (isErr || !res.ok) throw new WeexError(json?.code ?? res.status, json?.msg || json?.message || text.slice(0, 150), path);
      if (json && !Array.isArray(json) && (json.success === false || json.errorMsg)) throw new WeexError(json.errorCode || 'refus', json.errorMsg || json.errorMessage || 'ordre refusé', path);
      return json;
    } catch (e) {
      const canRetry = attempt < retries && !(signed && method !== 'GET') && !(e instanceof WeexError);
      if (!canRetry) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

// ---------- Contrats ----------
export async function getContracts() {
  const [info, apiList] = await Promise.all([request('GET', '/capi/v3/market/exchangeInfo'), request('GET', '/capi/v3/market/apiTradingSymbols')]);
  const apiAllowed = new Set(apiList || []);
  const out = [];
  for (const s of info.symbols || []) {
    if (s.contractType !== 'PERPETUAL' || s.underlyingType !== 'COIN' || s.marginAsset !== 'USDT' || s.quoteAsset !== 'USDT') continue; // cryptos uniquement
    if (!apiAllowed.has(s.symbol) || STABLES.has(s.baseAsset)) continue; // contrat ouvert à l'API
    out.push({
      symbol: s.symbol,
      base: s.baseAsset,
      display: s.baseAsset,
      ctVal: 1, // quantité exprimée directement en tokens
      lotSz: 10 ** -Number(s.quantityPrecision),
      minSz: +s.minOrderSize,
      maxSz: +s.marketOpenLimitSize || +s.maxOrderSize || Infinity,
      tickSz: 10 ** -Number(s.pricePrecision),
      maxLeverage: +s.maxLeverage || 20,
      takerFee: +s.takerFeeRate || 0.0008,
      histSymbol: s.symbol,
    });
  }
  return out;
}

export async function getTickers() {
  const m = new Map();
  for (const t of await request('GET', '/capi/v3/market/ticker/24hr')) m.set(t.symbol, { last: +t.lastPrice, turnover24: +t.quoteVolume });
  return m;
}

export async function getFundingPct(symbol) {
  try {
    const d = await request('GET', '/capi/v3/market/premiumIndex', { params: { symbol } });
    return +(Array.isArray(d) ? d[0] : d).lastFundingRate * 100;
  } catch {
    return 0;
  }
}

const toCandle = (k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], amount: +k[7] || +k[5] * +k[4] });

/** Bougies récentes (jusqu'à 1000 par appel). */
export async function getKlines(symbol, interval, count) {
  const d = await request('GET', '/capi/v3/market/klines', { params: { symbol, interval: BAR[interval], limit: Math.min(1000, count + 2) } });
  return (d || []).map(toCandle).sort((a, b) => a.t - b.t);
}

/** Historique long (backtest) : pages de 100 bougies en remontant le temps. */
export async function getKlinesRange(symbol, interval, startMs, endMs = Date.now()) {
  const out = new Map();
  let end = endMs;
  for (let guard = 0; guard < 300 && end > startMs; guard++) {
    // 100 bougies max par appel, et une fenêtre de 90 jours max (erreur -1170 au-delà)
    const start = Math.max(startMs, end - Math.min(BAR_MS[interval] * 100, 89 * 86_400_000));
    const d = await request('GET', '/capi/v3/market/historyKlines', { params: { symbol, interval: BAR[interval], startTime: start, endTime: end, limit: 100 } });
    if (!d?.length) break;
    for (const k of d) out.set(+k[0], toCandle(k));
    const oldest = Math.min(...d.map((k) => +k[0]));
    if (oldest <= startMs) break;
    end = oldest - 1;
  }
  return [...out.values()].filter((k) => k.t >= startMs).sort((a, b) => a.t - b.t);
}

// ---------- Privé ----------
export async function init() {
  try {
    const t = await request('GET', '/capi/v3/market/time');
    offset = +t.serverTime - Date.now();
  } catch {
    /* horloge locale */
  }
  await getBalance(); // vérifie la clé
  const notes = ['marge isolée'];
  if (demo()) notes.push('COMPTE DÉMO WEEX (SUSDT fictifs, stops surveillés par le bot)');
  return { offset, notes };
}

export async function getBalance() {
  const d = await request('GET', demo() ? '/capi/v3/sim/balance' : '/capi/v3/account/balance', { signed: true });
  const a = (d || []).find((x) => ['USDT', 'SUSDT'].includes(x.asset)) || {};
  return { equity: (+a.balance || 0) + (+a.unrealizePnl || 0), available: +a.availableBalance || 0 };
}

export async function getPositions() {
  const d = await request('GET', demo() ? '/capi/v3/sim/position/allPosition' : '/capi/v3/account/position/allPosition', { signed: true });
  return (d || [])
    .filter((p) => +p.size > 0)
    .map((p) => ({ symbol: unsim(p.symbol), side: String(p.side).toLowerCase() === 'short' ? 'short' : 'long', contracts: +p.size, entryPrice: +p.openValue / +p.size, positionId: String(p.id) }));
}

export async function setLeverage(symbol, side, leverage) {
  if (demo()) return; // l'API démo ne gère que les ordres, le solde et les positions
  await request('POST', '/capi/v3/account/marginType', { signed: true, body: { symbol, marginType: 'ISOLATED' } }).catch(() => {}); // refusé si une position existe déjà
  return request('POST', '/capi/v3/account/leverage', { signed: true, body: { symbol, marginType: 'ISOLATED', isolatedLongLeverage: String(leverage), isolatedShortLeverage: String(leverage) } });
}

/** Ordre au marché ; en réel le stop-loss est attaché à l'ordre (slTriggerPrice). */
export async function openMarket({ symbol, side, contracts, stopPrice }) {
  const body = {
    symbol: sim(symbol),
    side: side === 'long' ? 'BUY' : 'SELL',
    positionSide: side === 'long' ? 'LONG' : 'SHORT',
    type: 'MARKET',
    quantity: String(contracts),
    newClientOrderId: `bot-${Date.now()}`,
  };
  const attach = !!stopPrice && !demo();
  if (attach) body.slTriggerPrice = String(stopPrice);
  const d = await request('POST', demo() ? '/capi/v3/sim/order' : '/capi/v3/order', { signed: true, body });
  return { orderId: d?.orderId, stopAttached: attach };
}

/** Stop-loss seul : ordre conditionnel STOP_MARKET qui ferme la position. */
export function placeStop({ symbol, side, contracts, stopPrice }) {
  if (demo()) throw new Error("ordres conditionnels indisponibles sur l'API démo WEEX");
  return request('POST', '/capi/v3/algoOrder', {
    signed: true,
    body: {
      symbol,
      side: side === 'long' ? 'SELL' : 'BUY',
      positionSide: side === 'long' ? 'LONG' : 'SHORT',
      type: 'STOP_MARKET',
      quantity: String(contracts),
      triggerPrice: String(stopPrice),
      clientAlgoId: `bot-sl-${Date.now()}`,
    },
  });
}

export async function cancelStops(symbol) {
  if (demo()) return 0;
  await request('DELETE', '/capi/v3/algoOpenOrders', { signed: true, params: { symbol } });
  return 1;
}

export async function closeMarket({ symbol, side, contracts }) {
  if (demo()) {
    // pas de closePositions en démo : ordre inverse sur la même position
    return request('POST', '/capi/v3/sim/order', {
      signed: true,
      body: { symbol: sim(symbol), side: side === 'long' ? 'SELL' : 'BUY', positionSide: side === 'long' ? 'LONG' : 'SHORT', type: 'MARKET', quantity: String(contracts), newClientOrderId: `bot-close-${Date.now()}` },
    });
  }
  const res = await request('POST', '/capi/v3/closePositions', { signed: true, body: { symbol } });
  await cancelStops(symbol).catch(() => {}); // supprime le stop restant
  const fail = Array.isArray(res) ? res.find((r) => r && r.success === false) : null;
  if (fail) throw new WeexError('refus', fail.errorMessage || 'fermeture refusée', '/capi/v3/closePositions');
  return res;
}
