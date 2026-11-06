---
name: fr-trader-alerts
description: >-
  Alertes de prix, stop, objectif, mouvement en pourcentage, heure et ouverture
  NYSE. Transforme trader/plan.json en trois alertes et écrit trader/prices.json
  pour budget et risk. Cours gratuits Yahoo ou Stooq, potentiellement retardés ;
  calendrier New York 2026–2027 avec clôtures anticipées. À utiliser pour
  « préviens-moi quand », « surveille mon stop », « rappelle-moi de sortir »,
  « le marché est ouvert ? », « donne-moi un cours » ou après trader-exit.
  Explique les déclenchements en français, sans passer d'ordre.
argument-hint: "[ticker] [prix en USD]"
---

# trader-alerts

## Langue et format de restitution

Répondre en français naturel, avec le tutoiement. Expliquer brièvement les termes techniques utiles ; garder les noms de commandes, chemins, clés JSON, symboles, statuts et paramètres tels quels. Les diagnostics bruts des scripts sont en anglais : en restituer le sens en français sans changer les nombres ni masquer une limite ou un refus. Les prix et budgets restent en USD ; ne pas les convertir en euros sans demande et taux sourcé. Les horaires techniques restent ceux de New York, indiqués explicitement. Si une heure locale est demandée, convertir pour la date concernée, sans décalage fixe avec Paris. Les exemples historiques de l'auteur ne sont pas des résultats personnels de Dan AI Lab ni des données actuelles.

Une alerte informe ; elle ne vend ni n'achète rien. Avec un bracket, le stop et l'objectif sont des ordres placés chez le courtier. Les alertes locales indiquent qu'un niveau ou une heure a été atteint ; vérifier l'état réel de la position chez le courtier.

```bash
python3 "${CLAUDE_SKILL_DIR}/alerts.py" clock
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --from-plan
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --opening-bell
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol TSLA --stop 358.32
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol TSLA --target 370.04
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --at 15:55 --label "Sortie avant clôture" --before-close
python3 "${CLAUDE_SKILL_DIR}/alerts.py" add --symbol KO --pct 3
python3 "${CLAUDE_SKILL_DIR}/alerts.py" check
python3 "${CLAUDE_SKILL_DIR}/alerts.py" quote TSLA --write
python3 "${CLAUDE_SKILL_DIR}/alerts.py" quote --holdings --write
python3 "${CLAUDE_SKILL_DIR}/alerts.py" list
python3 "${CLAUDE_SKILL_DIR}/alerts.py" reset tsla-plan-stop
```

`${CLAUDE_SKILL_DIR}` désigne ce dossier. `--now "2026-10-19 15:55"` fige l'heure à New York ; `--offline DIR` lit des fichiers sauvegardés. Code 0 de `check` : au moins une alerte a sonné.

## Fichiers

| Fichier | Usage |
| --- | --- |
| `trader/plan.json` | Plan de trader-exit pour `add --from-plan`. |
| `trader/alerts.json` | Règles ; voir `alerts.example.json`. |
| `trader/state/alerts.json` | Déclenchements précédents pour éviter les doublons. |
| `trader/prices.json` | Derniers cours fusionnés avec horodatage, pour budget et risk. |
| `trader/portfolio.json` | Symboles détenus pour `quote --holdings`. |

## Types de règle

| Type | Déclenchement | Réarmement |
| --- | --- | --- |
| `above` / `target` | Prix supérieur ou égal à `price`. | Après `reset`, ou automatiquement si `rearm: true` et retour préalable sous le seuil. |
| `below` / `stop` | Prix inférieur ou égal à `price`. | Même logique, dans l'autre sens. |
| `pct_move` | Écart de `pct` % à la clôture précédente ou à `ref`, avec direction up/down facultative. | Une fois par jour au maximum. |
| `time` | Heure `at` dépassée à New York un jour de bourse. | Une fois par séance. |
| `opening_bell` | NYSE ouvert. | Une fois par séance. |

Une règle avec `date` ne s'applique qu'à ce jour de New York. Celles issues du plan portent sa date : le stop d'hier ne sonne pas aujourd'hui. `before_close: true` avance une règle horaire de 3 heures quand le NYSE ferme à 13 h : 15 h 55 devient 12 h 55.

## Cours

- Yahoo, choix par défaut : `query2.finance.yahoo.com/v8/finance/chart/<TICKER>`, endpoint gratuit non officiel, une requête par symbole et une pause de 0,5 seconde. Sur 429 : attente et nouvelle tentative ; puis repli query1 après 429 ou 5xx. Le User-Agent du moteur reste `day-trader-skill/2.0`.
- Stooq : `stooq.com/q/l/?s=tsla.us&f=sd2t2ohlcv&h&e=csv`. L'auteur a observé une réponse 404 le 13 octobre 2026 ; le parseur est conservé, sans promettre la disponibilité actuelle.
- Les cours gratuits peuvent convenir à une alerte ou un contrôle de taille, pas à une promesse d'entrée instantanée. Le courtier fixe le prix effectivement exécuté. trader-risk utilise seulement un prix de moins de 15 minutes.
- Si les deux sources échouent, lire le cours du connecteur de courtage disponible, par exemple Alpaca `get_stock_snapshot` ou IBKR `get_price_snapshot`, puis écrire le format `{"as_of":"...Z","prices":{"TSLA":366.48}}` avec l'horodatage réel. Ne pas inventer de cours ni prétendre qu'un outil absent est disponible.

## Horloge NYSE

Séance régulière de 9 h 30 à 16 h à New York. Le moteur gère le changement d'heure sans dépendre du fuseau de l'ordinateur. Calendrier conservé de l'amont, consulté par l'auteur le 13 octobre 2026 sur [NYSE](https://www.nyse.com/markets/hours-calendars) :

- 2026 : 1 et 19 janvier, 16 février, 3 avril, 25 mai, 19 juin, 3 juillet, 7 septembre, 26 novembre, 25 décembre. Clôture à 13 h les 27 novembre et 24 décembre.
- 2027 : 1 et 18 janvier, 15 février, 26 mars, 31 mai, 18 juin, 5 juillet, 6 septembre, 25 novembre, 24 décembre. Clôture à 13 h le 26 novembre.

Pour une autre année, annoncer que la liste des jours fériés est inconnue. Ne pas présenter un calendrier historique comme une vérification du jour.

## Déroulement

1. Après le plan, lancer `add --from-plan` et confirmer à l'utilisateur les trois alertes : stop, objectif, heure de sortie.
2. Pendant la position, lancer `check` à la fréquence demandée via une boucle ou une tâche réellement disponible. Chaque passage lit seulement les symboles des règles du jour. Une vérification ponctuelle n'est pas une surveillance continue ; un prix peut franchir le seuil entre deux passages.
3. Décrire chaque déclenchement en une ligne. Après un stop ou objectif, vérifier `get_open_position` et l'exécution du courtier avant de journaliser avec trader-broker.
4. À l'heure limite, si une position reste ouverte, préparer `trader-broker flatten`, puis trader-risk et le oui propre à cet ordre. Ne pas exécuter automatiquement depuis l'alerte.

## Exemple historique de l'auteur

TSLA le 19 octobre 2026 : entrée 364,18, stop 358,32, objectif 370,04, sortie à 15 h 55. `add --from-plan` écrit `tsla-plan-stop`, `tsla-plan-target`, `tsla-flat-by` pour cette journée.

À 10 h 53, le cours de 10 h 52 vaut 366,48 : aucun seuil atteint, trois règles surveillées. À 15 h 55, l'alerte demande de vérifier et fermer ce qui reste ouvert selon le parcours broker → risk → oui. Elle ne sonne qu'une fois. Le lendemain, les trois règles datées ne sont plus surveillées ; l'alerte `opening_bell` peut sonner à 9 h 30.

## Limites

Une alerte décrit un prix observé ou une heure. Confirmer chaque nouvelle règle : symbole, type, seuil et date. Ne jamais présenter un cours retardé comme temps réel, prédire une direction, ou placer, modifier ou annuler un ordre depuis ce skill.

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
