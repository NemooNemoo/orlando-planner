// Adresse des données collectées par GitHub Actions (dossier data/ de la branche main).
// Remplace <user>/<repo> si tu forkes le projet.
window.OP_CONFIG = {
  dataBase: "https://raw.githubusercontent.com/NemooNemoo/orlando-planner/main/data/",
  // En local (python -m http.server lancé à la racine du dépôt, puis /docs/), on lit ../data/ d'abord
  localDataBase: "../data/",
};
