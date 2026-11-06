---
name: fr-trader-news
description: >-
  Veille des actualités pour les actions surveillées : titres Yahoo Finance,
  dépôts 8-K auprès de la SEC et variation depuis la clôture précédente.
  Affiche seulement les nouveautés, avec sources, symboles, catégories et heure
  de New York. À utiliser pour « des nouvelles de TSLA ? », « pourquoi ça bouge ? »,
  « briefing du matin », « surveille les 8-K » ou après trader-scanner.
  Vérifie les articles et les dépôts avant de présenter les faits en français.
argument-hint: "[tickers]"
---

# trader-news

## Langue et format de restitution

Répondre en français naturel, avec le tutoiement. Expliquer brièvement les termes techniques utiles ; garder les noms de commandes, chemins, clés JSON, symboles, statuts et paramètres tels quels. Les diagnostics bruts des scripts sont en anglais : en restituer le sens en français sans changer les nombres ni masquer une limite ou un refus. Les prix et budgets restent en USD ; ne pas les convertir en euros sans demande et taux sourcé. Les horaires techniques restent ceux de New York, indiqués explicitement. Si une heure locale est demandée, convertir pour la date concernée, sans décalage fixe avec Paris. Les exemples historiques de l'auteur ne sont pas des résultats personnels de Dan AI Lab ni des données actuelles.

Avant de transformer une configuration en trade, examiner les informations susceptibles de changer le contexte : résultats, suspension, procédure judiciaire, émission de titres. Présenter la nouvelle et le mouvement de cours ensemble, sans prédire la suite.

Outil Python standard, sans clé de données :

```bash
python3 "${CLAUDE_SKILL_DIR}/news.py"
python3 "${CLAUDE_SKILL_DIR}/news.py" --tickers TSLA NVDA --hours 12
python3 "${CLAUDE_SKILL_DIR}/news.py" --no-sec --json
```

## Entrées et état

| Source | Usage |
| --- | --- |
| `--tickers`, sinon `trader/watchlist.json` | Symboles issus du scanner. |
| `trader/plan.json` | Trade en préparation. |
| `trader/portfolio.json` | Positions déjà détenues. |
| RSS Yahoo Finance | `https://feeds.finance.yahoo.com/rss/2.0/headline?s=TSLA&region=US&lang=en-US` |
| Endpoint de graphiques Yahoo | Dernier prix face à la clôture précédente, non officiel et potentiellement retardé. |
| Flux Atom SEC EDGAR | 8-K par défaut ; `--forms 8-K,10-Q` pour élargir. |
| `trader/state/news.json` | Éléments déjà présentés, conservés 30 jours, et CIK de chaque société. |

La SEC demande `sec_user_agent` dans `trader/config.json` ou `SEC_USER_AGENT`. Sans identifiant fourni, ignorer les dépôts avec une explication ; ne pas inventer d'identité. Le User-Agent fourni est transmis à la SEC avec les requêtes.

## Règles de lecture

- Un titre est une piste. Ouvrir l'article ou le dépôt avant d'affirmer qu'un événement a eu lieu. Donner la source et son lien. Ne pas résumer un article payant inaccessible.
- En cas de désaccord, le 8-K indique ce que l'entreprise a déclaré à la SEC. Signaler la différence avec le titre de presse.
- Pour chaque élément, garder les symboles concernés et les catégories : earnings, analyst, legal, deal, capital, people, risk, halt, regulatory, macro. Les expliquer en français sans modifier les tags dans les fichiers.
- `!` marque un point important du 8-K : résultats 2.02, changement de dirigeant 5.02, dépréciation 2.06, avis de radiation 3.01, comptes passés non fiables 4.02, faillite 1.03, incident cyber 1.05.
- `MOVING` indique un écart d'au moins 3 % à la clôture précédente, réglable avec `--move-pct`. Signaler aussi un mouvement sans actualité identifiée.
- Aucune prévision : rapporter les publications et l'écart de prix, pas la prochaine direction du cours.

## Déroulement

1. Lancer `news.py`. Code 1 : rien de nouveau. `--all` inclut les éléments déjà vus ; `--json` donne les données structurées ; `--dry-run` ne modifie pas l'état.
2. Lire d'abord tous les dépôts `!`, les catégories résultats, suspension, juridique, réglementation ou risque, puis les symboles `MOVING`.
3. Rédiger un bref point par symbole : événement, source et lien, variation, conséquence pour le plan. Exemple : des résultats cette semaine exposent une position conservée la nuit à un gap.
4. Avant `/trader-entry` ou `/trader-exit`, signaler tout événement qui change le contexte du trade. Ne pas agir sur le titre seul.

Si l'utilisateur demande une surveillance, exemple de commande Claude Code : `/loop 15m /trader-news`. Une tâche planifiée peut faire le point avant l'ouverture. Vérifier que l'environnement prend en charge cette exécution ; une instruction seule ne crée pas une surveillance.

## Exemple historique de l'auteur

Le 19 octobre 2026, le flux TSLA de la fixture comporte 16 titres depuis 8 h : résultats de Meta/Musk à surveiller, spéculation de fusion Tesla–SpaceX et rebond des futures. La synthèse d'origine indique des résultats Tesla dans la semaine, aucun nouveau 8-K et une position intraday à fermer avant la clôture. À 10 h 52, la ligne de prix est `TSLA 366.48 +3.31% vs yesterday's close 354.72 at 10:52 ET MOVING`.

Ces données illustrent une exécution historique ; consulter les sources du jour pour une demande actuelle. Si un symbole n'a aucune actualité, le dire sans remplir le vide.

## Ce que le skill ne fait pas

- Ne jamais inventer ni embellir une information, citation ou valeur.
- Ne jamais acheter ou vendre en réaction automatique à une actualité.
- Une requête par flux et par symbole, avec pauses ; rester largement sous la limite SEC de 10 requêtes par seconde.
- Lecture et restitution uniquement. Toute proposition d'ordre passe par les autres skills et les validations explicites du courtier.

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
