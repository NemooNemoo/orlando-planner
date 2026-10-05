# Brief — Site planificateur (Phase 2)

> À donner à Claude Code dans VS Code, à la racine du projet :
> « Lis README.md et BRIEF_SITE.md, puis construis le site décrit. »

## Contexte
Le dossier `data/` est alimenté automatiquement (voir README). Construire un site **statique**
(HTML/CSS/JS, sans framework ni étape de build) dans `docs/`, publié via GitHub Pages.
Le site lit les données sur `https://raw.githubusercontent.com/<user>/<repo>/main/data/...`
(URL de base dans un fichier `docs/config.js`).

## Sources de données
- `data/stats.json` + `data/raw/` : notre collecte toutes les 15 min → **courbe horaire** de chaque attraction.
- `data/latest.json` : direct.
- **Notes personnelles d'affluence (jamais publiées)** : bouton « Importer mes notes / Import my notes »
  qui lit un CSV local (`date,park,weekday,crowd_pct,note`, park = même identifiant que `data/rides.json`)
  et le garde uniquement dans le navigateur (localStorage, avec try/catch). Il sert au calendrier
  « quel parc quel jour » : classement des jours *au sein d'un même parc* (ne pas comparer les % entre parcs),
  en ignorant les lignes dont la note vaut « pluie », « Memorial Day » ou « ouverture Epic Universe ».
  Sans notes importées, le site se base sur `stats.json` seul. Ces données ne doivent jamais être
  committées dans le dépôt (dépôt public, conditions d'utilisation de queue-times).

## Fonctionnalités
1. **Assistant de configuration** (étapes successives, mémorisé en localStorage) :
   - dates du séjour (début/fin) ;
   - parcs souhaités (7 parcs, groupés Disney / Universal) ;
   - Lightning Lane (Multi Pass / Single Pass) pour Disney, Express Pass pour Universal ;
   - mode « enfants en bas âge » : taille de l'enfant → masque les attractions interdites, met en avant les attractions famille ;
   - rythme : chill / normal / rapide (nombre d'attractions par jour, temps de marche, pauses) ;
   - pause déjeuner (oui/non + créneau) ;
   - parc imposé à une date donnée ;
   - attractions incontournables (sélection) ou mode « surprends-moi ».
2. **Calendrier du séjour** : un parc par jour, choisi avec `stats.json` (attente moyenne par jour de semaine) en respectant les contraintes. Afficher un indicateur d'affluence par jour.
3. **Timeline du jour** : ordre des attractions heure par heure, en visant pour chaque attraction le créneau où son attente moyenne est la plus basse ; prévoir marche, repas, pauses selon le rythme.
4. **Mode en direct** (le jour J) : lit `latest.json` et recalcule la suite de la journée ; propose « que faire maintenant ? ».

## Données à créer à la main
`docs/rides_meta.json` : pour chaque attraction importante, taille minimale, type (sensation / famille / spectacle / enfants), éligibilité Lightning Lane / Express, durée approximative. Les ids viennent de `data/rides.json`.

## Design
- Inspiration : queuequest.duckdns.org — mobile d'abord, tons chauds et doux (fond crème type `#ede7d9`), cartes arrondies, code couleur des attentes (vert < 20 min, jaune < 45, orange < 75, rouge au-delà).
- Installable sur téléphone (manifest + service worker, fonctionne hors connexion avec les dernières données).
- **Bilingue FR / EN** avec bouton de bascule ; textes dans `docs/i18n.json`.
- Affichage obligatoire : « Powered by Queue-Times.com » avec lien.
- Heures toujours affichées en heure d'Orlando.

## Voyage de référence pour tester
1–15 mai 2027, Disney World + Universal (dont Epic Universe).
