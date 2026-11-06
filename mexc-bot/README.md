# MEXC Desk — bot Futures autonome (liste long / short du matin)

Le bot tourne sur ton PC et trade les contrats perpétuels USDT de MEXC.

1. **Chaque matin** (08:00 par défaut), il analyse les ~60 cryptos les plus liquides de MEXC Futures. Il produit la **liste du jour** : jusqu'à 5 LONG et 5 SHORT, chacun avec un score sur 100 et la raison de son choix.
2. **Pendant la journée**, il ouvre ces positions (levier x5, marge isolée). Il pose un **stop-loss directement sur MEXC**, suit le trailing stop et ferme ce qui doit l'être.
3. **Le lendemain matin**, une nouvelle liste arrive. Les positions qui n'y figurent plus sont fermées.

La liste est enregistrée dans `listes/AAAA-MM-JJ.md` (lisible) et `.json`, et s'affiche dans le tableau de bord **http://127.0.0.1:8790**.

## Installation (Windows)

1. Installe **Node.js 20 ou plus** (version LTS) depuis https://nodejs.org.
2. Télécharge ce dossier `mexc-bot` sur ton PC (par exemple `C:\mexc-bot`).
3. Copie `.env.example` en `.env`. Les réglages par défaut conviennent pour commencer.
4. Double-clique sur **`lancer-paper.bat`**. Le bot démarre en argent fictif, avec les vrais prix MEXC, et ouvre le tableau de bord.

Aucune installation de paquet n'est nécessaire : le bot n'a aucune dépendance.

| Fichier | Rôle |
|---|---|
| `lancer-paper.bat` | Argent fictif, vrais prix. **Commence ici, au moins 2 à 4 semaines.** |
| `liste-du-jour.bat` | Génère seulement la liste du jour (aucun trade) et ouvre le dossier `listes`. |
| `tester-cle-api.bat` | Vérifie ta clé API MEXC (solde, positions) sans passer d'ordre. |
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
- les scores ≥ 65 ;
- les volatilités (ATR journalier) comprises entre 2 et 9 % ;
- au maximum 5 contrats par côté.

Les actions, l'or, le pétrole, le forex et les stablecoins sont exclus : seules les cryptos sont retenues.

**Tu gardes la main** avec `listes/manuel.json`, créé automatiquement :
```json
{ "exclure": ["PEPE_USDT"], "forcerLong": ["SOL_USDT"], "forcerShort": [] }
```
Dans le tableau de bord, tu peux aussi :
- retirer un token de la liste ;
- régénérer la liste ;
- mettre le bot en pause ;
- fermer une position.

Pour relire la liste avant chaque matin de trading, mets `AUTO_TRADE=false` : le bot attendra que tu cliques sur « valider la liste ».

## Gestion du risque (profil « moyen x5 »)

| Règle | Valeur par défaut |
|---|---|
| Levier | x5, marge isolée |
| Marge par position | 5 % du capital (donc 25 % du capital en exposition) |
| Positions max | 5 au total, 3 max du même côté (5 shorts = un seul gros pari sur la baisse du BTC) |
| Stop-loss | −2,5 % du prix, soit −12,5 % de la marge et environ −0,6 % du capital. **Posé sur MEXC**, il reste actif même si ton PC s'éteint. |
| Trailing stop | après +4 %, le stop suit le meilleur prix à 2 % de distance (remonté aussi sur MEXC) |
| Entrée | pas d'entrée si le prix est déjà parti de plus de 3 %, et uniquement dans les 8 h après la liste |
| Durée max | 24 h |
| Coupe-circuit | −6 % sur la journée : plus aucune ouverture jusqu'au lendemain |

Tout se règle dans `.env` (voir `.env.example`).

## Passer en argent réel

1. Sur MEXC : *Profil → Gestion API → Créer une clé API*.
   - Coche **uniquement** la permission Futures / trading. **Ne coche jamais le retrait.**
   - Lie la clé à l'**adresse IP de ton PC**.
2. Mets dans `.env` :
   ```
   MEXC_API_KEY=...
   MEXC_API_SECRET=...
   ```
   puis double-clique `tester-cle-api.bat`. Il doit afficher ton solde Futures.
3. Transfère sur ton compte **Futures** seulement la somme que tu acceptes de perdre.
4. Ajoute `LIVE_CONFIRM=JE_COMPRENDS_LES_RISQUES` dans `.env`, puis lance `lancer-live.bat`.

Ne touche pas à la main aux positions du bot. Le bot ne gère que les positions qu'il a ouvertes lui-même : tes autres positions ne sont jamais modifiées. Le fichier `.env` contient ta clé : ne le partage jamais.

## Fichiers produits

- `listes/AAAA-MM-JJ.md` / `.json` : la liste de chaque matin
- `data/trades-paper.csv` / `trades-live.csv` : chaque trade (s'ouvre dans Excel, séparateur `;`)
- `data/bot.log` : journal complet
- `data/state-*.json` : état, repris automatiquement au redémarrage

## À savoir, honnêtement

- Cette liste est une **analyse technique automatique** (tendance + momentum). Ce n'est pas une prédiction et ce n'est pas un conseil financier. Aucune méthode ne gagne à tous les coups ; avec un stop serré, beaucoup de trades se termineront en petite perte.
- Le levier amplifie les pertes autant que les gains. Juge le bot sur plusieurs semaines en paper, en regardant le P&L **après frais**, avant d'engager de l'argent.
- En live, le P&L affiché à la fermeture est une estimation. Le montant exact (frais, funding) est sur MEXC.
- Si MEXC change son API ou restreint l'accès API aux Futures, les ordres peuvent être refusés : le journal l'indiquera.
