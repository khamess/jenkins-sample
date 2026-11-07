// Tableau de bord local : http://127.0.0.1:8790
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { state, snapshot, bus, log, changed } from './state.js';
import { closeWhere } from './trader.js';

export function startServer({ runMorning }) {
  const clients = new Set();
  let pending = false;
  const push = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of clients) res.write(payload);
    }, 300);
  };
  bus.on('change', push);
  setInterval(push, 5000);

  const json = (res, obj, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (config.dashboard.token && url.searchParams.get('token') !== config.dashboard.token) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Accès refusé : ajoute ?token=... à l’adresse');
    }
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(config.root, 'public', 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/state') return json(res, snapshot());
    if (req.method === 'GET' && p === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      return res.end();
    }
    switch (p) {
      case '/api/pause':
        state.paused = true;
        log('Pause : plus aucune nouvelle position (les stops restent actifs).');
        break;
      case '/api/resume':
        state.paused = false;
        log('Reprise.');
        break;
      case '/api/approve':
        state.approved = true;
        log('Liste validée : les entrées peuvent commencer.');
        break;
      case '/api/rescan':
        runMorning('manuel');
        break;
      case '/api/skip': {
        const sym = url.searchParams.get('symbol');
        for (const c of [...(state.list?.longs || []), ...(state.list?.shorts || [])]) {
          if (c.symbol === sym && !c.done) {
            c.done = true;
            c.note = 'retiré à la main';
            log(`${sym} retiré de la liste à la main`);
          }
        }
        break;
      }
      case '/api/close': {
        const id = url.searchParams.get('id');
        for (const pos of state.positions) if (id === 'all' || pos.id === id) pos.forceClose = 'fermeture manuelle';
        log(`Fermeture manuelle demandée (${id === 'all' ? 'toutes' : id})`);
        if (id === 'all') closeWhere(() => true, 'fermeture manuelle');
        break;
      }
      default:
        res.writeHead(404);
        return res.end();
    }
    changed();
    return json(res, { ok: true });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nLe port ${config.dashboard.port} est déjà utilisé : le bot tourne sans doute déjà dans une autre fenêtre.\nFerme-la, ou change PORT dans .env.\n`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(config.dashboard.port, config.dashboard.host, () => {
    const q = config.dashboard.token ? `?token=${config.dashboard.token}` : '';
    console.log(`\n  Tableau de bord : http://${config.dashboard.host === '0.0.0.0' ? 'localhost' : config.dashboard.host}:${config.dashboard.port}/${q}\n`);
  });
}
