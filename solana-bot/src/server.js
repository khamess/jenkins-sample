// Tableau de bord : page HTML + flux temps réel (SSE) + commandes pause / reprise / fermeture.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { state, snapshot, bus, log, changed } from './state.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function authorized(req, url) {
  if (!config.dashboard.token) return true;
  return url.searchParams.get('token') === config.dashboard.token || req.headers['x-token'] === config.dashboard.token;
}

export function startServer() {
  const clients = new Set();
  let pending = false;
  const push = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of clients) res.write(payload);
    }, 250);
  };
  bus.on('change', push);
  setInterval(push, 2000);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!authorized(req, url)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Accès refusé : ajoute ?token=... à l’URL');
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(path.join(PUBLIC, 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(snapshot()));
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/pause') {
      state.paused = true;
      log('you', 'bot mis en pause (plus de nouveaux achats ; RISK continue de protéger les positions)');
      changed();
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/resume') {
      state.paused = false;
      log('you', 'bot relancé');
      changed();
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/close') {
      const id = url.searchParams.get('id');
      const targets = id === 'all' ? state.positions : state.positions.filter((p) => p.id === id);
      for (const p of targets) p.forceClose = true;
      log('you', `fermeture manuelle demandée (${targets.length} position(s))`);
      changed();
      return json(res, { ok: true, count: targets.length });
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(config.dashboard.port, config.dashboard.host, () => {
    const q = config.dashboard.token ? `?token=${config.dashboard.token}` : '';
    console.log(`\n  Tableau de bord : http://${config.dashboard.host}:${config.dashboard.port}/${q}\n`);
  });
  return server;
}

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
