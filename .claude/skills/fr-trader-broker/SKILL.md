---
name: fr-trader-broker
description: >-
  Prépare les tickets d'ordre et leur suivi pour Alpaca ou Interactive Brokers.
  Exige un PASS du jour sur le ticket exact, un oui explicite pour cet ordre
  unique, puis une validation séparée dans l'outil de courtage. Simulation
  par défaut. Affiche entrée, stop, objectif, perte au stop et JSON exact ;
  journalise décisions et exécutions et prépare une sortie avant la clôture.
  À utiliser pour « prépare cet ordre », « envoie au courtier », « ferme ma
  position », « connecte Alpaca » ou après trader-risk. Répond en français ;
  ticket.py lui-même n'appelle jamais le courtier.
argument-hint: "[numéro du ticket]"
---

# trader-broker

## Langue et format de restitution

Répondre en français naturel, avec le tutoiement. Expliquer brièvement les termes techniques utiles ; garder les noms de commandes, chemins, clés JSON, symboles, statuts et paramètres tels quels. Les diagnostics bruts des scripts sont en anglais : en restituer le sens en français sans changer les nombres ni masquer une limite ou un refus. Les prix et budgets restent en USD ; ne pas les convertir en euros sans demande et taux sourcé. Les horaires techniques restent ceux de New York, indiqués explicitement. Si une heure locale est demandée, convertir pour la date concernée, sans décalage fixe avec Paris. Les exemples historiques de l'auteur ne sont pas des résultats personnels de Dan AI Lab ni des données actuelles.

Seul ce skill peut conduire à un ordre via une intégration externe. Pour **chaque ordre**, exiger trois validations distinctes :

1. **trader-risk a validé le ticket exact aujourd'hui**, avec la même empreinte.
2. **L'utilisateur a donné un oui explicite pour cet ordre uniquement**, dans la conversation.
3. **L'utilisateur valide séparément la demande du connecteur**, configuré sur **Needs approval**, dans la carte **Allow once / Deny** de Claude.

Deux confirmations de l'utilisateur et un PASS technique. Aucun ordre sans elles. Une validation antérieure, une tâche planifiée ou un oui pour un lot ne les remplace pas.

```bash
python3 "${CLAUDE_SKILL_DIR}/ticket.py" show
python3 "${CLAUDE_SKILL_DIR}/ticket.py" approve --index 1 --reply "oui"
python3 "${CLAUDE_SKILL_DIR}/ticket.py" result --index 1 --status placed --broker-id ID --filled-qty 8 --filled-price 364.20
python3 "${CLAUDE_SKILL_DIR}/ticket.py" fill --symbol TSLA --side sell --qty 8 --price 370.04
python3 "${CLAUDE_SKILL_DIR}/ticket.py" flatten --symbol TSLA --qty 8
python3 "${CLAUDE_SKILL_DIR}/ticket.py" log
```

`${CLAUDE_SKILL_DIR}` est le dossier de ce skill. `ticket.py` n'appelle jamais le courtier : il affiche, vérifie une réponse, prépare les tickets et tient le journal. `--now "2026-10-19 10:15"` fige l'heure de New York.

## Fichiers

| Fichier | Usage |
| --- | --- |
| `trader/orders.json` | Propositions de trader-budget ; `flatten` les remplace. |
| `trader/state/risk.json` | Seul un PASS du jour sur l'empreinte exacte donne READY. |
| `trader/state/broker.json` | Réponses originales, refus, envois, échecs, exécutions et risque initial de chaque entrée. |
| `trader/portfolio.json` | Liquidités et actions mises à jour par `fill` ou `result --filled-qty`. |
| `trader/plan.json` | Heure `flat_by` pour la sortie. |

## Connexion A : Alpaca dans Claude Desktop

Le serveur officiel est [alpacahq/alpaca-mcp-server](https://github.com/alpacahq/alpaca-mcp-server), sous MIT. Le projet d'origine a vérifié sa configuration avec la version 2.4.0 le 20 octobre 2026. Vérifier la documentation du fournisseur si l'interface ou les outils ont changé. Ne pas supposer qu'un compte est disponible dans tous les pays.

1. L'utilisateur crée son compte et ses clés **paper trading** dans le tableau de bord Alpaca. Elles sont distinctes des clés réelles.
2. Il installe `uv` depuis [la documentation officielle](https://docs.astral.sh/uv/) pour disposer de `uvx`.
3. Dans Claude Desktop : **Settings > Developer > Edit Config**. Le fichier est `claude_desktop_config.json`, sous `~/Library/Application Support/Claude/` sur macOS ou `%APPDATA%\Claude\` sur Windows. L'utilisateur ajoute lui-même la configuration de `claude_desktop_config.example.json` et saisit ses clés localement :

```json
{
  "mcpServers": {
    "alpaca": {
      "command": "uvx",
      "args": ["alpaca-mcp-server"],
      "env": {
        "ALPACA_API_KEY": "CLE_PAPER_A_SAISIR_LOCALEMENT_JAMAIS_DANS_LE_CHAT",
        "ALPACA_SECRET_KEY": "SECRET_PAPER_A_SAISIR_LOCALEMENT_JAMAIS_DANS_LE_CHAT",
        "ALPACA_PAPER_TRADE": "true",
        "ALPACA_TOOLSETS": "account,trading,stock-data"
      }
    }
  }
}
```

Les clés passent au serveur par variables d'environnement. Ne jamais les demander, lire le fichier réel dans la conversation, répéter une clé ou la committer. Si une clé est divulguée, demander à son propriétaire de la révoquer et d'en générer une autre. `ALPACA_PAPER_TRADE` reste true. `ALPACA_TOOLSETS` limite les outils exposés.

4. Redémarrer Claude Desktop.
5. Dans **Customize > Connectors** (ou Settings > Connectors dans une ancienne version), ouvrir Alpaca et régler les permissions :
   - `place_stock_order` : **Needs approval**, jamais Always allow.
   - Toute modification, annulation ou clôture (`cancel_order_by_id`, `replace_order_by_id`, `close_position`, `update_account_config`) : **Needs approval**.
   - `place_option_order`, `place_crypto_order`, `close_all_positions`, `cancel_all_orders`, `exercise_options_position`, `do_not_exercise_options_position` : **Blocked**, sauf demande précise de l'utilisateur et prise en charge vérifiée.
   - Les outils de lecture (`get_account_info`, `get_all_positions`, `get_open_position`, `get_orders`, `get_clock`, `get_stock_snapshot`, `get_stock_latest_quote`) peuvent être autorisés en lecture.
6. Lire les informations du compte et faire confirmer dans le tableau de bord qu'il s'agit bien du compte de simulation.

Dans Claude Code, garder l'outil d'ordre dans `ask` de `.claude/settings.json` :

```json
{"permissions":{"ask":["mcp__alpaca__place_stock_order"]}}
```

Ne pas placer un outil d'ordre dans `allow`. Respecter également les confirmations imposées par l'environnement hôte : le skill ne donne aucune autorisation supplémentaire.

### Bracket Alpaca

Le ticket contient `take_profit_limit_price`, `stop_loss_stop_price` et éventuellement `stop_loss_limit_price`. `order_class` vaut `bracket`. Actions entières uniquement et `time_in_force` `day` ou `gtc`. Après exécution de l'entrée, le stop et l'objectif sont deux ordres liés qui s'annulent mutuellement. Pour les ordres day de l'exemple, ils expirent à la clôture. Ne pas confondre une alerte locale avec ces ordres chez le courtier.

## Connexion B : Interactive Brokers

Consulter le connecteur officiel dans l'annuaire Claude, [Interactive Brokers](https://claude.ai/directory/interactive-brokers), endpoint `https://api.ibkr.com/v1/api/mcp`. L'utilisateur se connecte dans le parcours du fournisseur, jamais dans le chat. La documentation d'origine décrit des instructions préparées puis revues et approuvées dans le compte IBKR, sans envoi direct au marché par Claude.

Utiliser `"broker": "ibkr"` dans `trader/config.json`. Garder aussi les outils de préparation sur **Needs approval**. L'accord final dans IBKR reste nécessaire. Vérifier les capacités actuelles de l'intégration avant de promettre un envoi ou une exécution.

## Entrée en position

1. Lancer `ticket.py show`. Présenter seulement les tickets READY. Tout NOT READY ou BLOCKED retourne à `/trader-risk`.
2. Montrer **un seul ticket**, avec symbole, sens, quantité, prix, stop, objectif et risque. Demander : « Tu confirmes cet ordre précis ? Réponds uniquement oui ou non. »
3. Passer la réponse **mot pour mot** à `approve --index N --reply "..."`. Le mot `oui` seul est accepté, avec éventuellement `.` ou `!`, sans condition ni lot. Les réponses anglaises d'origine sont conservées. « Oui à tout », « oui mais… », « oui si… », « d'accord » et « vas-y » sont refusés. Ne jamais traduire ou raccourcir une réponse pour la transformer en oui.
4. Si le script affiche `Not recorded`, expliquer le refus et redemander une réponse pour ce ticket. Uniquement après `Recorded your yes`, utiliser exactement le JSON imprimé pour `place_stock_order`, puis laisser l'utilisateur valider la carte du connecteur.
5. Enregistrer l'issue avec `result --status placed --broker-id <id>` et les quantités/prix exécutés renvoyés par le courtier, ou `--status denied`, ou `--status failed --note ...`. Un échec ne permet pas une nouvelle tentative sans nouveau contrôle et nouvel accord.

Le script conserve le risque maximal initial au stop pour les limites de journée. `why` et `plan` sont internes : ne jamais les envoyer au courtier. L'enregistrement local d'une approbation ne prouve pas qu'un ordre a été envoyé ni exécuté.

## Suivi et sortie avant clôture

- Après le plan, `alerts.py add --from-plan` surveille stop, objectif et heure limite. Les ordres bracket du courtier assurent l'exécution éventuelle ; les alertes informent.
- Quand le courtier confirme une exécution du stop ou de l'objectif, la journaliser avec `ticket.py fill --symbol TSLA --side sell --qty 8 --price 358.32`, en utilisant les valeurs réellement confirmées.
- À `flat_by` (15 h 55 à New York par défaut), préparer la clôture de toute position encore ouverte :
  1. Lire la quantité détenue avec `get_open_position`.
  2. `flatten --symbol TSLA --qty 8` écrit le ticket de vente au marché dans `trader/orders.json`.
  3. Passer `/trader-risk`. Une réduction de position n'est pas bloquée par la fenêtre ou les limites d'entrée.
  4. Afficher le ticket et recueillir son oui propre, comme ci-dessus.
  5. Si les jambes du bracket retiennent encore les actions, lire `get_orders` avec status open et nested true. Faire approuver leur annulation individuellement via `cancel_order_by_id`, puis l'envoi du ticket et son enregistrement. Ne pas annoncer la position close avant confirmation du courtier.

## Exemple historique de l'auteur

Le ticket TSLA d'exemple porte sur 8 actions au marché, stop 358,32, objectif 370,04 et perte au stop de 46,88 USD. Compte PAPER, risque PASS, attente du oui. L'utilisateur répond `oui` ; le journal garde exactement ce mot. La demande `place_stock_order` doit encore être approuvée séparément. Aucun ordre ne part si l'une de ces étapes manque.

## Limites

- Jamais plusieurs ordres avec une seule réponse ; jamais d'ordre depuis une tâche planifiée ou un processus de surveillance.
- Ne jamais demander ni lire de clés ou mots de passe, ni basculer vers un compte réel à la place de l'utilisateur.
- Ne jamais appeler de sa propre initiative `close_all_positions`, `cancel_all_orders` ou les outils d'options/crypto.
- Un ordre au marché et un stop n'offrent aucune garantie sur le prix exécuté.

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
