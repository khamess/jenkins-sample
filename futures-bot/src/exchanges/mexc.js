// Plateforme MEXC — contrats perpétuels USDT. Adaptateur au-dessus du client src/mexc.js.
import * as api from '../mexc.js';

const INTERVAL = { '1D': 'Day1', '4H': 'Hour4', '1H': 'Min60' };
const STABLES = new Set(['USDC', 'USDT', 'FDUSD', 'TUSD', 'USDE', 'DAI', 'USD1', 'PYUSD', 'USDD', 'BUSD', 'PAXG', 'XAUT']);
let contractsBySymbol = new Map();

export const name = 'mexc';
export const label = 'MEXC';
export const quote = 'USDT';
export const btcSymbol = () => 'BTC_USDT';

export async function getContracts() {
  const list = await api.getContracts();
  const out = [];
  for (const c of list) {
    const plates = (c.conceptPlate || []).map((p) => String(p).toLowerCase());
    const tradfi = plates.some((p) => p.includes('tradfi') || p.includes('stock') || p.includes('forex') || p.includes('commodit') || p.includes('metal'));
    if (c.quoteCoin !== 'USDT' || c.settleCoin !== 'USDT' || c.state !== 0 || c.apiAllowed === false || c.isHidden || c.preMarket || tradfi || STABLES.has(c.baseCoin)) continue;
    out.push({
      symbol: c.symbol,
      base: c.baseCoin,
      display: c.baseCoin,
      ctVal: +c.contractSize,
      lotSz: +c.volUnit || 1,
      minSz: +c.minVol || 1,
      maxSz: +c.maxVol || Infinity,
      tickSz: +c.priceUnit || 10 ** -(c.priceScale ?? 4),
      maxLeverage: +c.maxLeverage || 20,
      takerFee: +c.takerFeeRate || 0.0004,
      histSymbol: c.symbol,
    });
  }
  contractsBySymbol = new Map(out.map((c) => [c.symbol, c]));
  return out;
}

export async function getTickers() {
  const m = new Map();
  for (const t of await api.getTickers()) m.set(t.symbol, { last: +t.lastPrice, turnover24: +t.amount24, fundingPct: +t.fundingRate * 100 });
  return m;
}

let tickCache = null;
export async function getFundingPct(symbol) {
  if (!tickCache || Date.now() - tickCache.at > 60_000) tickCache = { at: Date.now(), m: await getTickers() };
  return tickCache.m.get(symbol)?.fundingPct ?? 0;
}

export const getKlines = (symbol, interval, count) => api.getKlines(symbol, INTERVAL[interval], count);
export const getKlinesRange = (symbol, interval, startMs, endMs) => api.getKlinesRange(symbol, INTERVAL[interval], startMs, endMs);

// ---------- Privé ----------
export async function init() {
  const offset = await api.syncTime();
  const notes = [];
  try {
    const mode = await api.getPositionMode();
    notes.push(`mode de position : ${mode === 1 ? 'hedge' : 'one-way'}`);
  } catch {
    /* facultatif */
  }
  return { offset, notes };
}

export async function getBalance() {
  const b = await api.getUsdtBalance();
  return { equity: b.equity, available: b.available };
}

export async function getPositions() {
  return ((await api.getOpenPositions()) || [])
    .filter((p) => +p.holdVol > 0)
    .map((p) => ({ symbol: p.symbol, side: Number(p.positionType) === 1 ? 'long' : 'short', contracts: +p.holdVol, entryPrice: +p.holdAvgPrice || +p.openAvgPrice, positionId: p.positionId }));
}

export const setLeverage = (symbol, side, leverage) => api.changeLeverage({ symbol, leverage, positionType: side === 'long' ? 1 : 2 });

let levBySymbol = new Map();
export async function openMarket({ symbol, side, contracts, leverage }) {
  levBySymbol.set(symbol, leverage);
  const orderId = await api.placeMarketOrder({ symbol, vol: contracts, side: side === 'long' ? 1 : 3, leverage, externalOid: `bot${Date.now()}` });
  return { orderId, stopAttached: false }; // le stop est posé à part (placeStop)
}

export const placeStop = ({ symbol, side, contracts, stopPrice, leverage }) =>
  api.placeStopOrder({ symbol, vol: contracts, isLong: side === 'long', leverage: leverage || levBySymbol.get(symbol) || 5, triggerPrice: stopPrice });

export const cancelStops = (symbol) => api.cancelAllStopOrders(symbol);

export async function closeMarket({ symbol, side, contracts, leverage, positionId }) {
  await api.cancelAllStopOrders(symbol).catch(() => {});
  return api.placeMarketOrder({ symbol, vol: contracts, side: side === 'long' ? 4 : 2, leverage: leverage || 5, positionId });
}

export const contractInfo = (symbol) => contractsBySymbol.get(symbol);
