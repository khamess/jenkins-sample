// Client MEXC Futures (contrats perpétuels USDT), sans dépendance.
// Signature : HMAC-SHA256(secret, apiKey + Request-Time + paramètres), en hexadécimal.
//   GET  : paramètres triés par clé, encodés en query string
//   POST : corps JSON brut
import crypto from 'node:crypto';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let timeOffset = 0; // décalage horloge PC / serveur MEXC
let lastPublic = 0;

export class MexcError extends Error {
  constructor(code, message, path) {
    super(`MEXC ${path} → ${code}: ${message}`);
    this.code = code;
  }
}

function unwrap(json, path) {
  if (json && (json.success === true || json.code === 0 || json.code === 200)) return json.data;
  throw new MexcError(json?.code ?? '?', json?.message || json?.msg || JSON.stringify(json).slice(0, 200), path);
}

async function request(method, path, { params, body, signed = false, retries = 2 } = {}) {
  let url = config.baseUrl + path;
  let query = '';
  if (params && Object.keys(params).length) {
    const sorted = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null)
      .sort()
      .map((k) => [k, String(params[k])]);
    query = new URLSearchParams(sorted).toString();
    url += '?' + query;
  }
  const bodyStr = body ? JSON.stringify(body) : undefined;

  for (let attempt = 0; ; attempt++) {
    const headers = { 'Content-Type': 'application/json' };
    if (signed) {
      const ts = String(Date.now() + timeOffset);
      const toSign = config.apiKey + ts + (method === 'POST' ? bodyStr || '' : query);
      headers.ApiKey = config.apiKey;
      headers['Request-Time'] = ts;
      headers.Signature = crypto.createHmac('sha256', config.apiSecret).update(toSign).digest('hex');
    } else {
      // limite publique ~20 req / 2 s : on espace les appels
      const wait = lastPublic + 120 - Date.now();
      if (wait > 0) await sleep(wait);
      lastPublic = Date.now();
    }
    try {
      const res = await fetch(url, { method, headers, body: bodyStr, signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Réponse non JSON (HTTP ${res.status}) : ${text.slice(0, 150)}`);
      }
      if (res.status === 429 || json?.code === 510) throw Object.assign(new Error('rate limit'), { retry: true });
      return unwrap(json, path);
    } catch (e) {
      // Un ordre (POST signé) n'est jamais renvoyé automatiquement : risque de doublon.
      const canRetry = attempt < retries && !(signed && method === 'POST') && !(e instanceof MexcError);
      if (!canRetry) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

// ---------- Public ----------
export async function syncTime() {
  try {
    const serverTs = Number(await request('GET', '/api/v1/contract/ping'));
    if (serverTs > 0) timeOffset = serverTs - Date.now();
  } catch {
    /* on garde l'horloge locale */
  }
  return timeOffset;
}

export async function getContracts() {
  return request('GET', '/api/v1/contract/detail');
}

export async function getTickers() {
  const data = await request('GET', '/api/v1/contract/ticker');
  return Array.isArray(data) ? data : [data];
}

/** Bougies : { time[], open[], high[], low[], close[], vol[], amount[] } converties en tableau d'objets. */
export async function getKlines(symbol, interval, count) {
  const sec = { Min60: 3600, Hour4: 14400, Day1: 86400 }[interval];
  const end = Math.floor(Date.now() / 1000);
  const start = end - sec * (count + 2);
  const d = await request('GET', `/api/v1/contract/kline/${symbol}`, { params: { interval, start, end } });
  const out = [];
  for (let i = 0; i < (d?.time?.length || 0); i++) {
    out.push({ t: d.time[i] * 1000, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i], amount: +d.amount[i] });
  }
  return out;
}

// ---------- Privé (clé API requise) ----------
export const getAssets = () => request('GET', '/api/v1/private/account/assets', { signed: true });
export const getOpenPositions = (symbol) => request('GET', '/api/v1/private/position/open_positions', { signed: true, params: symbol ? { symbol } : {} });
export const getPositionMode = () => request('GET', '/api/v1/private/position/position_mode', { signed: true });

export async function getUsdtBalance() {
  const assets = await getAssets();
  const a = (assets || []).find((x) => x.currency === 'USDT') || {};
  return { equity: +a.equity || 0, available: +a.availableBalance || 0, unrealized: +a.unrealized || 0 };
}

export function changeLeverage({ symbol, leverage, positionType }) {
  // openType 1 = marge isolée ; positionType 1 = long, 2 = short
  return request('POST', '/api/v1/private/position/change_leverage', { signed: true, body: { symbol, leverage, openType: 1, positionType } });
}

/** side : 1 ouvrir long · 2 fermer short · 3 ouvrir short · 4 fermer long. type 6 = au marché. */
export async function placeMarketOrder({ symbol, vol, side, leverage, positionId, externalOid }) {
  const body = { symbol, vol, side, type: 6, openType: 1, leverage };
  if (positionId) body.positionId = positionId;
  if (externalOid) body.externalOid = externalOid;
  const data = await request('POST', '/api/v1/private/order/create', { signed: true, body });
  return typeof data === 'object' && data !== null ? String(data.orderId ?? '') : String(data);
}

/** Stop-loss côté serveur : ordre déclenché au marché qui ferme la position. */
export function placeStopOrder({ symbol, vol, isLong, leverage, triggerPrice }) {
  return request('POST', '/api/v1/private/planorder/place', {
    signed: true,
    body: {
      symbol,
      vol,
      side: isLong ? 4 : 2,
      openType: 1,
      leverage,
      triggerPrice,
      triggerType: isLong ? 2 : 1, // 2 : prix ≤ déclencheur (long) · 1 : prix ≥ déclencheur (short)
      executeCycle: 2, // valable 7 jours
      trend: 1, // dernier prix
      orderType: 5, // exécution au marché
    },
  });
}

export const cancelAllStopOrders = (symbol) => request('POST', '/api/v1/private/planorder/cancel_all', { signed: true, body: { symbol } });
