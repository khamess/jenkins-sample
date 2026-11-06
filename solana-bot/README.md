# Sol Desk — bot de trading autonome Solana (6 agents)

Un bot qui tourne seul, jour et nuit : il trouve des memecoins Solana, les filtre, les note, achète, protège chaque position avec un stop et revend. Aucune intervention humaine.

```
SCOUT → FILTER → ANALYST → EXECUTOR → RISK → LOGGER
```

| Agent | Rôle |
|---|---|
| **SCOUT** | Récupère les tokens Solana récents sur DexScreener. Garde les paires de 20 min à 48 h avec une market cap de 250 k$ à 15 M$. |
| **FILTER** | 8 règles strictes, un seul échec = éliminé : liquidité ≥ 45 k$, volume 1 h ≥ 60 k$, pump 1 h ≤ 75 %, mint/freeze révoqués (lu on-chain), LP brûlée/verrouillée ≥ 95 %, top 10 holders ≤ 20 %, dev ≤ 2 %, insiders/bundle ≤ 8 % (RugCheck). |
| **ANALYST** | Note sur 100 : momentum, acheteurs, ratio achat/vente, accélération du volume, liquidité/mcap, holders. Seuls les 70+ passent. |
| **EXECUTOR** | Achète au maximum 8 % du solde par trade (3 positions max). En réel : swap via Jupiter, signé localement. |
| **RISK** | Stop −6 % posé avant l'entrée, trailing stop (6 % sous le plus haut) après +12 %, durée max 4 h, coupe-circuit si −20 % sur la journée. |
| **LOGGER** | Journal complet (`data/bot.log`), historique des trades (`data/trades-*.jsonl`), état sauvegardé et repris au redémarrage. |

Le tableau de bord temps réel est sur **http://127.0.0.1:8787** : flux live, règles du filtre, jauge de score, positions avec graphique entrée/stop/trailing, stats et journal. Le gros bouton rond met le bot en pause.

## Démarrage

Il faut [Node.js](https://nodejs.org) 20 ou plus.

```bash
cd solana-bot
npm install

npm run sim     # 1) démo hors ligne : données simulées, argent fictif
npm run paper   # 2) vraies données du marché, argent fictif  ← reste ici plusieurs jours
```

Puis ouvre http://127.0.0.1:8787.

Pour régler le bot : `cp .env.example .env` et modifie les valeurs (seuils, stop, taille des positions…).

### Le voir sur ton téléphone

Dans `.env`, mets `HOST=0.0.0.0` et `DASHBOARD_TOKEN=un-mot-de-passe-long`. Ouvre ensuite `http://IP-DE-TON-PC:8787/?token=un-mot-de-passe-long` depuis le même Wi-Fi.

### Le faire tourner 24 h/24

Sur un petit VPS ou un PC toujours allumé :

```bash
npm install -g pm2
pm2 start src/index.js --name solbot
pm2 save && pm2 startup
```

## Mode réel (argent réel)

À ne faire **qu'après** plusieurs jours de paper trading avec des résultats positifs.

1. Crée un portefeuille **dédié** (jamais ton portefeuille principal) et mets-y seulement ce que tu acceptes de perdre entièrement.
2. Prends un RPC privé (Helius, QuickNode… il y a des offres gratuites) : le RPC public est trop limité.
3. Dans `.env` :
   ```
   MODE=live
   LIVE_CONFIRM=JE_COMPRENDS_LES_RISQUES
   PRIVATE_KEY=ta_cle_base58        # ou KEYPAIR_PATH=/chemin/keypair.json
   RPC_URL=https://...ton-rpc...
   ```
4. Lance `npm run live`.

La clé privée reste sur ta machine : elle sert uniquement à signer localement les transactions renvoyées par Jupiter. Ne la partage jamais, ne la commit jamais (`.env` est ignoré par git).

## À savoir, honnêtement

- **La vidéo Instagram est du marketing.** Passer de 69 $ à 10 000 $ en une nuit n'est pas un résultat reproductible. Sur ces tokens, la majorité des trades perdent ; les filtres réduisent les arnaques évidentes mais ne garantissent rien.
- **Le stop n'est pas un ordre posé sur la chaîne.** RISK vérifie le prix toutes les 8 s puis vend : sur un rug brutal, la sortie peut se faire bien en dessous de −6 %.
- Les frais (priorité, swaps, ~0,002 SOL de création de compte token) pèsent lourd sur de petites positions.
- Certaines données (RugCheck, holders) peuvent manquer. En mode strict (par défaut), une donnée manquante = token éliminé.
- Ceci n'est pas un conseil financier.
