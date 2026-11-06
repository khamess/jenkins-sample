// fetch JSON avec timeout, retries et respect du rate limit (429).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastCall = new Map();

export async function getJson(url, { method = 'GET', body, headers = {}, retries = 2, timeoutMs = 12000, minIntervalMs = 0 } = {}) {
  const host = new URL(url).host;
  if (minIntervalMs) {
    const wait = (lastCall.get(host) || 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        lastErr = new Error(`429 rate limit ${host}`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${host}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}
