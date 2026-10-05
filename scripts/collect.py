"""
Collecte les temps d'attente des 7 parcs d'Orlando depuis Queue-Times.com.
Lancé automatiquement toutes les 15 min par GitHub Actions.

Écrit :
  data/latest.json                       -> état en direct (lu par le site)
  data/rides.json                        -> catalogue des attractions (id, nom, parc, zone)
  data/raw/<parc>/<AAAA-MM>.csv          -> historique : heure locale, ride_id, attente

Données : Powered by Queue-Times.com (https://queue-times.com)
"""
import csv
import json
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

PARKS = {
    334: "epic_universe",
    64: "islands_of_adventure",
    65: "universal_studios_florida",
    8: "animal_kingdom",
    7: "hollywood_studios",
    6: "magic_kingdom",
    5: "epcot",
}
ORLANDO = ZoneInfo("America/New_York")
DATA = Path(__file__).resolve().parent.parent / "data"
USER_AGENT = "orlando-planner (projet personnel, collecte 1x/15min)"


def fetch(park_id):
    url = f"https://queue-times.com/parks/{park_id}/queue_times.json"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.load(resp)
        except Exception as err:  # réseau, timeout, JSON invalide...
            last_err = err
            time.sleep(5 * (attempt + 1))
    raise last_err


def iter_rides(payload):
    """Les attractions sont soit regroupées par zone ('lands'), soit à plat ('rides')."""
    for land in payload.get("lands", []):
        for ride in land.get("rides", []):
            yield land.get("name", ""), ride
    for ride in payload.get("rides", []):
        yield "", ride


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def main():
    now = datetime.now(ORLANDO)
    stamp = now.strftime("%Y-%m-%d %H:%M")
    month = now.strftime("%Y-%m")

    catalog = load_json(DATA / "rides.json", {})
    latest = {"updated": now.isoformat(timespec="minutes"), "parks": {}}
    errors = []

    for park_id, slug in PARKS.items():
        try:
            payload = fetch(park_id)
        except Exception as err:
            errors.append(f"{slug}: {err}")
            continue

        rows, live = [], {}
        for land, ride in iter_rides(payload):
            rid = str(ride["id"])
            catalog[rid] = {"name": ride.get("name", ""), "park": slug, "land": land}
            is_open = bool(ride.get("is_open"))
            wait = ride.get("wait_time")
            live[rid] = {"open": is_open, "wait": wait, "at": ride.get("last_updated")}
            if is_open and isinstance(wait, int):
                rows.append((stamp, rid, wait))

        latest["parks"][slug] = live

        if rows:  # on n'enregistre que les attractions ouvertes
            out = DATA / "raw" / slug / f"{month}.csv"
            out.parent.mkdir(parents=True, exist_ok=True)
            new_file = not out.exists()
            with out.open("a", newline="", encoding="utf-8") as f:
                writer = csv.writer(f, lineterminator="\n")
                if new_file:
                    writer.writerow(["time", "ride_id", "wait"])
                writer.writerows(rows)

    DATA.mkdir(exist_ok=True)
    (DATA / "rides.json").write_text(
        json.dumps(catalog, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    (DATA / "latest.json").write_text(
        json.dumps(latest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"{stamp} — {len(latest['parks'])}/{len(PARKS)} parcs collectés")
    for e in errors:
        print("  ERREUR", e)
    if len(errors) == len(PARKS):
        raise SystemExit(1)  # tout a échoué : on signale l'échec dans GitHub


if __name__ == "__main__":
    main()
