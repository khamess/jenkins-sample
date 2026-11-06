---
name: fr-trader-budget
description: >-
  Calcule la taille d'une position selon le budget, le risque maximal par
  trade, le plafond par position, le montant maximal d'ordre et les liquidités
  après réserve. Lit le plan trader-exit et propose un seul ordre bracket
  en actions entières, avec stop et objectif, au format Alpaca. Écrit
  trader/orders.json sans appeler le courtier. À utiliser pour « combien
  d'actions ? », « dimensionne ce trade », « mon budget est de 5 000 dollars »,
  « je risque au maximum 50 dollars » ou après le plan de sortie. Répond en français.
argument-hint: "[budget en dollars américains]"
---

# trader-budget

## Langue et format de restitution

Répondre en français naturel, avec le tutoiement. Expliquer brièvement les termes techniques utiles ; garder les noms de commandes, chemins, clés JSON, symboles, statuts et paramètres tels quels. Les diagnostics bruts des scripts sont en anglais : en restituer le sens en français sans changer les nombres ni masquer une limite ou un refus. Les prix et budgets restent en USD ; ne pas les convertir en euros sans demande et taux sourcé. Les horaires techniques restent ceux de New York, indiqués explicitement. Si une heure locale est demandée, convertir pour la date concernée, sans décalage fixe avec Paris. Les exemples historiques de l'auteur ne sont pas des résultats personnels de Dan AI Lab ni des données actuelles.

Transformer un plan en quantité d'actions en respectant les limites choisies par l'utilisateur. Plus le stop est éloigné, plus la taille diminue. Le résultat est une proposition : trader-risk la contrôle, trader-broker demande ensuite un accord distinct. La taille ne rend pas un trade gagnant et la perte réelle peut dépasser le calcul au stop.

```bash
python3 "${CLAUDE_SKILL_DIR}/size.py"
python3 "${CLAUDE_SKILL_DIR}/size.py" --write
python3 "${CLAUDE_SKILL_DIR}/size.py" --limit --write
python3 "${CLAUDE_SKILL_DIR}/size.py" --limit 364.00 --json
python3 "${CLAUDE_SKILL_DIR}/size.py" --weights AAPL=40,KO=60 --config split.json
```

`${CLAUDE_SKILL_DIR}` est le dossier du skill. `--now "2026-10-19 10:15"` fige l'heure de New York. Refuser un plan d'un autre jour ; refaire le plan avec trader-exit.

## Fichiers

| Fichier | Usage |
| --- | --- |
| `trader/config.json` | Limites ; partir de `config.example.json`. |
| `trader/plan.json` | Entrée, stop, objectif, configuration et heure limite. |
| `trader/prices.json` | Prix récent : une hausse par rapport au plan augmente le risque. Facultatif. |
| `trader/portfolio.json` | Liquidités réellement disponibles, plafond supplémentaire. Facultatif. |
| `trader/orders.json` | Une proposition bracket, écrite avec `--write`. |

## Fixer les règles

Si la configuration n'existe pas, copier l'exemple vers `trader/config.json` puis demander les valeurs utiles en français. Ne pas considérer les exemples comme des choix personnels de l'utilisateur.

- `budget` : montant dédié à cet usage, en USD, que l'utilisateur peut se permettre de perdre.
- `cash_buffer_pct` : réserve de liquidités, 10 % dans l'exemple.
- `max_loss_per_trade_usd` : perte maximale au prix du stop, 50 USD dans l'exemple.
- `max_position_pct`, `max_order_usd`, `min_order_usd` : 75 % du budget, 4 000 USD et 5 USD dans l'exemple.
- Limites de journée : `max_daily_loss_usd` 150, `max_trades_per_day` 3, `min_reward_risk` 1.0, `require_stop` true.
- Fenêtre à New York : `no_entries_before` 09:45, `no_entries_after` 15:30, `flat_by` 15:55.
- `blocked` : symboles exclus par l'utilisateur.
- Garder `paper` true tant que l'utilisateur n'a pas vérifié le fonctionnement en simulation. Ne pas basculer vers le réel à sa place.

## Calculer la taille

Lancer `size.py --write`. Un bracket Alpaca exige des actions entières. Arrondir vers le bas le minimum des quatre plafonds :

| Plafond | Nombre d'actions avant arrondi |
| --- | --- |
| Risque | `max_loss_per_trade_usd / (entrée - stop)` |
| Position | `budget × max_position_pct / entrée` (pourcentage converti en fraction). |
| Ordre | `max_order_usd / entrée` |
| Liquidités | `(budget - réserve) / entrée`, sans dépasser les liquidités du portefeuille si connu. |

Pour un ordre limite, utiliser le prix de `--limit`. Pour un ordre au marché, retenir le plus élevé entre l'entrée du plan et un prix de moins de 15 minutes dans `trader/prices.json`. Une baisse de prix ne réduit pas artificiellement le risque mesuré.

Refuser sans écrire d'ordre si : zéro action, montant sous le minimum, ratio sous `min_reward_risk`, stop non inférieur à l'entrée, objectif non supérieur, plan d'un autre jour, symbole bloqué ou position courte. Expliquer la raison en une ligne.

## Restituer

Montrer les quatre plafonds et celui qui détermine la taille, puis le nombre d'actions, le montant et la perte au prix du stop. Préciser qu'un stop peut être exécuté à un moins bon prix. Passer à `/trader-risk`, sans outil de courtage ici.

## Exemple historique de l'auteur

TSLA le 19 octobre 2026 : entrée 364,18, stop 358,32, objectif 370,04 ; risque de 5,86 USD par action. Budget d'exemple : 5 000 USD, réserve 10 %, risque maximal 50 USD.

| Limite | Calcul | Actions entières |
| --- | --- | --- |
| Risque | 50 / 5,86 | **8, limite retenue** |
| Position | 3 750 / 364,18 | 10 |
| Ordre | 4 000 / 364,18 | 10 |
| Liquidités | 4 500 / 364,18 | 12 |

8 actions coûtent 2 913,44 USD ; perte au stop 46,88 USD. La forme technique reste :

```json
{"symbol":"TSLA","side":"buy","qty":"8","type":"market","time_in_force":"day",
 "order_class":"bracket","take_profit_limit_price":"370.04","stop_loss_stop_price":"358.32",
 "plan":{"entry":364.18,"stop":358.32,"target":370.04,"risk_per_share":5.86,"max_loss":46.88,
         "setup":"orb","entry_time":"10:15 AM","flat_by":"15:55"}}
```

Le script ajoute aussi `why`. `why` et `plan` sont des notes internes pour risk et broker ; ne pas les envoyer à Alpaca. Avec un stop à 300, une seule action risque 64,18 USD : refus. Avec le prix historique de 366,48 à 10 h 52, le risque est 8,16 par action, la taille devient 6 et le ratio tombe à 0,44 : refus car la hausse attendue est en grande partie passée.

## Mode par pondération hérité de v1

`--weights AAPL=22.04,KO=10.86` ou `--targets FILE` répartit le budget après réserve. Renormaliser les poids à 100 ; plafonner chaque position à `max_position_pct` et redistribuer l'excédent ; supprimer les parts sous le minimum ; arrondir aux dollars entiers.

Avec `max_position_pct: 25` et `fractional: true`, la fixture donne AAPL 1 250 USD, AXP 1 119, GOOGL 823, KO 708 et BAC 600. Avec `fractional: false`, utiliser des actions entières et des prix fournis via `--prices`.

Ces propositions sont des achats simples sans stop : trader-risk les bloque si `require_stop` est true et les compte individuellement dans `max_trades_per_day`. Utiliser une configuration distincte via `--config` pour une répartition long terme ; ne pas désactiver les règles intraday pour la faire passer.

## Limites

- Ne jamais dimensionner un montant que l'utilisateur n'a pas dédié à ce projet. Obtenir budget et perte maximale.
- Aucun chiffre deviné : configuration, plan et prix uniquement.
- Ne jamais augmenter une limite ni rapprocher le stop pour acheter davantage d'actions.
- Pas de projection de gain, pas d'ordre passé ou programmé, pas d'options, marge ou positions courtes.
- Les prix gratuits peuvent être retardés ; le prix exécuté dépend du courtier.

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
