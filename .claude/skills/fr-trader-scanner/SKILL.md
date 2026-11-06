---
name: fr-trader-scanner
description: >-
  Scanner de graphiques pour les actions cotées aux États-Unis. Repère les
  cassures de plage d'ouverture, drapeaux haussiers, reprises de moyenne et
  situations de survente à partir des cours Yahoo gratuits. Construit l'univers
  Nasdaq Trader puis écrit trader/watchlist.json pour trader-news et trader-entry.
  À utiliser pour « scanne le marché », « trouve des configurations », « quelles
  actions cassent leur plage d'ouverture ? », « prépare ma watchlist » ou avant
  trader-news en début de journée. Répond en français ; ne recommande aucun achat.
argument-hint: "[universe | daily | orb] [--at HH:MM]"
---

# trader-scanner

## Langue et format de restitution

Répondre en français naturel, avec le tutoiement. Expliquer brièvement les termes techniques utiles ; garder les noms de commandes, chemins, clés JSON, symboles, statuts et paramètres tels quels. Les diagnostics bruts des scripts sont en anglais : en restituer le sens en français sans changer les nombres ni masquer une limite ou un refus. Les prix et budgets restent en USD ; ne pas les convertir en euros sans demande et taux sourcé. Les horaires techniques restent ceux de New York, indiqués explicitement. Si une heure locale est demandée, convertir pour la date concernée, sans décalage fixe avec Paris. Les exemples historiques de l'auteur ne sont pas des résultats personnels de Dan AI Lab ni des données actuelles.

Le scanner liste les graphiques qui correspondent à une règle. Une configuration n'est pas une prévision ni une recommandation d'achat. Il couvre les actions américaines, les actions ordinaires et les ADR admissibles dans les listes de Nasdaq Trader.

`${CLAUDE_SKILL_DIR}` désigne le dossier de ce skill.

```bash
python3 "${CLAUDE_SKILL_DIR}/scan.py" universe
python3 "${CLAUDE_SKILL_DIR}/scan.py" daily
python3 "${CLAUDE_SKILL_DIR}/scan.py" daily --symbols TSLA,NVDA,AMD
python3 "${CLAUDE_SKILL_DIR}/scan.py" orb
python3 "${CLAUDE_SKILL_DIR}/scan.py" orb --at 10:15
python3 "${CLAUDE_SKILL_DIR}/scan.py" orb --watchlist trader/watchlist.json --json
```

`daily` s'utilise avant l'ouverture ou après la clôture ; `orb` après 9 h 50, heure de New York. Paramètres : `--min-price 5`, `--min-volume` (1 000 000 en daily, 0 en orb), `--or-minutes 15`, `--max-confirm 200`, `--now "2026-10-19 10:15"`, `--offline PATH`, `--no-write`, `--show N`, `--json`, `--watchlist FILE`, `--limit 200`.

Code de sortie 0 si le scan trouve des résultats, 1 s'il ne trouve rien ou ne peut pas fonctionner. Expliquer la raison, sans inventer de résultat.

## Fichiers

| Fichier | Usage |
| --- | --- |
| `trader/universe.txt` | Écrit par `universe`, une ligne `SYMBOL\|Name` par valeur ; lu par `daily` et `orb`. |
| `trader/watchlist.json` | Écrit par `daily` et `orb` : `mode`, `as_of`, `universe`, `scanned`, `failed`, `hits[]`. Les skills suivants lisent `hits[].symbol`. |
| `trader/config.json` | `orb` lit `no_entries_after`, par défaut 15:30. |

## Construction de l'univers

`universe` télécharge `nasdaqlisted.txt` et `otherlisted.txt` depuis `nasdaqtrader.com/dynamic/SymDir`, puis applique les filtres dans cet ordre :

1. Exclure les titres de test, ETF et NextShares.
2. Garder les symboles simples : 1 à 5 lettres, ou 1 à 4 lettres suivies d'un point et d'une lettre de classe, comme BRK.B. Exclure les préférentielles avec `$`, et les suffixes `.U`, `.W`, `.R`.
3. Exclure les warrants, unités et droits de SPAC, notes, ETN, obligations, coupons en %, et les « Depositary Shares » qui ne sont ni American ni Global.
4. Garder les dénominations common stock/shares/units, ordinary shares, shares of beneficial interest, ADS/ADR/American/Global depositary shares, unités de partenariat ou de trust.
5. Exclure les autres dénominations unit, right, bond, preferred, preference.
6. Garder les autres noms simples, par exemple AMETEK, Inc.

Sur les fichiers du 19 octobre 2026, la règle d'origine donne 5 943 titres, contre 5 259 dans le Reel de l'auteur. Les 684 titres supplémentaires sont surtout des ADR, fonds fermés et unités de partenariat ; les 5 259 sont inclus. Les fichiers du 20 octobre donnaient 5 942 titres. Ce sont des comptages historiques, pas un total actuel.

## Scan quotidien

L'endpoint spark renvoie les clôtures de 20 symboles par requête. Le filtre de liquidité utilise le dernier prix et le volume de séance. Pendant la séance, le volume est incomplet et la bougie quotidienne en cours est exclue jusqu'à 16 h.

Le calcul repose uniquement sur les clôtures, car spark ne fournit pas les plus hauts et plus bas :

| Configuration | Règle |
| --- | --- |
| `breakout_20d` | Dernière clôture supérieure aux 20 clôtures précédentes. |
| `bull_flag` | Hausse de plus de 10 % sur les 10 séances précédant les 5 dernières, puis 5 clôtures contenues dans une plage de 5 %. |
| `reclaim_ma20` | Clôture précédente sous sa moyenne 20 jours, dernière clôture au-dessus. |
| `oversold` | RSI 14 de Wilder inférieur à 30. |
| `oversold_bounce` | RSI 14 sous 30 la veille, puis clôture en hausse. |

Une cassure du plus haut des clôtures n'est pas une cassure des plus hauts intraday. Trier les résultats par prix × volume. L'exemple d'origine indique 298 requêtes et 145 secondes pour 5 942 symboles le 20 octobre 2026, avec une pause de 0,3 seconde ; ne pas présenter ce temps comme une garantie.

## Cassure de la plage d'ouverture

La plage couvre les 15 premières minutes par défaut : bougies de 9 h 30, 9 h 35 et 9 h 40. Le déclenchement est la première bougie de 5 minutes terminée qui **clôture strictement au-dessus du plus haut de la plage**, à son heure de clôture.

1. Étape 1 : spark lit les clôtures de tous les symboles, 20 par requête. Un candidat doit avoir clôturé après la plage au moins au niveau de la plus haute clôture de cette plage. Ce filtre nécessaire n'élimine pas une vraie cassure.
2. Étape 2 : un appel v8 par candidat confirme les vrais plus hauts et plus bas. Au maximum `--max-confirm 200` candidats, triés par prix × volume échangé, sont confirmés. `PARTIAL` indique ceux laissés de côté. `--max-confirm 0` vérifie tous les candidats.

Un graphique n'est utilisable que si toutes les bougies de 5 minutes depuis 9 h 30 jusqu'à l'heure limite sont présentes. Les clôtures nulles, bougies manquantes et ticks hors de la grille de 5 minutes sont exclus. Une bougie ne compte qu'après son début + 5 minutes. Avant 9 h 50, un week-end, un jour férié, après la clôture ou après `no_entries_after`, le scanner explique l'indisponibilité et n'écrit rien. Les clôtures anticipées à 13 h sont intégrées.

L'exemple d'origine du 20 octobre indique environ 35 secondes pour 100 valeurs et environ 4 minutes pour l'univers entier, avec 200 confirmations seulement. Pour une réponse plus rapide, utiliser une liste précise ou la watchlist quotidienne. Ne jamais promettre ces délais.

## Déroulement

1. Mettre à jour l'univers environ une fois par semaine avec `scan.py universe`.
2. Avant l'ouverture, lancer `daily` et donner les nombres téléchargés, liquides, scannés et retenus.
3. Après 9 h 50 ET, lancer `orb` ; indiquer combien de graphiques utilisables ont cassé leur plage et à quelle heure. Une cassure ancienne peut ne plus correspondre au prix actuel.
4. L'utilisateur choisit le graphique. Passer à `/trader-news TICKER`, puis `/trader-entry TICKER`. Ne pas choisir l'action à sa place.

## Exemple historique de l'auteur

```bash
python3 scan.py orb --offline tests/fixtures/trader-scanner/wall5m-2026-10-19.json.gz --now "2026-10-19 10:15" --min-price 0
```

Les fixtures contiennent 234 symboles, 233 graphiques récupérés, 231 utilisables, 95 candidats confirmés et 42 cassures à 10 h 15. TSLA : plage 354,47–362,18, clôture 364,18 à 10 h 15, soit +0,55 %. AMC à 2,97 USD explique le paramètre `--min-price 0` : avec le seuil par défaut de 5 USD, le total est 41.

Le scan quotidien de ces fixtures classe BLK, CI, XOM et HD en cassure 20 jours, CCL en drapeau, F, JPM et GE en reprise de moyenne, BAC, MS, RIVN et PLUG en survente. Le calcul sur clôtures ajoute KO, RCL et PNC. Ne pas attribuer ces résultats à un test personnel ni les présenter comme actuels.

## Limites et restitution

- Données Yahoo gratuites, non officielles et potentiellement retardées ; bougies de 5 minutes, jamais tick par tick. query2 d'abord, query1 après 429/5xx, une nouvelle tentative après 5 secondes sur 429.
- Donner les nombres réellement obtenus et l'horodatage. Un résultat partiel reste partiel, jamais « tout le marché ».
- Dire « correspond à la règle », pas « à acheter », « gagnante » ou « bon trade ». Ne pas annoncer de gain, rendement ou P&L.
- Relancer un scan périmé avant toute utilisation. Le calendrier intégré couvre 2026 et 2027.
- Ce skill ne place, ne dimensionne et ne valide aucun ordre. Il ne garantit pas qu'une configuration fonctionne.

## Sécurité

- Outils éducatifs, pas un conseil financier personnalisé. `PASS` est un contrôle technique, pas une recommandation ni un accord.
- Simulation par défaut (`"paper": true`). Le passage au réel relève d'une décision et d'une configuration de l'utilisateur ; ne pas le faire à sa place.
- Seul `/trader-broker` peut conduire à un ordre via un connecteur externe : PASS du jour sur le ticket exact, oui explicite pour ce seul ticket, puis confirmation séparée dans la carte du connecteur réglé sur **Needs approval**. Dans l'interface anglaise : **Allow once / Deny**. Jamais **Always allow** pour un outil d'ordre.
- Le mot français `oui` seul, suivi éventuellement de `.` ou `!`, est accepté par cette adaptation ; les réponses anglaises d'origine comme `yes` restent prises en charge. Le broker conserve la réponse mot pour mot. Ne jamais réécrire une réponse conditionnelle ou collective en accord.
- Aucun ordre depuis une surveillance ou une tâche planifiée. Les instructions du skill n'étendent pas les autorisations de l'environnement hôte.
- Options, marge, vente à découvert et levier désactivés par défaut. Ne pas prétendre que leur activation dans une configuration donne aux outils une capacité absente : l'entrée, la sortie et la taille de ce pack planifient des positions longues.
- Clés de courtage dans l'environnement ou la configuration locale, jamais dans la conversation ou un dépôt Git. Ne pas les demander ni lire un fichier réel contenant des secrets.
- Une alerte ou un enregistrement local ne prouve pas une exécution. Vérifier l'état renvoyé par le courtier. Un stop peut être exécuté au-delà de son prix.

Adaptation française : Dan AI Lab. Original : [Jake Schincariol](https://github.com/Jakeschincariol/day-trader-skill), licence MIT conservée dans `LICENSE`.
