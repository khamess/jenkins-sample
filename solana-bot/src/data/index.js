import { config } from '../config.js';

// Choisit la source de données : réelle ou simulée.
export const data = config.sim ? await import('./sim.js') : await import('./live.js');
