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

**Notes personnelles** : bouton « Importer mes notes » (CSV `date,park,weekday,crowd_pct,note`),
gardées uniquement dans le navigateur. `.gitignore` bloque `*notes*.csv` et `data/history/` pour
qu'elles ne soient jamais committées.

Tant que `stats.json` contient peu de relevés, les attentes sont complétées par `base_wait`
(rides_meta.json) et un profil horaire type ; le poids des vraies données augmente avec la collecte.
