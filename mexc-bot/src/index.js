// Bot MEXC Futures autonome.
//   Chaque matin (MORNING_TIME) : génère la liste LONG / SHORT, ferme ce qui n'y est plus.
//   En continu (POLL_SEC) : ouvre les positions de la liste, surveille stop / trailing / durée.
import { config, validateConfig } from './config.js';
import { state, log, load, save, changed, today } from './state.js';
import * as mexc from './mexc.js';
import { generateList } from './screener.js';
import { initTrader, tryEntries, managePositions, closeWhere, refreshEquity, loadContracts } from './trader.js';
import { startServer } from './server.js';

function nextMorning(from = new Date()) {
  const [h, m] = config.morningTime.split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 1);
  return d;
}

function todaysMorningPassed() {
  const [h, m] = config.morningTime.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return Date.now() >= d.getTime();
}

let scanning = false;
export async function runMorning(trigger = 'programmé') {
  if (scanning) return;
  scanning = true;
  state.status = 'analyse du marché…';
  changed();
  try {
    await loadContracts(true);
    const list = await generateList((i, n, s) => {
      state.status = `analyse ${i}/${n} · ${s}`;
      changed();
    });
    state.list = list;
    state.approved = config.autoTrade;
    if (!config.autoTrade) log('AUTO_TRADE=false : valide la liste dans le tableau de bord pour lancer les entrées.');
    if (config.closeOnNewList) {
      const keep = new Set([...list.longs.map((x) => x.symbol + ':long'), ...list.shorts.map((x) => x.symbol + ':short')]);
      await closeWhere((p) => !keep.has(p.symbol + ':' + p.side), 'plus dans la liste du jour');
    }
    log(`Nouvelle liste (${trigger}) prête.`);
  } catch (e) {
    log(`Génération de la liste échouée : ${e.message}`, 'error');
  } finally {
    scanning = false;
    state.status = 'en marche';
    state.nextScanAt = nextMorning().getTime();
    changed();
  }
}

let ticking = false;
async function tick() {
  if (ticking || scanning) return;
  ticking = true;
  try {
    const tickers = new Map((await mexc.getTickers()).map((t) => [t.symbol, t]));
    await managePositions(tickers);
    await tryEntries(tickers);
    state.status = state.paused ? 'en pause' : state.halted ? 'coupe-circuit' : 'en marche';
  } catch (e) {
    state.status = 'erreur réseau';
    log(`Erreur : ${e.message}`, 'error');
  } finally {
    ticking = false;
    changed();
  }
}

function scheduleMorning() {
  const at = nextMorning();
  state.nextScanAt = at.getTime();
  const ms = at.getTime() - Date.now();
  setTimeout(async () => {
    await runMorning();
    scheduleMorning();
  }, Math.min(ms, 2 ** 31 - 1));
}

async function equityPoint() {
  await refreshEquity().catch(() => {});
  state.equityHistory.push({ t: Date.now(), v: +state.wallet.equityUsdt.toFixed(2) });
  if (state.equityHistory.length > 5000) state.equityHistory.splice(0, state.equityHistory.length - 5000);
  changed();
}

async function testApi() {
  console.log('Test de connexion à MEXC…');
  const offset = await mexc.syncTime();
  console.log(`  ✓ API publique OK (décalage horloge ${offset} ms)`);
  const b = await mexc.getUsdtBalance();
  console.log(`  ✓ Clé API OK — compte Futures : ${b.equity.toFixed(2)} USDT (disponible ${b.available.toFixed(2)})`);
  const pos = await mexc.getOpenPositions();
  console.log(`  ✓ Positions ouvertes : ${(pos || []).length}`);
  const mode = await mexc.getPositionMode().catch(() => null);
  console.log(`  ✓ Mode de position : ${mode === 1 ? 'hedge' : mode === 2 ? 'one-way' : 'inconnu'}`);
  console.log('Tout est prêt. Aucun ordre n’a été passé.');
}

async function main() {
  try {
    validateConfig();
  } catch (e) {
    console.error(`\nDémarrage impossible : ${e.message}\n`);
    process.exit(1);
  }

  if (config.testApi) {
    try {
      await testApi();
      process.exit(0);
    } catch (e) {
      console.error(`\nÉchec : ${e.message}\n\nVérifie la clé, le secret, la permission "Futures / Trade" et la liste d'IP autorisées de la clé.\n`);
      process.exit(1);
    }
  }

  if (config.scanOnly) {
    try {
      const l = await generateList((i, n) => process.stdout.write(`\r  analyse ${i}/${n}…`));
      console.log(`\n\nListe écrite dans listes/${l.date}.md`);
      process.exit(0);
    } catch (e) {
      console.error(`\nÉchec : ${e.message}`);
      process.exit(1);
    }
  }

  const restored = load();
  try {
    await initTrader();
  } catch (e) {
    console.error(`\nConnexion à MEXC impossible : ${e.message}\n`);
    process.exit(1);
  }
  log(`Bot démarré en mode ${config.mode.toUpperCase()}${config.mode === 'paper' ? ' (argent fictif, vrais prix MEXC)' : ' — ARGENT RÉEL'} · capital ${state.wallet.equityUsdt.toFixed(2)} USDT`);
  if (restored) log(`État restauré : ${state.positions.length} position(s) ouverte(s)`);

  startServer({ runMorning });
  await equityPoint();
  if ((!state.list || state.list.date !== today()) && todaysMorningPassed()) await runMorning('rattrapage au démarrage');
  scheduleMorning();
  state.status = 'en marche';
  await tick();
  setInterval(tick, config.pollSec * 1000);
  setInterval(equityPoint, 5 * 60_000);

  const stop = () => {
    console.log('\nArrêt. Les positions restent ouvertes sur MEXC avec leur stop serveur ; elles seront reprises au prochain démarrage.');
    save();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('unhandledRejection', (e) => log(`Erreur non gérée : ${e?.message || e}`, 'error'));
}

main();
