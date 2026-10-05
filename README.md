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

## Phase 2 — Site planificateur (à construire)

Voir `BRIEF_SITE.md`.
