---
name: fr-trader-risk
description: >-
  Vérifie toute proposition avant le courtier : format, actif, stop, perte
  maximale, ratio, budget, liquidités, taille, limites quotidiennes, doublons
  et fenêtre d'entrée. Écrit PASS ou BLOCK avec l'empreinte de l'ordre pour
  trader-broker. Une sortie qui réduit une position n'est pas bloquée par les
  limites d'entrée. À utiliser pour « vérifie mon ordre », « respecte-t-il mes
  règles ? », « quel risque aujourd'hui ? » et toujours avant trader-broker.
  Expliquer les résultats en français sans traiter PASS comme un accord utilisateur.
argument-hint: "[chemin vers orders.json]"
---

# trader-risk

## Langue et format de restitution

Répondre en français naturel, avec le tutoiement. Expliquer brièvement les termes techniques utiles ; garder les noms de commandes, chemins, clés JSON, symboles, statuts et paramètres tels quels. Les diagnostics bruts des scripts sont en anglais : en restituer le sens en français sans changer les nombres ni masquer une limite ou un refus. Les prix et budgets restent en USD ; ne pas les convertir en euros sans demande et taux sourcé. Les horaires techniques restent ceux de New York, indiqués explicitement. Si une heure locale est demandée, convertir pour la date concernée, sans décalage fixe avec Paris. Les exemples historiques de l'auteur ne sont pas des résultats personnels de Dan AI Lab ni des données actuelles.

Chaque proposition de trader-budget ou de `trader-broker flatten` passe ici. Un `BLOCK` arrête ce ticket : ne pas le transmettre au courtier ni demander un oui pour contourner le refus. Ces règles contrôlent les limites du plan ; elles ne garantissent pas une faible perte réelle ni un gain.

```bash
python3 "${CLAUDE_SKILL_DIR}/check.py"
python3 "${CLAUDE_SKILL_DIR}/check.py" --json
python3 "${CLAUDE_SKILL_DIR}/check.py" --no-write
python3 "${CLAUDE_SKILL_DIR}/check.py" --now "2026-10-19 10:15"
```

`${CLAUDE_SKILL_DIR}` est le dossier du skill. Le dernier exemple fige l'heure de New York.

## Fichiers

| Fichier | Usage |
| --- | --- |
| `trader/orders.json` | Propositions issues de budget ou de flatten. |
| `trader/config.json` | Limites définies avec l'utilisateur. |
| `trader/portfolio.json` | Liquidités et positions. Si absent, le moteur suppose un compte neuf financé à hauteur du budget ; signaler cette hypothèse. |
| `trader/prices.json` | Prix récent pour le risque et la valorisation. |
| `trader/state/broker.json` | Ordres du jour, doublons, nombres de trades, risque journalier et day trades. |
| `trader/state/risk.json` | Verdicts avec empreinte du ticket exact. |

## Entrée et sortie

Une entrée ouvre ou augmente une position : achat ou vente qui créerait un short. Une sortie réduit seulement ce qui est déjà détenu. Pour une sortie, contrôler le format, l'actif et l'absence de vente à découvert. Les autres limites deviennent des avertissements, jamais un blocage empêchant de réduire une position.

Les propositions sont contrôlées dans leur ordre de fichier comme si les précédentes acceptées avaient été exécutées. Un lot peut ainsi être bloqué même si ses ordres isolés semblent admissibles.

## Contrôles

| Contrôle | Motif de blocage |
| --- | --- |
| Format | Symbole manquant, side autre que buy/sell, qty et notional ensemble ou tous deux absents, notional incompatible avec market + day, limite sans prix ; bracket sans actions entières, sans day/gtc, sans stop ou objectif. |
| Actif | Option si `allow_options` est false ; crypto ou symbole non conforme à une action/ETF américain. |
| Short | Vente supérieure à la détention lorsque `allow_short` est false. |
| Liste exclue | Entrée sur un symbole de `blocked`. |
| Taille | Entrée sous `min_order_usd` ou au-dessus de `max_order_usd`. |
| Position | Dépassement de `max_position_pct`. |
| Liquidités | Réserve insuffisante après l'achat ou recours à la marge non autorisé. |
| Stop | Absence de stop si `require_stop` true, ou stop du mauvais côté de l'entrée. |
| Perte | Quantité × (entrée − stop) supérieure à `max_loss_per_trade_usd`. |
| Ratio | (objectif − entrée) / (entrée − stop) inférieur à `min_reward_risk`. |
| Risque journalier | Somme des pertes maximales au stop des entrées du jour, plus ce ticket, supérieure à `max_daily_loss_usd`. |
| Nombre de trades | `max_trades_per_day` entrées déjà passées. |
| Fenêtre | Entrée avant `no_entries_before`, après `no_entries_after` ou marché fermé. |
| PDT | Seulement si `pdt_guard` true : 3 day trades déjà enregistrés sur les 5 derniers jours ouvrés. |
| Doublon | Même symbole et sens deux fois dans le lot ou déjà passé aujourd'hui. |
| Nombre d'ordres | `max_orders_per_day` ordres déjà passés. |

## Mesure du risque

- Ordre limite : son prix limite. Ordre au marché : maximum de l'entrée du plan et d'un prix récent, de moins de 15 minutes. Un cours ancien est ignoré avec une note. Ne pas sous-estimer le risque d'un plan dont le prix a déjà monté.
- Le risque journalier conserve **tout le risque initial au stop** des entrées passées aujourd'hui, même si elles ont été gagnantes. Trois trades à 50 USD épuisent la limite d'exemple de 150 USD.
- Fenêtre à New York, changement d'heure intégré, indépendamment du fuseau de l'ordinateur. Week-ends et fériés NYSE fermés. Une clôture à 13 h avance la fenêtre de 3 heures. Les deux paramètres `no_entries_*` à null désactivent ce contrôle ; ne pas le faire sans choix explicite.
- `pdt_guard`, désactivé par défaut, compte les symboles achetés et vendus le même jour dans le journal et les entrées du jour destinées à être clôturées. C'est le garde-fou historique conservé par le moteur : vérifier auprès du courtier les règles actuelles du compte. Ne pas présenter ce réglage comme une vérification réglementaire ou d'éligibilité.

Toujours annoncer les avertissements : compte LIVE, nombres envoyés comme nombres plutôt que chaînes, stop présent seulement dans le plan et non chez le courtier, prix trop ancien, clôture anticipée.

## Déroulement

1. Si le prix a pu bouger depuis le plan, rafraîchir avec `alerts.py quote TSLA --write`.
2. Lancer `check.py`. Code 0 : tous les ordres passent. Code 1 : au moins un blocage.
3. Pour chaque ticket, expliquer la perte au stop, le ratio et la consommation des limites du jour. Pour un refus, expliquer ce qui doit être revu : taille, plan de sortie, fenêtre ou abandon du trade. Ne jamais modifier une limite de sa propre initiative.
4. Toute modification d'un ticket impose un nouveau contrôle. Le broker compare les empreintes ; un ordre modifié ou un verdict de la veille n'est pas prêt.

## Exemple historique de l'auteur

Compte simulé de 5 000 USD, configuration d'exemple, TSLA à 10 h 15 le 19 octobre 2026 :

- 8 actions, entrée 364,18, stop 358,32, objectif 370,04 : risque 5,86 par action, perte au stop 46,88 USD sous le plafond de 50, ratio 1,00. Zéro trade préalable. Résultat `PASS`, liquidités après ordre 2 086,56 USD.
- 9 actions : perte au stop 52,74 USD. Résultat `BLOCK` pour dépassement de 50 USD.
- Même ticket de 8 actions contrôlé à 10 h 55 avec le prix de 10 h 52 à 366,48 : risque de 65,28 USD et ratio 0,44, deux motifs de refus.
- À 9 h 40 : entrée bloquée avant 9 h 45. Une vente à 15 h 55 qui ferme seulement les actions détenues passe malgré la fin de fenêtre d'entrée à 15 h 30.

## Limites

- `PASS` signifie seulement que ce ticket peut être présenté à l'utilisateur. Ce n'est ni un accord ni une recommandation.
- Tous les calculs viennent des fichiers et du journal, jamais d'une supposition silencieuse.
- Prix Yahoo gratuits, non officiels, retard possible ; exécution réelle au courtier, stop potentiellement dépassé.
- Aucun ordre placé, aucune modification pour forcer un PASS, aucune limite assouplie automatiquement.

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
