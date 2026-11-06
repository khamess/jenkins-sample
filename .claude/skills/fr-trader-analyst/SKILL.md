---
name: fr-trader-analyst
description: >-
  Analyse les résultats publiés auprès de la SEC : données XBRL des 10-Q et
  10-K, dernier 8-K de résultats et communiqué associé. Compare chiffre
  d'affaires, marges, résultat net et BPA dilué au même trimestre de l'année
  précédente et sur douze mois glissants. Lit une transcription fournie sans
  en inventer. À utiliser pour « analyse les résultats de Tesla », « compare
  les marges », « que dit le 10-Q ? », « résume la conférence » ou pour vérifier
  le calendrier de résultats avant un trade. Restitue les faits en français.
argument-hint: "[tickers]"
---

# trader-analyst

## Langue et format de restitution

Répondre en français naturel, avec le tutoiement. Expliquer brièvement les termes techniques utiles ; garder les noms de commandes, chemins, clés JSON, symboles, statuts et paramètres tels quels. Les diagnostics bruts des scripts sont en anglais : en restituer le sens en français sans changer les nombres ni masquer une limite ou un refus. Les prix et budgets restent en USD ; ne pas les convertir en euros sans demande et taux sourcé. Les horaires techniques restent ceux de New York, indiqués explicitement. Si une heure locale est demandée, convertir pour la date concernée, sans décalage fixe avec Paris. Les exemples historiques de l'auteur ne sont pas des résultats personnels de Dan AI Lab ni des données actuelles.

Lire les chiffres effectivement déposés plutôt que reprendre uniquement le meilleur indicateur du communiqué. Pour un trade intraday : que disait le dernier rapport et le prochain événement intervient-il pendant la position prévue ? Ne pas transformer cette lecture en recommandation d'achat ou de vente.

Outil Python standard :

```bash
python3 "${CLAUDE_SKILL_DIR}/facts.py" --help
python3 "${CLAUDE_SKILL_DIR}/facts.py" TSLA
python3 "${CLAUDE_SKILL_DIR}/facts.py" TSLA NVDA AMD --metrics trader/metrics.json
```

`${CLAUDE_SKILL_DIR}` désigne ce dossier. La SEC demande un User-Agent : `sec_user_agent` dans `trader/config.json` ou `SEC_USER_AGENT`, sous la forme `Ton Nom toi@example.com`. L'utilisateur le renseigne lui-même ; il sera transmis à la SEC avec les requêtes. Sans User-Agent, le script refuse les appels.

## Données

- `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` : données XBRL déposées par l'entreprise.
- Liste des dépôts : dernier 10-Q ou 10-K et dernier 8-K avec item 2.02, Results of Operations.
- Dossier du 8-K : communiqué, généralement pièce EX-99.1.
- `--metrics trader/metrics.json` : une ligne par société avec chiffre d'affaires, résultat net et BPA dilué sur 12 mois, dernières marges et croissance. `metrics.example.json` conserve un relevé AAPL, AXP, GOOGL, KO, BAC du 13 octobre 2026.
- Le script ne télécharge pas les transcriptions de conférences. Lire celle fournie par l'utilisateur ou publiée sur la page investisseurs : prévisions de direction, marges, demande et réponses éludées, sans inventer de citation.
- La prochaine date de résultats n'est pas fournie par l'API SEC. Vérifier les titres de `/trader-news` ou la page investisseurs et citer cette source.

`--quarters 8` affiche deux années ; `--json` donne les données structurées ; `--cik` permet de cibler une société sans symbole.

## Règles

1. Construire le tableau depuis les faits XBRL déposés. Utiliser le communiqué pour le contexte, en identifiant clairement l'origine des nombres.
2. Comparer au même trimestre de l'année précédente. Les variations d'un trimestre à l'autre peuvent refléter la saisonnalité ; ne pas les présenter comme une croissance annuelle.
3. Identifier les données calculées : le Q4 est le 10-K annuel moins les trois trimestres précédents, pas un 10-Q Q4. Marquer « calculé » ; le BPA dérivé reste approximatif.
4. Si l'API de faits est en retard sur le dernier 10-Q, reprendre la note et ouvrir le 10-Q lui-même avant la synthèse.
5. Signaler les éléments exceptionnels. Un résultat net supérieur au résultat opérationnel peut inclure des éléments hors exploitation ; ne pas inventer lesquels. Banques et assureurs : marge brute absente, pas zéro.

## Déroulement

1. Exécuter l'outil sur les sociétés demandées ou celles de la watchlist.
2. Ouvrir et lire le dernier communiqué et le 10-Q lorsque le contexte est nécessaire.
3. Synthèse courte : chiffre d'affaires/BPA/croissance, marges, particularités (élément exceptionnel, trimestre calculé, retard des données), puis liens. Aucun adjectif que les chiffres ne soutiennent.
4. Si une publication intervient pendant le trade prévu, le signaler avant que `/trader-exit` fixe le stop. Un gap peut ouvrir au-delà de ce stop, notamment pour une position conservée la nuit.

## Exemples historiques de l'auteur

Ces nombres viennent de la documentation et des fixtures d'origine ; ils ne remplacent pas une lecture actuelle.

- TSLA, outil exécuté le 20 octobre 2026 : trimestre clos au 30 juin, chiffre d'affaires 28,24 milliards USD (+25,5 % sur un an), résultat net 1,11 milliard (−4,9 %), BPA dilué 0,32 USD (−3,0 %), marge brute 16,8 % (−4,3 points face au trimestre précédent), marge opérationnelle 1,4 %. Douze mois : chiffre d'affaires 103,6 milliards, BPA 1,08. Le résultat net dépasse l'opérationnel ; dernier 10-Q daté du 23 juillet 2026. Les titres de l'exemple annoncent des résultats dans la semaine.
- AAPL, relevé du 13 octobre 2026 : chiffre d'affaires 109,42 milliards USD (+16,4 %), BPA dilué 2,02 USD (+28,7 %).
- Coca-Cola : dans l'exemple, les faits SEC s'arrêtaient au 3 avril alors qu'un 10-Q au 3 juillet était déjà déposé ; lire directement le dépôt plus récent.

## Limites

Ne jamais qualifier un titre de bon marché, cher, à acheter ou à vendre ici. Ne pas inventer de chiffre absent des dépôts ni de trimestre impossible à dériver. Ne pas appeler la SEC sans User-Agent et rester largement sous 10 requêtes par seconde. Ce skill lit uniquement les publications ; il ne place aucun ordre.

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
