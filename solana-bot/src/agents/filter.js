// FILTER — 8 règles strictes. Une seule règle échouée = token éliminé.
import { config } from '../config.js';
import { data } from '../data/index.js';
import { state, log, updateFlow, changed } from '../state.js';
import { killed, fmtK } from './scout.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildRules(c) {
  // Règles "gratuites" (données DexScreener) d'abord, puis on-chain / RugCheck.
  return [
    {
      id: 'liquidity',
      label: `liquidité ≥ $${fmtK(c.minLiquidityUsd)}`,
      check: async (p) => ({ ok: p.liquidityUsd >= c.minLiquidityUsd, value: `$${fmtK(p.liquidityUsd)}` }),
    },
    {
      id: 'volume',
      label: `volume 1h ≥ $${fmtK(c.minVolume1hUsd)}`,
      check: async (p) => ({ ok: p.volume.h1 >= c.minVolume1hUsd, value: `$${fmtK(p.volume.h1)}` }),
    },
    {
      id: 'pump',
      label: `pump 1h ≤ ${c.maxPump1hPct}%`,
      check: async (p) => ({ ok: p.change.h1 <= c.maxPump1hPct, value: `${p.change.h1.toFixed(0)}%` }),
    },
    {
      id: 'mint',
      label: 'mint / freeze révoqués',
      check: async (p, ctx) => {
        ctx.mint = await data.getMintInfo(p.address).catch(() => null);
        if (!ctx.mint) return { ok: null, value: 'inconnu' };
        const ok = ctx.mint.mintAuthority === null && ctx.mint.freezeAuthority === null;
        return { ok, value: ok ? 'révoqués' : ctx.mint.mintAuthority ? 'mint actif' : 'freeze actif' };
      },
    },
    {
      id: 'lp',
      label: `LP brûlée ou verrouillée ≥ ${c.minLpLockedPct}%`,
      check: async (p, ctx) => {
        ctx.rug = await data.getRugReport(p.address).catch((e) => {
          ctx.rugError = e.message;
          return null;
        });
        if (ctx.rug?.rugged) return { ok: false, value: 'RUGGED' };
        if (ctx.rug?.lpLockedPct == null) return { ok: null, value: 'inconnu' };
        return { ok: ctx.rug.lpLockedPct >= c.minLpLockedPct, value: `${ctx.rug.lpLockedPct.toFixed(0)}%` };
      },
    },
    {
      id: 'top10',
      label: `top 10 holders ≤ ${c.maxTop10Pct}%`,
      check: async (p, ctx) => (ctx.rug?.top10Pct == null ? { ok: null, value: 'inconnu' } : { ok: ctx.rug.top10Pct <= c.maxTop10Pct, value: `${ctx.rug.top10Pct.toFixed(1)}%` }),
    },
    {
      id: 'dev',
      label: `dev ≤ ${c.maxDevPct}%`,
      check: async (p, ctx) => (ctx.rug?.devPct == null ? { ok: null, value: 'inconnu' } : { ok: ctx.rug.devPct <= c.maxDevPct, value: `${ctx.rug.devPct.toFixed(1)}%` }),
    },
    {
      id: 'insiders',
      label: `bundle / insiders ≤ ${c.maxInsiderPct}%`,
      check: async (p, ctx) =>
        ctx.rug?.insiderPct == null ? { ok: null, value: 'inconnu' } : { ok: ctx.rug.insiderPct <= c.maxInsiderPct, value: `${ctx.rug.insiderPct.toFixed(1)}%` },
    },
  ];
}

export async function runFilter(pair) {
  const c = config.filter;
  const a = state.agents.filter;
  const rules = buildRules(c);
  const view = {
    symbol: pair.symbol,
    address: pair.address,
    rules: rules.map((r) => ({ id: r.id, label: r.label, status: 'pending', value: '' })),
    step: 0,
    verdict: null,
  };
  state.filterView = view;
  a.status = 'check';
  a.checked++;
  updateFlow(pair.address, { stage: 'filter' });
  changed();

  const ctx = {};
  let failed = null;
  for (let i = 0; i < rules.length; i++) {
    view.step = i + 1;
    view.rules[i].status = 'running';
    changed();
    let res;
    try {
      res = await rules[i].check(pair, ctx);
    } catch (e) {
      res = { ok: null, value: 'erreur' };
    }
    const ok = res.ok === null ? !c.strict : res.ok;
    view.rules[i].value = res.value;
    view.rules[i].status = ok ? 'pass' : 'fail';
    if (state.sim) await sleep(250); // animation lisible en démo
    if (!ok) {
      failed = { rule: rules[i].label, value: res.value };
      for (let j = i + 1; j < rules.length; j++) view.rules[j].status = 'skipped';
      break;
    }
  }

  view.verdict = failed ? 'killed' : 'pass';
  if (failed) {
    a.killed++;
    killed.add(pair.address);
    updateFlow(pair.address, { stage: 'filter', verdict: 'killed', why: `${failed.rule} (${failed.value})` });
    log('filter', `$${pair.symbol} éliminé : ${failed.rule} → ${failed.value}`);
  } else {
    updateFlow(pair.address, { stage: 'analyst' });
    log('filter', `$${pair.symbol} passe les 8 règles → ANALYST`);
  }
  a.status = 'idle';
  changed();
  return { pass: !failed, ctx };
}
