---
name: fr-trader-timemachine
description: >-
  Simule 10 000 fins de séance à partir des bougies de 5 minutes des 60 derniers
  jours d'une action, puis rejoue la même règle sur chaque séance historique.
  Lit le plan trader-exit et écrit trader/timemachine.json : objectif en premier,
  stop en premier, ni l'un ni l'autre, prix final, R moyen et verdict.
  À utiliser pour « simule ce trade », « teste ce scénario », « Monte Carlo »,
  « combien de fois l'objectif est atteint ? » ou entre trader-exit et
  trader-budget. Explique en français les résultats du modèle, sans prédiction.
argument-hint: "[chemin vers plan.json ou TICKER]"
---

# trader-timemachine

## Langue et format de restitution

Répondre en français naturel, avec le tutoiement. Expliquer brièvement les termes techniques utiles ; garder les noms de commandes, chemins, clés JSON, symboles, statuts et paramètres tels quels. Les diagnostics bruts des scripts sont en anglais : en restituer le sens en français sans changer les nombres ni masquer une limite ou un refus. Les prix et budgets restent en USD ; ne pas les convertir en euros sans demande et taux sourcé. Les horaires techniques restent ceux de New York, indiqués explicitement. Si une heure locale est demandée, convertir pour la date concernée, sans décalage fixe avec Paris. Les exemples historiques de l'auteur ne sont pas des résultats personnels de Dan AI Lab ni des données actuelles.

Le plan fixe l'entrée, le stop et l'objectif. Ce skill mesure ce qui se passe si le reste de la séance est reconstruit à partir des bougies récentes de l'action. Les 10 000 trajectoires ne représentent pas tous les futurs possibles. Il s'agit d'une simulation et d'un test historique, pas d'une prévision.

```bash
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run --write
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run --until 15:55
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run --json
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" run --symbol TSLA --date 2026-10-19 \
    --entry 364.18 --stop 358.32 --target 370.04 --entry-time "10:15 AM"
python3 "${CLAUDE_SKILL_DIR}/timemachine.py" chart --from
```

`${CLAUDE_SKILL_DIR}` est le dossier du skill. Autres paramètres : `--replays N`, `--seed N` (19 par défaut), `--window N` (2 bougies), `--offline FILE` (JSON Yahoo, éventuellement compressé), `--now "2026-10-19 10:15"` à New York.

## Données et fichier produit

| Source | Usage |
| --- | --- |
| `trader/plan.json` | Symbole, date, entrée, heure/bougie, stop/règle, objectif/R, plage d'ouverture. |
| API Yahoo | Une requête `range=60d&interval=5m`, gratuite, non officielle, retard possible. |
| `trader/timemachine.json` | Avec `--write` : `plan`, `mc`, `history` et verdict. `mc` contient probabilités, percentiles, bandes du graphique, 160 trajectoires et histogramme final à 24 classes. |

## Méthode conservée du projet d'origine

1. **Échantillon.** Uniquement les séances complètes antérieures au plan : 78 bougies de 5 minutes entre 9 h 30 et 16 h, heure de New York. Exclure demi-séances, lacunes et journée du plan. Chaque bougie devient quatre ratios OHLC à la clôture précédente.
2. **Trajectoire.** Partir du prix d'entrée. Pour chaque bougie restante, tirer une bougie historique à la même heure, avec une fenêtre de ±2 bougies par défaut, puis appliquer ses ratios au prix courant. Tester d'abord le stop, puis l'objectif. Si les deux sont touchés dans une même bougie, compter le stop.
3. **Résultats.** Objectif en premier, stop en premier, aucun des deux à `--until`, et trajectoire positive (« green » : objectif atteint ou prix final supérieur à l'entrée). La fin vaut 16 h par défaut, ou 13 h lors d'une clôture anticipée. Avec `--until 15:55`, elle correspond à l'heure limite du plan.
4. **R.** +1 pour un objectif 1R, −1 au stop ; sinon distance finale à l'entrée divisée par le risque. Le modèle compte encore −1R sur un gap au-delà du stop : l'exécution réelle peut être moins favorable.
5. **Historique.** Rejouer la règle du plan, avec les mêmes paramètres de plage, stop et R, sur chaque séance disponible. Cette partie décrit ce qui s'est produit dans les données, contrairement aux trajectoires rééchantillonnées.
6. **Verdict.** Sur les trajectoires qui touchent l'un des deux seuils, comparer la fréquence d'objectif au seuil d'équilibre `1 / (1 + R)` : 50 % à 1R, environ 33 % à 2R, 25 % à 3R. Écart inférieur à 5 points : proche d'un pile ou face à 1R, proche de l'équilibre aux autres R. Entre 5 et 15 points : biais vers l'objectif ou le stop. À partir de 15 points : biais marqué.
7. Si plus de 40 % des trajectoires ne touchent aucun seuil, reprendre l'avertissement imprimé : leur prix final compte. Mentionner aussi un R moyen dont le signe contredit le biais du verdict.

Exemple méthodologique : à 2R, 24,1 % d'objectifs et 50,5 % de stops donnent environ 32 % d'objectifs parmi les 74,6 % qui touchent un seuil. Cela reste proche du seuil d'équilibre de 33 %, pas une comparaison directe 24,1 contre 50,5.

**Graine reproductible.** `random.Random(seed)` utilise 19 par défaut. Même plan, données et graine donnent les mêmes nombres. Toujours donner la graine.

**Refus.** Moins de 20 séances complètes, bougie d'entrée absente ou non terminée, date future, entrée hors de la grille 5 minutes ou plan incohérent. Yahoo ne conserve qu'environ 7 jours en 1 minute : le moteur utilise uniquement les bougies de 5 minutes sur 60 jours.

## Déroulement

1. Vérifier que le plan est celui du jour. Sinon utiliser d'abord `/trader-exit`, ou des paramètres explicites pour un rejeu historique.
2. Lancer `run --write`. Ajouter `--until 15:55` si c'est l'heure limite du plan.
3. Présenter dans l'ordre : les quatre probabilités, médiane et intervalle des percentiles 5–95 du prix final, R moyen, historique, verdict et réserves imprimées. Donner la graine.
4. Garder la ligne de verdict brute comme référence et en donner la traduction fidèle en français. Ne pas renforcer sa conclusion ni en retirer une réserve. Si simulations et historique divergent, le signaler.
5. Dire que le modèle utilise les 60 derniers jours et ne prédit pas les prochains. Résultats, suspensions et actualités peuvent produire un événement absent de cet historique ; consulter `/trader-news`.
6. Si l'utilisateur souhaite poursuivre, passer à `/trader-budget`.

## Exemple historique de l'auteur

TSLA le 19 octobre 2026 : entrée 364,18 à 10 h 15, stop 358,32, objectif 370,04 (1R), risque 5,86 par action. Graine 19, 69 bougies restantes jusqu'à 16 h :

| Résultat | Valeur |
| --- | --- |
| Objectif en premier | 29,4 % |
| Stop en premier | 25,5 % |
| Aucun des deux | 45,1 % |
| Trajectoire positive | 51,7 % |
| Prix final médian | 364,36 USD |
| Intervalle couvrant 90 % des trajectoires | 355,54–373,54 USD |
| R moyen simulé | +0,034 |

Sur 59 séances réelles, 33 déclenchements : 13 objectifs, 15 stops, 5 cas restants, R moyen −0,062. Le verdict du moteur est proche d'un pile ou face : l'objectif est atteint en premier dans 53,6 % des trajectoires touchant un seuil. L'historique réel est légèrement sous l'équilibre. Ne pas transformer ces chiffres en avantage démontré.

## Limites

- Chaque nombre doit venir de l'exécution, jamais d'une estimation rédigée.
- Reprendre sans embellissement le verdict, ses réserves et les cas sans seuil touché.
- Les probabilités simulées ne garantissent rien. Les données Yahoo restent non officielles et retardées.
- Une modification d'entrée, stop, objectif ou date impose une nouvelle simulation.
- Ce skill ne place aucun ordre, ne calcule pas la taille, ne modifie pas le plan et ne présente pas de bénéfice attendu.
- Ne jamais utiliser de bougies non terminées ni intégrer les bougies du jour au réservoir historique.

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
