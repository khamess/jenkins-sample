// Sources de données réelles : DexScreener (paires), Solana RPC (mint), RugCheck (holders / LP).
import { getJson } from './http.js';
import { config } from '../config.js';

const DEX = 'https://api.dexscreener.com';
const RUG = 'https://api.rugcheck.xyz/v1';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

const n = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

function normalizePair(p) {
  return {
    address: p.baseToken.address,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    quoteSymbol: p.quoteToken?.symbol,
    url: p.url,
    priceUsd: n(p.priceUsd),
    liquidityUsd: n(p.liquidity?.usd),
    mcap: n(p.marketCap) || n(p.fdv),
    createdAt: p.pairCreatedAt || null,
    volume: { m5: n(p.volume?.m5), h1: n(p.volume?.h1), h6: n(p.volume?.h6), h24: n(p.volume?.h24) },
    txns: {
      m5: { buys: n(p.txns?.m5?.buys), sells: n(p.txns?.m5?.sells) },
      h1: { buys: n(p.txns?.h1?.buys), sells: n(p.txns?.h1?.sells) },
      h6: { buys: n(p.txns?.h6?.buys), sells: n(p.txns?.h6?.sells) },
    },
    change: { m5: n(p.priceChange?.m5), h1: n(p.priceChange?.h1), h6: n(p.priceChange?.h6), h24: n(p.priceChange?.h24) },
  };
}

/** Adresses de tokens Solana récemment listés / mis en avant sur DexScreener. */
export async function getNewTokens() {
  const urls = [`${DEX}/token-profiles/latest/v1`, `${DEX}/token-boosts/latest/v1`, `${DEX}/token-boosts/top/v1`];
  const results = await Promise.allSettled(urls.map((u) => getJson(u, { minIntervalMs: 250 })));
  const out = new Set();
  for (const r of results) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const t of r.value) if (t?.chainId === 'solana' && t.tokenAddress) out.add(t.tokenAddress);
  }
  if (out.size === 0 && results.every((r) => r.status === 'rejected')) throw results[0].reason;
  return [...out];
}

/** Map adresse -> meilleure paire (la plus liquide) pour chaque token. */
export async function getPairs(addresses) {
  const map = new Map();
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const pairs = await getJson(`${DEX}/tokens/v1/solana/${chunk.join(',')}`, { minIntervalMs: 250 });
    if (!Array.isArray(pairs)) continue;
    for (const p of pairs) {
      if (!p?.baseToken?.address || !chunk.includes(p.baseToken.address)) continue;
      const np = normalizePair(p);
      const cur = map.get(np.address);
      if (!cur || np.liquidityUsd > cur.liquidityUsd) map.set(np.address, np);
    }
  }
  return map;
}

export async function getSolPrice() {
  const m = await getPairs([SOL_MINT]);
  const p = m.get(SOL_MINT)?.priceUsd;
  if (!p) throw new Error('Prix du SOL introuvable');
  return p;
}

async function rpc(method, params) {
  const res = await getJson(config.rpcUrl, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
  if (res?.error) throw new Error(`RPC ${method}: ${res.error.message}`);
  return res?.result;
}

/** Autorités de mint / freeze lues directement on-chain. */
export async function getMintInfo(address) {
  const r = await rpc('getAccountInfo', [address, { encoding: 'jsonParsed' }]);
  const info = r?.value?.data?.parsed?.info;
  if (!info) return null;
  return {
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    supply: info.supply,
    decimals: info.decimals,
  };
}

/** Rapport RugCheck normalisé (LP verrouillée, top holders, insiders, dev). */
export async function getRugReport(address) {
  const r = await getJson(`${RUG}/tokens/${address}/report`, { minIntervalMs: 1100, timeoutMs: 20000 });
  if (!r) return null;

  // Comptes appartenant aux pools (à exclure du calcul des holders).
  const ammAccounts = new Set();
  for (const [addr, v] of Object.entries(r.knownAccounts || {})) if (v?.type === 'AMM') ammAccounts.add(addr);
  let lpLockedPct = null;
  for (const m of r.markets || []) {
    for (const k of ['pubkey', 'liquidityA', 'liquidityB', 'liquidityAAccount', 'liquidityBAccount']) {
      if (typeof m?.[k] === 'string') ammAccounts.add(m[k]);
    }
    const pct = m?.lp?.lpLockedPct;
    if (typeof pct === 'number') lpLockedPct = Math.max(lpLockedPct ?? 0, pct);
  }

  const holders = (r.topHolders || []).map((h) => ({
    address: h.address,
    owner: h.owner,
    pct: Number(h.pct) || 0,
    insider: !!h.insider,
  }));
  const realHolders = holders.filter((h) => !ammAccounts.has(h.address) && !ammAccounts.has(h.owner));

  let devPct = null;
  const supply = Number(r.token?.supply);
  if (r.creator) {
    const h = realHolders.find((x) => x.owner === r.creator || x.address === r.creator);
    if (h) devPct = h.pct;
    else if (Number.isFinite(Number(r.creatorBalance)) && supply > 0) devPct = (Number(r.creatorBalance) / supply) * 100;
    else if (realHolders.length >= 10) devPct = Math.min(...realHolders.map((x) => x.pct)); // pas dans le top -> au plus le plus petit
  }

  return {
    lpLockedPct,
    top10Pct: realHolders.length ? realHolders.slice(0, 10).reduce((s, h) => s + h.pct, 0) : null,
    insiderPct: holders.length ? realHolders.filter((h) => h.insider).reduce((s, h) => s + h.pct, 0) : null,
    devPct,
    totalHolders: Number.isFinite(Number(r.totalHolders)) ? Number(r.totalHolders) : null,
    mintAuthority: r.mintAuthority ?? r.token?.mintAuthority,
    freezeAuthority: r.freezeAuthority ?? r.token?.freezeAuthority,
    rugged: !!r.rugged,
    dangers: (r.risks || []).filter((x) => x?.level === 'danger').map((x) => x.name),
  };
}
