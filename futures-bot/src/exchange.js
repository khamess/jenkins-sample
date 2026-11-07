// Choix de la plateforme (EXCHANGE=okx | mexc). Tout le reste du bot passe par cette interface.
import { config } from './config.js';

export const ex = config.exchange === 'mexc' ? await import('./exchanges/mexc.js') : await import('./exchanges/okx.js');

/** "SOL", "SOL_USDT", "SOL-USDT", "SOL-USD_UM_XPERP-310404" → "SOL" */
export const baseOf = (s) => String(s).toUpperCase().trim().split(/[-_]/)[0];
