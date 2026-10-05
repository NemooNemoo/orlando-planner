"""
Transforme l'historique brut (data/raw) en statistiques compactes pour le planificateur.
Recalculé au plus une fois toutes les 20 h (ou à chaque fois avec --force).

Écrit data/stats.json :
  rides[id].slots[jour_semaine][créneau_30min] = attente moyenne (minutes)
  parks[parc].by_weekday[jour_semaine]         = attente moyenne du parc
  parks[parc].by_date[AAAA-MM-JJ]              = attente moyenne du parc ce jour-là
Jour de semaine : 0 = lundi ... 6 = dimanche. Créneau : "09:00", "09:30", ...
"""
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
OUT = DATA / "stats.json"
MAX_AGE_HOURS = 20


def is_due():
    # On lit la date stockée DANS le fichier : sur GitHub, la date de modification
    # des fichiers est réinitialisée à chaque checkout et ne serait pas fiable.
    if "--force" in sys.argv or not OUT.exists():
        return True
    try:
        generated = json.loads(OUT.read_text(encoding="utf-8"))["generated"]
        age = datetime.now(timezone.utc) - datetime.strptime(generated, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    except (KeyError, ValueError, json.JSONDecodeError):
        return True
    return age.total_seconds() > MAX_AGE_HOURS * 3600


def main():
    if not is_due():
        print("stats.json récent, rien à faire")
        return

    ride_acc = defaultdict(lambda: [0, 0])      # (ride, wd, slot) -> [somme, nb]
    park_wd = defaultdict(lambda: [0, 0])       # (parc, wd)
    park_date = defaultdict(lambda: [0, 0])     # (parc, date)
    ride_park = {}

    for csv_path in sorted((DATA / "raw").glob("*/*.csv")):
        park = csv_path.parent.name
        with csv_path.open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                try:
                    t = datetime.strptime(row["time"], "%Y-%m-%d %H:%M")
                    wait = int(row["wait"])
                except (ValueError, KeyError):
                    continue
                if wait <= 0:  # 0 = souvent "ouvert mais pas de donnée"
                    continue
                rid, wd = row["ride_id"], t.weekday()
                slot = f"{t.hour:02d}:{0 if t.minute < 30 else 30:02d}"
                ride_park[rid] = park
                for acc, key in ((ride_acc, (rid, wd, slot)),
                                 (park_wd, (park, wd)),
                                 (park_date, (park, t.strftime("%Y-%m-%d")))):
                    acc[key][0] += wait
                    acc[key][1] += 1

    avg = lambda s_n: round(s_n[0] / s_n[1], 1)
    rides, parks = {}, {}
    for (rid, wd, slot), s_n in ride_acc.items():
        r = rides.setdefault(rid, {"park": ride_park[rid], "slots": {}})
        r["slots"].setdefault(str(wd), {})[slot] = avg(s_n)
    for (park, wd), s_n in park_wd.items():
        parks.setdefault(park, {"by_weekday": {}, "by_date": {}})["by_weekday"][str(wd)] = avg(s_n)
    for (park, d), s_n in park_date.items():
        parks.setdefault(park, {"by_weekday": {}, "by_date": {}})["by_date"][d] = avg(s_n)

    stats = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
             "rides": rides, "parks": parks}
    OUT.write_text(json.dumps(stats, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    print(f"stats.json : {len(rides)} attractions, {len(parks)} parcs")


if __name__ == "__main__":
    main()
