"""
Récupère l'historique quotidien de queue-times (pages "calendrier" publiques), parc par parc.
Source : Powered by Queue-Times.com (https://queue-times.com)

Pour chaque parc et chaque jour (du plus récent au plus ancien) :
  data/history/<parc>/<année>_days.csv   date, affluence %, étiquette, early entry, horaires,
                                         événement payant, température, pluie
  data/history/<parc>/<année>_rides.csv  date, ride_id, nom, attente moyenne, attente max, dispo %

Reprend automatiquement là où il s'était arrêté (les jours déjà présents sont ignorés).
Une fois tout l'historique récupéré, chaque lancement ne télécharge que les nouveaux jours.

Utilisation :
  python scripts/history.py --test                      # 1 journée d'essai, n'écrit rien
  python scripts/history.py --test --park 65 --date 2025-05-10
  python scripts/history.py --max-minutes 20            # collecte pendant 20 min maximum

Codes de sortie : 0 = tranche terminée (il reste des jours), 10 = tout est à jour,
                  2 = arrêt de sécurité (site qui bloque ou pages illisibles).
"""
import argparse
import csv
import json
import random
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

# Les émojis des horaires s'affichent mal dans la console Windows sans ça
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

# id queue-times -> (dossier, premier jour à récupérer)
PARKS = {
    334: ("epic_universe", date(2025, 5, 1)),   # ouvert le 22 mai 2025
    64: ("islands_of_adventure", date(2022, 1, 1)),
    65: ("universal_studios_florida", date(2022, 1, 1)),
    8: ("animal_kingdom", date(2022, 1, 1)),
    7: ("hollywood_studios", date(2022, 1, 1)),
    6: ("magic_kingdom", date(2022, 1, 1)),
    5: ("epcot", date(2022, 1, 1)),
}
HISTORY = Path(__file__).resolve().parent.parent / "data" / "history"
USER_AGENT = "orlando-planner (projet personnel, historique, 1 page / 2 s)"
DELAY_SECONDS = 2.0
DAY_COLS = ["date", "crowd_pct", "crowd_label", "early_entry", "hours", "event", "temp_c", "rain_mm_h"]
RIDE_COLS = ["date", "ride_id", "ride_name", "avg_wait", "max_wait", "uptime_pct"]


class Blocked(Exception):
    """Le site refuse les requêtes (trop de requêtes, maintenance...)."""


# ---------------------------------------------------------------- lecture d'une page

class PageParser(HTMLParser):
    """Extrait le texte, les liens et les tableaux d'une page."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.links, self.text = [], [], []
        self._table = self._row = self._cell = self._link = None
        self._skip = 0  # dans <script> ou <style>

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("script", "style"):
            self._skip += 1
        elif tag == "table":
            self._table = {"headers": [], "rows": []}
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {"tag": tag, "text": "", "href": None}
        elif tag == "a":
            self._link = {"href": attrs.get("href") or "", "text": ""}
            if self._cell is not None and self._cell["href"] is None:
                self._cell["href"] = self._link["href"]

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip = max(0, self._skip - 1)
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None and self._table is not None:
            if self._row and all(c["tag"] == "th" for c in self._row):
                self._table["headers"] = [clean(c["text"]) for c in self._row]
            elif self._row:
                self._table["rows"].append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None
        elif tag == "a" and self._link is not None:
            self.links.append((self._link["href"], clean(self._link["text"])))
            self._link = None

    def handle_data(self, data):
        if self._skip:
            return
        if self._cell is not None:
            self._cell["text"] += data
        if self._link is not None:
            self._link["text"] += data
        self.text.append(data)


def clean(s):
    return " ".join(s.split())


def to_number(s):
    m = re.search(r"-?\d+(?:\.\d+)?", s or "")
    return float(m.group()) if m else None


def parse_day(html):
    p = PageParser()
    p.feed(html)
    text = clean(" ".join(p.text))

    def find(pattern):
        m = re.search(pattern, text)
        return m.group(1) if m else ""

    day = {
        "crowd_pct": find(r"Crowd level\s+(\d+(?:\.\d+)?)\s*%"),
        "crowd_label": find(r"Crowd level\s+(Empty|Quiet|Busy|Packed)\b"),
        "temp_c": find(r"Forecast average\s+(-?\d+(?:\.\d+)?)\s*°C"),
        "rain_mm_h": find(r"Forecast average\s+(\d+(?:\.\d+)?)\s*mm/h"),
    }

    # Horaires : liens du type /parks/6/calendar/2026/10/03/2 -> "🕗 08:00-23:00"
    early, opening, event = [], [], []
    for href, label in p.links:
        if not re.search(r"/calendar/\d{4}/\d{2}/\d{2}/\d+/?$", href):
            continue
        m = re.search(r"(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})", label)
        if not m:
            continue
        slot = f"{m.group(1)}-{m.group(2)}"
        if "⏰" in label:
            early.append(slot)
        elif "🎟" in label:
            event.append(slot)
        else:
            opening.append(slot)
    day.update(early_entry=";".join(early), hours=";".join(opening), event=";".join(event))

    # Tableaux par attraction
    rides = {}
    for table in p.tables:
        header = " ".join(table["headers"]).lower()
        if "average queue time" in header:
            field = "avg_wait"
        elif "maximum queue time" in header:
            field = "max_wait"
        elif "uptime" in header:
            field = "uptime_pct"
        else:
            continue
        for row in table["rows"]:
            if len(row) < 2:
                continue
            m = re.search(r"/rides/(\d+)", row[0]["href"] or "")
            if not m:
                continue
            ride = rides.setdefault(m.group(1), {"ride_name": clean(row[0]["text"])})
            value = to_number(row[1]["text"])
            ride[field] = "" if value is None else (int(value) if value.is_integer() else value)
    return day, rides


# ---------------------------------------------------------------- réseau

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None  # pas de page pour ce jour
            if err.code in (403, 429, 503):
                raise Blocked(f"HTTP {err.code} sur {url}")
            last = err
        except Exception as err:
            last = err
        time.sleep(10 * (attempt + 1))
    raise last


def day_url(park_id, d):
    return f"https://queue-times.com/parks/{park_id}/calendar/{d:%Y/%m/%d}"


# ---------------------------------------------------------------- fichiers

def done_dates(slug):
    done = set()
    for f in (HISTORY / slug).glob("*_days.csv"):
        with f.open(encoding="utf-8") as fh:
            done.update(row["date"] for row in csv.DictReader(fh))
    return done


def append_rows(path, cols, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, lineterminator="\n")
        if new:
            w.writeheader()
        w.writerows(rows)


def save(slug, d, day, rides):
    iso = d.isoformat()
    append_rows(HISTORY / slug / f"{d.year}_rides.csv", RIDE_COLS,
                [{"date": iso, "ride_id": rid, **{k: r.get(k, "") for k in RIDE_COLS[2:]}}
                 for rid, r in sorted(rides.items(), key=lambda kv: int(kv[0]))])
    # le fichier "days" est écrit en dernier : c'est lui qui marque le jour comme fait
    append_rows(HISTORY / slug / f"{d.year}_days.csv", DAY_COLS, [{"date": iso, **day}])


def orlando_yesterday():
    try:
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo("America/New_York")).date()
    except Exception:  # Windows sans le paquet tzdata
        today = (datetime.now(timezone.utc) - timedelta(hours=4)).date()
    return today - timedelta(days=1)


# ---------------------------------------------------------------- modes

def run_test(park_id, d):
    url = day_url(park_id, d)
    print(f"Test : {url}\n")
    html = fetch(url)
    if html is None:
        print("Page introuvable (404).")
        return 1
    day, rides = parse_day(html)
    print("JOUR :", json.dumps(day, ensure_ascii=False))
    print(f"ATTRACTIONS : {len(rides)}")
    for rid, r in list(rides.items())[:8]:
        print(f"  {rid:>6}  {r.get('ride_name', '')[:40]:<40} moy={r.get('avg_wait', '')} "
              f"max={r.get('max_wait', '')} dispo={r.get('uptime_pct', '')}")
    ok = bool(day["crowd_pct"] or day["hours"]) and bool(rides)
    print("\nRÉSULTAT :", "OK, la page est bien lue." if ok
          else "PROBLÈME : données manquantes, envoie ce message à Claude.")
    return 0 if ok else 2


def run_collect(max_minutes):
    deadline = time.monotonic() + max_minutes * 60
    last_day = orlando_yesterday()

    todo = []
    for park_id, (slug, first_day) in PARKS.items():
        done = done_dates(slug)
        d = last_day
        while d >= first_day:
            if d.isoformat() not in done:
                todo.append((d, park_id, slug))
            d -= timedelta(days=1)
    todo.sort(key=lambda t: t[0], reverse=True)  # les jours récents d'abord, tous parcs mélangés

    if not todo:
        print("Historique à jour, rien à récupérer.")
        return 10
    print(f"{len(todo)} journées à récupérer (≈ {len(todo) * 2.5 / 3600:.1f} h au total)")

    fetched, empty_streak = 0, 0
    for d, park_id, slug in todo:
        if time.monotonic() > deadline:
            break
        try:
            html = fetch(day_url(park_id, d))
        except Blocked as err:
            print("ARRÊT :", err, "— on réessaiera au prochain lancement.")
            return 2
        except Exception as err:
            print(f"  erreur {slug} {d}: {err} (ignoré pour cette fois)")
            continue

        day, rides = parse_day(html) if html else ({k: "" for k in DAY_COLS[1:]}, {})
        save(slug, d, day, rides)
        fetched += 1

        # Sécurité : beaucoup de pages vides d'affilée = page illisible ou site qui a changé
        empty_streak = 0 if rides else empty_streak + 1
        if empty_streak >= 25:
            print("ARRÊT : 25 pages vides d'affilée, la lecture des pages doit être vérifiée.")
            return 2
        if fetched % 100 == 0:
            print(f"  {fetched} journées récupérées (dernière : {slug} {d})")
        time.sleep(DELAY_SECONDS + random.uniform(0, 0.5))

    remaining = len(todo) - fetched
    print(f"Tranche terminée : {fetched} journées, il en reste {remaining}.")
    return 0 if remaining else 10


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="lire une seule journée sans rien écrire")
    ap.add_argument("--park", type=int, default=6, help="id queue-times du parc (mode test)")
    ap.add_argument("--date", default="2026-10-03", help="AAAA-MM-JJ (mode test)")
    ap.add_argument("--max-minutes", type=float, default=20)
    args = ap.parse_args()

    if args.test:
        return run_test(args.park, date.fromisoformat(args.date))
    return run_collect(args.max_minutes)


if __name__ == "__main__":
    sys.exit(main())
