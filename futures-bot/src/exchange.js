// Choix de la plateforme (EXCHANGE=okx | mexc | weex). Tout le reste du bot passe par cette interface.
import { config } from './config.js';

export const ex = await import(`./exchanges/${['mexc', 'weex'].includes(config.exchange) ? config.exchange : 'okx'}.js`);

/** "SOL", "SOL_USDT", "SOL-USDT", "SOL-USD_UM_XPERP-310404" → "SOL" */
export const baseOf = (s) => String(s).toUpperCase().trim().split(/[-_]/)[0];
