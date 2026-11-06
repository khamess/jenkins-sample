// Source de données SIMULÉE : pour tester le bot et le tableau de bord sans réseau ni argent.
// Les prix sont des marches aléatoires ; certains tokens "pompent", d'autres "rug".
const SYL = ['WO', 'BBL', 'SPR', 'OUT', 'PE', 'BL', 'KI', 'WIX', 'TO', 'FUU', 'FRO', 'TH', 'SNA', 'IL', 'GUM', 'BO', 'ZOR', 'BI', 'QUO', 'NK', 'PIP', 'PA', 'FIZ', 'ZLE', 'MOO', 'DOG', 'CAT'];
const tokens = new Map();
let counter = 0;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function makeToken() {
  counter++;
  const symbol = (pick(SYL) + pick(SYL) + (Math.random() < 0.4 ? pick(SYL) : '')).slice(0, 6);
  const address = 'Sim' + Math.random().toString(36).slice(2, 10) + counter.toString(36) + 'pump';
  const good = Math.random() < 0.35;
  const t = {
    address,
    symbol,
    createdAt: Date.now() - rnd(10, 60 * 50) * 60_000,
    supply: 1e9,
    price: rnd(0.0002, 0.012),
    // dérive par minute : quelques gagnants, beaucoup de perdants
    drift: good ? rnd(-0.002, 0.012) : rnd(-0.012, 0.004),
    vol: rnd(0.01, 0.035),
    rugAt: Math.random() < 0.12 ? Date.now() + rnd(1, 15) * 60_000 : null,
    // Les "bons" tokens ont des métriques saines (ils passent le filtre), les autres sont aléatoires.
    liq: good ? rnd(60_000, 400_000) : rnd(15_000, 400_000),
    vol1h: good ? rnd(120_000, 900_000) : rnd(10_000, 900_000),
    buys1h: Math.floor(good ? rnd(300, 900) : rnd(40, 900)),
    sellRatio: good ? rnd(0.45, 0.8) : rnd(0.5, 1.4),
    change1h: good ? rnd(10, 55) : rnd(-40, 140),
    mintRevoked: good || Math.random() < 0.85,
    freezeRevoked: good || Math.random() < 0.9,
    lpLocked: good || Math.random() < 0.8 ? 100 : rnd(0, 60),
    top10: good ? rnd(8, 18) : rnd(8, 45),
    dev: good ? rnd(0, 1.5) : Math.random() < 0.75 ? rnd(0, 2) : rnd(2, 12),
    insider: good ? rnd(0, 6) : rnd(0, 14),
    holders: Math.floor(rnd(150, 4000)),
    last: Date.now(),
  };
  tokens.set(address, t);
  return t;
}

function step(t) {
  const now = Date.now();
  const dtMin = Math.max(0, (now - t.last) / 60_000);
  t.last = now;
  if (t.rugAt && now > t.rugAt) {
    t.price *= 0.08;
    t.liq *= 0.05;
    t.rugAt = null;
    t.drift = -0.02;
    return;
  }
  // accéléré x6 pour que la démo bouge
  const k = dtMin * 6;
  t.price *= Math.exp(t.drift * k + t.vol * Math.sqrt(k) * gauss());
  t.vol1h *= Math.exp(0.05 * gauss());
  t.buys1h = Math.max(5, Math.floor(t.buys1h * Math.exp(0.05 * gauss())));
}

function toPair(t) {
  const mcap = t.price * t.supply;
  const sells = Math.floor(t.buys1h * t.sellRatio);
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.symbol,
    pairAddress: 'Pair' + t.address,
    dexId: 'sim',
    quoteSymbol: 'SOL',
    url: '#',
    priceUsd: t.price,
    liquidityUsd: t.liq,
    mcap,
    createdAt: t.createdAt,
    volume: { m5: t.vol1h / 12, h1: t.vol1h, h6: t.vol1h * rnd(3, 6), h24: t.vol1h * 10 },
    txns: {
      m5: { buys: Math.floor(t.buys1h / 12), sells: Math.floor(sells / 12) },
      h1: { buys: t.buys1h, sells },
      h6: { buys: t.buys1h * 5, sells: sells * 5 },
    },
    change: { m5: t.drift * 500 + rnd(-3, 3), h1: t.change1h, h6: t.change1h * 1.5, h24: t.change1h * 2 },
  };
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function getNewTokens() {
  const n = Math.floor(rnd(2, 6));
  const fresh = [];
  for (let i = 0; i < n; i++) fresh.push(makeToken().address);
  return fresh;
}

export async function getPairs(addresses) {
  const map = new Map();
  for (const a of addresses) {
    const t = tokens.get(a);
    if (!t) continue;
    step(t);
    map.set(a, toPair(t));
  }
  return map;
}

export async function getSolPrice() {
  return 160 + Math.sin(Date.now() / 600_000) * 3;
}

export async function getMintInfo(address) {
  const t = tokens.get(address);
  if (!t) return null;
  await new Promise((r) => setTimeout(r, 200));
  return { mintAuthority: t.mintRevoked ? null : 'SimAuth', freezeAuthority: t.freezeRevoked ? null : 'SimFreeze', supply: String(t.supply * 1e6), decimals: 6 };
}

export async function getRugReport(address) {
  const t = tokens.get(address);
  if (!t) return null;
  await new Promise((r) => setTimeout(r, 300));
  return { lpLockedPct: t.lpLocked, top10Pct: t.top10, insiderPct: t.insider, devPct: t.dev, totalHolders: t.holders, rugged: false, dangers: [] };
}
