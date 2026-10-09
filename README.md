# Orlando Park Planner

Planificateur de séjour Walt Disney World + Universal Orlando basé sur les temps d'attente réels.

**Données : Powered by [Queue-Times.com](https://queue-times.com)**

## Phase 1 — Collecte (en place)

| Fichier | Rôle |
|---|---|
| `scripts/collect.py` | Récupère les temps d'attente des 7 parcs (toutes les 15 min via GitHub Actions) |
| `scripts/stats.py` | Calcule les moyennes par attraction / jour de semaine / créneau de 30 min (1x/jour) |
| `.github/workflows/collect.yml` | Automatisation GitHub Actions |
| `data/latest.json` | Temps d'attente en direct |
| `data/rides.json` | Catalogue des attractions |
| `data/stats.json` | Statistiques pour le planificateur |
| `data/raw/<parc>/<mois>.csv` | Historique brut (heure d'Orlando) |

Parcs suivis : Epic Universe (334), Islands of Adventure (64), Universal Studios Florida (65),
Animal Kingdom (8), Hollywood Studios (7), Magic Kingdom (6), Epcot (5).

Le dépôt doit être **public** : Actions et Pages sont alors gratuits et illimités.

## Phase 2 — Site planificateur (`docs/`)

Site statique (HTML/CSS/JS, sans framework ni build), cahier des charges dans `BRIEF_SITE.md`.

| Fichier | Rôle |
|---|---|
| `docs/index.html`, `docs/style.css` | Page unique, mobile d'abord |
| `docs/js/app.js` | Interface : assistant, calendrier, journée, direct |
| `docs/js/planner.js` | Calculs (sans DOM) : modèle d'attente, choix des parcs, programme du jour, « que faire maintenant ? » |
| `docs/config.js` | Adresse des données (`raw.githubusercontent.com/<user>/<repo>/main/data/`) |
| `docs/rides_meta.json` | Saisi à la main : taille mini, type, Lightning Lane / Express, durée, attente typique |
| `docs/i18n.json` | Textes FR / EN |
| `docs/sw.js`, `docs/manifest.webmanifest` | Installation sur téléphone + hors connexion (changer `VERSION` dans `sw.js` après une modif du site) |

**Mise en ligne** : Settings → Pages → *Deploy from a branch* → `main` / `/docs`.

**Tester en local** : `python -m http.server` à la racine du dépôt, puis http://localhost:8000/docs/
(en local, le site lit `../data/` ; sinon l'adresse de `config.js`).

**Fonctions de l'interface** :
- Réglages en 7 étapes : dates, parcs et nombre de visites par parc + jours de repos (compteurs − / +,
  visites + repos ≤ jours du séjour ; dates raccourcies : on retire d'abord les repos non imposés), coupe-files, rythme et déjeuner, parcs imposés, incontournables
  (filtres par catégorie), récapitulatif avec liens « Modifier » puis « Créer mon séjour ».
- Calendrier : les jours de repos non imposés vont sur les journées les plus chargées (si possible pas
  deux d'affilée, mention « choisi car journée chargée ») ; chaque parc reçoit ensuite son nombre de
  visites sur ses jours les plus calmes, si possible jamais deux jours de suite. Les jours restants sont
  des jours libres non attribués.
- Journée : le programme prévu uniquement. Direct : le temps réel uniquement (attractions ouvertes de la
  plus courte à la plus longue attente, filtres, bouton « Fait », actualisation toutes les 5 min).
- Thème Auto / Clair / Sombre (bouton en en-tête, choix mémorisé).
- Types d'attraction (`rides_meta.json`) : `thrill`, `family`, `show`, `meet` (rencontre de personnages).

**Charte graphique** : #393943 ardoise, #439B96 bleu-vert, #F2F2F3 gris clair, #FFF8E8 crème, #F37A69 corail.
Toutes les couleurs sont des variables CSS (`docs/style.css`). Couleur principale = corail (boutons, liens,
progression, onglet actif, compteurs, filtres actifs, focus) : #F37A69 (2,54:1 sur crème) ne suffit pas
pour du texte, d'où #B4472F en mode clair et #F89A8B en mode sombre. Le bleu-vert ne sert qu'au niveau
« attente courte ». Erreurs / « Retirer » : bordeaux #8B1E3F (clair) ou rose #F5A3C7 (sombre).
Les attentes ont 4 niveaux (< 20, < 45, < 75, ≥ 75 min) et le nombre de minutes est toujours écrit.
Contrastes vérifiés (WCAG AA : 4,5:1 texte, 3:1 éléments d'interface) :

<details><summary>Tableau des contrastes</summary>

| Mode | Élément | Couleurs | Rapport | Minimum |
|---|---|---|---|---|
| origine | corail #F37A69 en texte / crème (insuffisant) | `#F37A69` / `#FFF8E8` | 2.54:1 | 4.5:1 |
| origine | blanc sur #F37A69 (insuffisant) | `#FFFFFF` / `#F37A69` | 2.69:1 | 4.5:1 |
| clair | texte / fond crème | `#393943` / `#FFF8E8` | 10.78:1 | 4.5:1 |
| clair | texte / carte blanche | `#393943` / `#FFFFFF` | 11.41:1 | 4.5:1 |
| clair | texte / carte grise | `#393943` / `#F2F2F3` | 10.20:1 | 4.5:1 |
| clair | texte secondaire / fond | `#5D5D6B` / `#FFF8E8` | 6.12:1 | 4.5:1 |
| clair | texte secondaire / carte | `#5D5D6B` / `#FFFFFF` | 6.47:1 | 4.5:1 |
| clair | texte secondaire / carte grise | `#5D5D6B` / `#F2F2F3` | 5.79:1 | 4.5:1 |
| clair | corail principal (liens « Modifier », texte) / carte | `#B4472F` / `#FFFFFF` | 5.41:1 | 4.5:1 |
| clair | corail principal / fond | `#B4472F` / `#FFF8E8` | 5.11:1 | 4.5:1 |
| clair | corail principal / carte grise | `#B4472F` / `#F2F2F3` | 4.83:1 | 4.5:1 |
| clair | texte blanc / boutons, compteurs, filtres actifs, langue | `#FFFFFF` / `#B4472F` | 5.41:1 | 4.5:1 |
| clair | onglet actif, menu thème sélectionné, badges LL/Express | `#9A3424` / `#FDE1DC` | 5.87:1 | 4.5:1 |
| clair | texte / élément sélectionné | `#393943` / `#FFF1EE` | 10.36:1 | 4.5:1 |
| clair | erreurs, « Retirer » (bordeaux) / carte | `#8B1E3F` / `#FFFFFF` | 8.92:1 | 4.5:1 |
| clair | erreurs / fond | `#8B1E3F` / `#FFF8E8` | 8.43:1 | 4.5:1 |
| clair | erreurs / carte grise | `#8B1E3F` / `#F2F2F3` | 7.97:1 | 4.5:1 |
| clair | alertes (sable) | `#6A4F0C` / `#F8EBC4` | 6.46:1 | 4.5:1 |
| clair | badge Incontournable | `#FFFFFF` / `#393943` | 11.41:1 | 4.5:1 |
| clair | attente < 20 min (bleu-vert) | `#1E4F4C` / `#DCEFED` | 7.73:1 | 4.5:1 |
| clair | attente 20-44 min | `#6A4F0C` / `#F8EBC4` | 6.46:1 | 4.5:1 |
| clair | attente 45-74 min | `#9A3424` / `#FDE1DC` | 5.87:1 | 4.5:1 |
| clair | attente >= 75 min | `#7A1E2C` / `#F3D5DA` | 7.48:1 | 4.5:1 |
| clair | affluence Calme | `#393943` / `#FFFFFF` | 11.41:1 | 4.5:1 |
| clair | affluence Moyen | `#6A4F0C` / `#FFFFFF` | 7.67:1 | 4.5:1 |
| clair | affluence Chargé | `#B23F2E` / `#FFFFFF` | 5.76:1 | 4.5:1 |
| clair | badge A | `#FFFFFF` / `#B23F2E` | 5.76:1 | 4.5:1 |
| clair | badge B | `#FFFFFF` / `#7A5A0E` | 6.37:1 | 4.5:1 |
| clair | badge C | `#FFFFFF` / `#5D5D6B` | 6.47:1 | 4.5:1 |
| clair | UI anneau de focus, barre de progression | `#B4472F` / `#FFF8E8` | 5.11:1 | 3:1 |
| clair | UI bord de l'élément sélectionné | `#B4472F` / `#FFFFFF` | 5.41:1 | 3:1 |
| clair | UI bord des champs et boutons secondaires | `#8A8A97` / `#FFFFFF` | 3.41:1 | 3:1 |
| clair | UI barre courbe < 20 | `#439B96` / `#FFFFFF` | 3.30:1 | 3:1 |
| clair | UI barre courbe 20-44 | `#A87A10` / `#FFFFFF` | 3.85:1 | 3:1 |
| clair | UI barre courbe 45-74 | `#D2533F` / `#FFFFFF` | 4.16:1 | 3:1 |
| clair | UI barre courbe >= 75 | `#8E2A3A` / `#FFFFFF` | 8.26:1 | 3:1 |
| sombre | texte / fond | `#F2F2F3` / `#2A2A31` | 12.73:1 | 4.5:1 |
| sombre | texte / carte | `#F2F2F3` / `#393943` | 10.20:1 | 4.5:1 |
| sombre | texte / carte secondaire | `#F2F2F3` / `#44444F` | 8.59:1 | 4.5:1 |
| sombre | texte secondaire / fond | `#BDBDC8` / `#2A2A31` | 7.65:1 | 4.5:1 |
| sombre | texte secondaire / carte | `#BDBDC8` / `#393943` | 6.13:1 | 4.5:1 |
| sombre | texte secondaire / carte secondaire | `#BDBDC8` / `#44444F` | 5.16:1 | 4.5:1 |
| sombre | corail principal (liens, texte) / carte | `#F89A8B` / `#393943` | 5.43:1 | 4.5:1 |
| sombre | corail principal / fond | `#F89A8B` / `#2A2A31` | 6.78:1 | 4.5:1 |
| sombre | corail principal / carte secondaire | `#F89A8B` / `#44444F` | 4.57:1 | 4.5:1 |
| sombre | texte / boutons, compteurs, filtres actifs, langue | `#2A2A31` / `#F89A8B` | 6.78:1 | 4.5:1 |
| sombre | onglet actif, menu thème sélectionné, badges LL/Express | `#FFC0B5` / `#5C302B` | 7.04:1 | 4.5:1 |
| sombre | texte / élément sélectionné | `#F2F2F3` / `#4A3533` | 10.16:1 | 4.5:1 |
| sombre | erreurs, « Retirer » (rose) / carte | `#F5A3C7` / `#393943` | 5.95:1 | 4.5:1 |
| sombre | erreurs / fond | `#F5A3C7` / `#2A2A31` | 7.43:1 | 4.5:1 |
| sombre | erreurs / carte secondaire | `#F5A3C7` / `#44444F` | 5.01:1 | 4.5:1 |
| sombre | alertes (sable) | `#F3D98C` / `#4C3F18` | 7.44:1 | 4.5:1 |
| sombre | badge Incontournable | `#393943` / `#F2F2F3` | 10.20:1 | 4.5:1 |
| sombre | attente < 20 min (bleu-vert) | `#A8E3DE` / `#1F4A47` | 6.91:1 | 4.5:1 |
| sombre | attente 20-44 min | `#F3D98C` / `#4C3F18` | 7.44:1 | 4.5:1 |
| sombre | attente 45-74 min | `#FFC0B5` / `#5C302B` | 7.04:1 | 4.5:1 |
| sombre | attente >= 75 min | `#FFB3C1` / `#5A2230` | 7.31:1 | 4.5:1 |
| sombre | affluence Calme | `#F2F2F3` / `#393943` | 10.20:1 | 4.5:1 |
| sombre | affluence Moyen | `#E2B947` / `#393943` | 6.12:1 | 4.5:1 |
| sombre | affluence Chargé | `#F89A8B` / `#393943` | 5.43:1 | 4.5:1 |
| sombre | badge A | `#2A2A31` / `#F89A8B` | 6.78:1 | 4.5:1 |
| sombre | badge B | `#2A2A31` / `#E2B947` | 7.64:1 | 4.5:1 |
| sombre | badge C | `#2A2A31` / `#BDBDC8` | 7.65:1 | 4.5:1 |
| sombre | UI anneau de focus, barre de progression | `#F89A8B` / `#2A2A31` | 6.78:1 | 3:1 |
| sombre | UI bord de l'élément sélectionné | `#F89A8B` / `#393943` | 5.43:1 | 3:1 |
| sombre | UI bord des champs et boutons secondaires | `#8E8E9C` / `#393943` | 3.53:1 | 3:1 |
| sombre | UI barre courbe < 20 | `#7FCFC9` / `#393943` | 6.34:1 | 3:1 |
| sombre | UI barre courbe 20-44 | `#E2B947` / `#393943` | 6.12:1 | 3:1 |
| sombre | UI barre courbe 45-74 | `#F89A8B` / `#393943` | 5.43:1 | 3:1 |
| sombre | UI barre courbe >= 75 | `#F2708A` / `#393943` | 4.05:1 | 3:1 |

</details>

**Notes personnelles** : bouton « Importer mes notes / Import my notes » (sélection multiple possible).
Le type de chaque CSV est reconnu d'après sa ligne d'en-tête :

| Fichier | En-tête | Utilisation |
|---|---|---|
| `may_crowds.csv` | `date,park,weekday,crowd_pct,note` | Calendrier : classement des jours au sein de chaque parc (lignes « pluie », « Memorial Day », « ouverture Epic Universe » ignorées) |
| `ride_priorities.csv` | `park,ride,avg_wait,avg_max_wait,tier` | `avg_wait` / `avg_max_wait` remplacent `base_wait` tant qu'il y a peu de relevés ; `tier` A = ouverture ou coupe-file, B = tôt ou en soirée, C = n'importe quand (badge A/B/C). Noms associés à `rides.json` de façon tolérante (majuscules, accents, ™ ® ©, apostrophes, ponctuation) ; les noms non reconnus sont listés après l'import |
| `park_patterns.csv` | `park,kind,key,crowd_pct` (`kind` = `month` Jan..Dec ou `weekday` Mon..Sun) | Calendrier, quand `may_crowds` ne couvre pas ce parc ou ce mois : mois × jour de semaine, comparé uniquement au sein du même parc |

`park` = identifiants de `data/rides.json` (`magic_kingdom`, `epic_universe`…). Les fichiers sont gardés
uniquement dans le navigateur (localStorage) ; la liste des fichiers importés, avec un bouton de
suppression pour chacun, est affichée dans les Réglages. `.gitignore` bloque `*notes*.csv`,
`may_crowds*.csv`, `ride_priorities*.csv`, `park_patterns*.csv` et `data/history/` pour qu'ils ne
soient jamais committés.

Tant que `stats.json` contient peu de relevés, les attentes sont complétées par `base_wait`
(rides_meta.json) et un profil horaire type ; le poids des vraies données augmente avec la collecte.
