# Futures Desk — bot Futures autonome (OKX ou MEXC, liste long / short du matin)

Le bot tourne sur ton PC et trade des contrats à terme crypto.

- **OKX (par défaut).** Il trade les **X-Perps**. OKX est agréé MiCA et MiFID II, et ces contrats sont accessibles aux comptes européens avec un levier jusqu'à 10x. Ce sont des futures à échéance de 5 ans, avec un funding, qui se comportent comme des perpétuels.
- **MEXC.** Il trade les perpétuels USDT. Attention : MEXC quitte la France, avec des restrictions à partir du 31/12/2026 selon ton lot.

On change de plateforme avec une seule ligne dans `.env` : `EXCHANGE=okx` ou `EXCHANGE=mexc`. Toute la plateforme tient dans un module (`src/exchanges/`). Si une plateforme ferme, en ajouter une autre ne demande pas de refaire le bot.

1. **Chaque matin** (08:00 par défaut), il analyse les cryptos les plus liquides de la plateforme. Il produit la **liste du jour**, avec un score sur 100 et la raison de chaque choix.
2. **Pendant la journée**, il ouvre ces positions (marge isolée, taille calculée sur le risque). Il pose le **stop-loss directement chez la plateforme** et suit un trailing stop.
3. **Il garde les positions jusqu'à 5 jours.** Elles se ferment au stop, au trailing ou à la durée maximale.

La liste est enregistrée dans `listes/AAAA-MM-JJ.md` (lisible) et `.json`, et s'affiche dans le tableau de bord **http://127.0.0.1:8790**.

## Installation (Windows)

1. Installe **Node.js 20 ou plus** (version LTS) depuis https://nodejs.org.
2. Télécharge ce dossier `futures-bot` sur ton PC (par exemple `C:\futures-bot`).
3. Copie `.env.example` en `.env`. Les réglages par défaut conviennent pour commencer.
4. Double-clique sur **`lancer-paper.bat`**. Le bot démarre en argent fictif, avec les vrais prix OKX, et ouvre le tableau de bord. En mode paper, aucune clé API n'est nécessaire.

Aucune installation de paquet n'est nécessaire : le bot n'a aucune dépendance.

| Fichier | Rôle |
|---|---|
| `lancer-paper.bat` | Argent fictif, vrais prix. **Commence ici, au moins 2 à 4 semaines.** |
| `backtest.bat` | Rejoue la stratégie sur les 180 derniers jours de la plateforme (aucun ordre). |
| `liste-du-jour.bat` | Génère seulement la liste du jour (aucun trade) et ouvre le dossier `listes`. |
| `tester-cle-api.bat` | Vérifie ta clé API (solde, positions) sans passer d'ordre. |
| `lancer-live.bat` | Argent réel. |

Sur Mac ou Linux : `npm run paper`, `npm run liste`, `npm run test-api`, `npm run live`.

### Démarrage automatique avec Windows

Appuie sur `Win + R`, tape `shell:startup`, puis place dans ce dossier un raccourci vers `lancer-paper.bat` (ou `lancer-live.bat`). Le PC doit rester allumé et ne pas se mettre en veille : *Paramètres → Système → Alimentation → Veille : Jamais*.

## Comment la liste est construite

Pour chaque contrat crypto, le bot calcule un score long et un score short sur 100. Il garde le côté qui a le meilleur score.

| Critère | Points | Pour un LONG | Pour un SHORT |
|---|---|---|---|
| Tendance journalière | 25 | prix > EMA20 > EMA50, EMA20 qui monte | l'inverse |
| Tendance 4 h | 20 | prix > EMA20 > EMA50 en 4 h | l'inverse |
| Momentum (RSI jour) | 20 | RSI 50–68 (ni faible, ni suracheté) | RSI 32–50 |
| Force relative vs BTC (7 j) | 15 | fait mieux que BTC | fait moins bien que BTC |
| Volume d'hier vs moyenne 20 j | 10 | volume en hausse sur une bougie verte | sur une bougie rouge |
| Funding | 10 | pénalisé si les longs paient cher | pénalisé si les shorts paient cher |

Le bot garde ensuite :
- **seulement le sens du BTC** (régime) : si le BTC est au-dessus de sa moyenne 50 jours, uniquement des longs, sinon uniquement des shorts ;
- les scores ≥ 65 ;
- les volatilités (ATR journalier) comprises entre 2 et 9 % ;
- au maximum 3 contrats du même côté, et un **budget de corrélation** : la somme des corrélations au BTC ne dépasse pas 2,4 par côté, ce qui fait en pratique environ 3 positions très corrélées.

La logique se trouve dans `src/strategy.js`. C'est le même code que celui du backtest : ce qui est testé est exactement ce qui tourne.

Les actions, l'or, le pétrole, le forex et les stablecoins sont exclus : seules les cryptos sont retenues.

**Tu gardes la main** avec `listes/manuel.json`, créé automatiquement :
```json
{ "exclure": ["PEPE"], "forcerLong": ["SOL"], "forcerShort": [] }
```
Dans le tableau de bord, tu peux aussi :
- retirer un token de la liste ;
- régénérer la liste ;
- mettre le bot en pause ;
- fermer une position.

Pour relire la liste avant chaque matin de trading, mets `AUTO_TRADE=false` : le bot attendra que tu cliques sur « valider la liste ».

## Gestion du risque (réglages validés par backtest)

| Règle | Valeur par défaut |
|---|---|
| Taille | **0,75 % du capital risqué par trade** : la taille est calculée pour que le stop coûte 7,50 $ sur 1 000 $. Levier x5 au maximum, marge isolée, 10 % de marge au plus par position. |
| Stop-loss | **1,5 × ATR journalier** : environ 7 % sur XRP, 11 % sur ONDO. Il est large, mais la taille est réduite d'autant. **Posé chez la plateforme** (sur OKX, il est attaché à l'ordre d'entrée), il reste actif même si ton PC s'éteint. |
| Trailing stop | Activé à +1,5 R, il suit ensuite le meilleur prix à 1 R. R est la distance du stop. Le stop est aussi déplacé chez la plateforme. |
| Durée max | 5 jours. Les positions ne sont **pas** fermées à chaque nouvelle liste. |
| Positions max | 5 au total, 3 max du même côté, plus le budget de corrélation |
| Entrée | Pas d'entrée si le prix est déjà parti de plus de 3 %, et uniquement dans les 8 h après la liste. |
| Coupe-circuit | −4 % sur la journée : plus aucune ouverture jusqu'au lendemain. |

Tout se règle dans `.env` (voir `.env.example`).

## Backtest : comment ces réglages ont été choisis

```bash
npm run backtest                 # 180 derniers jours, compare la v1 du bot aux variantes
npm run backtest-robustesse      # réglages voisins de la version retenue
node src/backtest.js --days=120 --skip=180   # hors échantillon : les 120 jours précédents
```

Pour chaque jour de l'historique, le backtest :
- calcule la liste avec **uniquement les bougies déjà clôturées** à ce moment-là ;
- entre à l'ouverture de la bougie 1 h suivante ;
- gère chaque position bougie 1 h par bougie 1 h, avec 0,04 % de frais et 0,05 % de slippage à chaque ordre.

Quand le stop et un objectif tombent dans la même bougie, le backtest compte le stop.

Résultats au 07/11/2026, sur les 35 contrats crypto les plus liquides de chaque plateforme :

| | MEXC · 180 derniers jours | MEXC · 120 jours précédents | OKX · 180 derniers jours | OKX · 120 jours précédents |
|---|---|---|---|---|
| **v1** : stop 2,5 %, 24 h | −4,8 % · PF 0,99 · DD −22 % | +9,4 % · PF 1,07 · DD −20 % | −24,9 % · PF 0,90 · DD −29 % | −13,8 % · PF 0,92 · DD −36 % |
| **v2 (actuelle)** : stop 1,5 ATR, 5 j, trailing en R, régime BTC | **+14,9 % · PF 1,52 · DD −4 %** | **+6,3 % · PF 1,41 · DD −6,6 %** | **+13,8 % · PF 1,45 · DD −4,9 %** | **+6,9 % · PF 1,46 · DD −5 %** |

PF = profit factor (gains ÷ pertes). DD = pire baisse depuis un sommet. Les rendements de la v2 sont calculés à 0,6 % de risque par trade.

- **Frais du backtest :** 0,04 % de frais et 0,05 % de slippage par ordre sur MEXC, 0,05 % et 0,1 % sur OKX, plus prudent car les X-Perps sont moins liquides.
- **Historique OKX :** les X-Perps n'existent que depuis avril 2026. Le backtest OKX utilise donc l'historique des perpétuels USDT d'OKX sur les mêmes cryptos.
- **Plateforme testée :** `node src/backtest.js --exchange=okx` ou `--exchange=mexc`.

Ce qu'on en retient :
- **Le signal (tendance + force relative) a de la valeur, mais il faut le laisser respirer.** Un stop de 2,5 % sur des cryptos qui bougent de 5 % par jour se fait sortir par le bruit.
- **Le régime BTC aide nettement**, sur les deux périodes.
- **Les filtres « qualité » ne sont pas fiables** : ils aident sur une période et nuisent sur l'autre. Ils sont donc désactivés.
- **Les 16 variantes voisines de la v2 sont toutes positives**, sur MEXC comme sur OKX (PF 1,26 à 1,71). Le résultat est un plateau, pas un réglage chanceux, et il tient sur deux plateformes.

Limites : l'univers est celui des contrats liquides **aujourd'hui** (biais du survivant), le funding n'est pas simulé, et la période ne couvre pas tous les types de marché. Un backtest positif ne garantit pas les résultats futurs. Relance-le régulièrement.

## Passer en argent réel (OKX)

1. **Vérifie que tu as accès aux X-Perps.** Dans l'appli OKX, regarde si l'onglet « Futures » ou « X-Perps » est disponible. OKX fait passer un test d'adéquation avant d'autoriser les produits dérivés. L'ouverture aux résidents français n'est pas confirmée officiellement : c'est à vérifier dans ton compte.
2. **Passe le compte en mode « Futures »** (ou supérieur) : *Paramètres → Mode de compte*. Le mode « Spot » ne permet pas de trader les X-Perps.
3. **Crée une clé API** : *Profil → API → Créer une clé*.
   - Coche **uniquement** « Lecture » et « Trading ». **Ne coche jamais « Retrait ».**
   - Lie la clé à l'**adresse IP de ton PC** et note la **passphrase** que tu choisis.
4. **Mets les identifiants dans `.env`**, puis double-clique `tester-cle-api.bat`. Il doit afficher ton solde.
   ```
   EXCHANGE=okx
   OKX_API_KEY=...
   OKX_API_SECRET=...
   OKX_PASSPHRASE=...
   ```
5. **Recommandé : teste d'abord sur le compte démo d'OKX.** Crée une clé dans le mode « Trading démo » d'OKX, mets `OKX_DEMO=true`, puis lance `lancer-live.bat`. Ce sont de vrais ordres sur la vraie API, mais avec de l'argent fictif. C'est le meilleur test avant le réel.
6. **Passe en réel.** Transfère seulement la somme que tu acceptes de perdre. Mets `OKX_DEMO=false` et ajoute `LIVE_CONFIRM=JE_COMPRENDS_LES_RISQUES`, puis lance `lancer-live.bat`.

Sur MEXC (`EXCHANGE=mexc`), la marche à suivre est la même avec `MEXC_API_KEY` et `MEXC_API_SECRET`. Il n'y a pas de passphrase ni de compte démo.

Ne touche pas à la main aux positions du bot. Le bot ne gère que les positions qu'il a ouvertes lui-même : tes autres positions ne sont jamais modifiées. Le fichier `.env` contient ta clé : ne le partage jamais.

## Fichiers produits

- `listes/AAAA-MM-JJ.md` / `.json` : la liste de chaque matin
- `data/trades-<plateforme>-<mode>.csv` : chaque trade (s'ouvre dans Excel, séparateur `;`)
- `data/bot.log` : journal complet
- `data/state-*.json` : état, repris automatiquement au redémarrage

## À savoir, honnêtement

- Cette liste est une **analyse technique automatique** (tendance + momentum). Ce n'est pas une prédiction et ce n'est pas un conseil financier. Aucune méthode ne gagne à tous les coups : en backtest, environ un trade sur deux est perdant, et les gains viennent de quelques trades qui courent plusieurs jours. Attends-toi à des séries de pertes.
- Le levier amplifie les pertes autant que les gains. Juge le bot sur plusieurs semaines en paper, en regardant le P&L **après frais**, avant d'engager de l'argent.
- En live, le P&L affiché à la fermeture est une estimation. Le montant exact (frais, funding) est sur la plateforme.
- **La liquidité des X-Perps OKX est faible.** Le BTC échange environ 75 M$ par jour, et la plupart des autres cryptos entre 0,5 et 5 M$. Pour des positions de quelques centaines de dollars, ça suffit. Pour des montants bien plus gros, attends-toi à du slippage.
- Si une plateforme change son API ou restreint l'accès, les ordres peuvent être refusés : le journal l'indiquera.
