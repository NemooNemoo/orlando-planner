"""
Horaires des parcs et spectacles depuis l'API gratuite ThemeParks.wiki (https://api.themeparks.wiki/v1).
Lancé après collect.py par GitHub Actions. Ne doit jamais bloquer la collecte : sort toujours avec le
code 0 et, en cas d'échec, laisse les fichiers précédents intacts.

Écrit :
  data/themeparks_ids.json  -> correspondance de nos 7 parcs avec les identifiants ThemeParks.wiki
  data/schedule.json        -> horaires par parc et par date (au plus 1 fois toutes les 20 h)
  data/shows.json           -> spectacles du jour avec leurs séances (à chaque lancement)

Heures toujours en heure d'Orlando (America/New_York).
Source : ThemeParks.wiki (https://themeparks.wiki)
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

API = os.environ.get("THEMEPARKS_API", "https://api.themeparks.wiki/v1")  # variable : tests uniquement
DATA = Path(__file__).resolve().parent.parent / "data"
IDS_FILE = DATA / "themeparks_ids.json"
SCHEDULE_FILE = DATA / "schedule.json"
SHOWS_FILE = DATA / "shows.json"
ORLANDO = ZoneInfo("America/New_York")
USER_AGENT = "orlando-planner (projet personnel, horaires + spectacles, ~8 requêtes / 15 min)"

DELAY_SECONDS = 1.0
TIMEOUT_SECONDS = 20
RETRIES = 2                   # réessais après le premier essai
TIME_BUDGET_SECONDS = 150     # au-delà, on s'arrête proprement (la collecte doit rester rapide)
MAX_CONSECUTIVE_FAILURES = 3  # API en panne : on abandonne vite plutôt que d'enchaîner les réessais
SCHEDULE_MAX_AGE_HOURS = 20
SCHEDULE_RETRY_MINUTES = 60   # après un échec partiel, on réessaie au plus 1 fois par heure
MONTHS_AHEAD = 8

# Destinations à parcourir et mots-clés (nom normalisé) de nos parcs
DESTINATIONS = ("walt disney world", "universal orlando")
PARK_KEYWORDS = {
    "magic_kingdom": "magic kingdom",
    "epcot": "epcot",
    "hollywood_studios": "hollywood studios",
    "animal_kingdom": "animal kingdom",
    "universal_studios_florida": "universal studios florida",
    "islands_of_adventure": "islands of adventure",
    "epic_universe": "epic universe",
}


class RateLimited(Exception):
    """HTTP 429 : on arrête et on réessaiera au prochain lancement."""


class OutOfTime(Exception):
    """Budget de temps dépassé, ou API manifestement en panne."""


START = time.monotonic()
_last_request = 0.0
_failures = 0


def log(*args):
    print(*args, flush=True)


def get(path):
    """GET JSON avec délai de 1 s entre requêtes, timeout, 2 réessais. Renvoie None si 404."""
    global _last_request, _failures
    if _failures >= MAX_CONSECUTIVE_FAILURES:
        raise OutOfTime(f"{_failures} requêtes de suite en échec, API indisponible")
    url = API.rstrip("/") + path
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    last_err = None
    for attempt in range(RETRIES + 1):
        if time.monotonic() - START > TIME_BUDGET_SECONDS:
            raise OutOfTime(f"budget de {TIME_BUDGET_SECONDS} s dépassé")
        wait = DELAY_SECONDS - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                data = json.load(resp)
            _failures = 0
            return data
        except urllib.error.HTTPError as err:
            if err.code == 429:
                raise RateLimited(f"HTTP 429 sur {path}")
            if err.code == 404:
                _failures = 0
                return None
            last_err = err
        except Exception as err:  # réseau, timeout, JSON invalide...
            last_err = err
        if attempt < RETRIES:
            time.sleep(2 * (attempt + 1))
    _failures += 1
    raise last_err


# ---------------------------------------------------------------- fichiers

def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, obj, compact=False):
    """Écriture atomique : un fichier à moitié écrit ne peut pas être committé."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    text = (json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True) if compact
            else json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True))
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def utc_stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def age_hours(stamp):
    try:
        t = datetime.strptime(stamp, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return float("inf")
    return (datetime.now(timezone.utc) - t).total_seconds() / 3600


def norm(s):
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def to_orlando(iso):
    """'2026-10-10T09:00:00-04:00' -> datetime à Orlando (None si illisible)."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ORLANDO)
    return dt.astimezone(ORLANDO)


# ---------------------------------------------------------------- 1. identifiants

def discover_ids():
    """Associe nos parcs aux entités ThemeParks.wiki (par leur nom), en réutilisant le fichier existant."""
    known = load_json(IDS_FILE, {}).get("parks", {})
    if all(slug in known and known[slug].get("id") for slug in PARK_KEYWORDS):
        return known

    payload = get("/destinations") or {}
    found = dict(known)
    for dest in payload.get("destinations", []):
        dname = norm(dest.get("name"))
        if not any(k in dname for k in DESTINATIONS):
            continue
        for park in dest.get("parks", []):
            pname = norm(park.get("name"))
            for slug, kw in PARK_KEYWORDS.items():
                if kw in pname and slug not in found:
                    found[slug] = {"id": park.get("id"), "name": park.get("name"), "destination": dest.get("name")}

    missing = [slug for slug in PARK_KEYWORDS if slug not in found]
    for slug in missing:
        log(f"  ATTENTION : parc « {slug} » introuvable dans /destinations (ThemeParks.wiki)")
    if found != known:
        write_json(IDS_FILE, {"generated": utc_stamp(), "source": "https://themeparks.wiki", "parks": found})
        log(f"  themeparks_ids.json : {len(found)}/{len(PARK_KEYWORDS)} parcs associés")
    return found


# ---------------------------------------------------------------- 2. horaires

def months_to_fetch(today):
    y, m = today.year, today.month
    for _ in range(MONTHS_AHEAD + 1):
        yield y, m
        m += 1
        if m > 12:
            y, m = y + 1, 1


def classify_extra(entry, opening):
    """EXTRA_HOURS : early entry (avant l'ouverture) ou soirée prolongée (après)."""
    desc = norm(entry.get("description"))
    if any(k in desc for k in ("early", "morning", "admission")):
        return "early"
    if any(k in desc for k in ("extended", "evening", "night", "late")):
        return "evening"
    start = to_orlando(entry.get("openingTime"))
    if opening and start and start < opening:
        return "early"
    return "evening"


def parse_schedule(entries):
    """Liste 'schedule' de l'API -> { date: {open, close, early, evening, events} } (heures d'Orlando)."""
    days = {}
    for e in entries or []:
        d = e.get("date")
        if not d or not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            continue
        day = days.setdefault(d, {"open": None, "close": None, "early": [], "evening": [], "events": []})
        start, end = to_orlando(e.get("openingTime")), to_orlando(e.get("closingTime"))
        typ = (e.get("type") or "").upper()
        if typ == "OPERATING" and start and end:
            # plusieurs créneaux possibles : on garde la plage la plus large
            if not day["open"] or start.strftime("%H:%M") < day["open"]:
                day["open"] = start.strftime("%H:%M")
            close = end.strftime("%H:%M")
            if end.date() > start.date():  # après minuit : 24:00 = minuit, 25:00 = 1 h du matin
                close = f"{24 * (end.date() - start.date()).days + end.hour:02d}:{end.minute:02d}"
            if not day["close"] or close > day["close"]:
                day["close"] = close
        elif typ == "CLOSED":
            day["closed"] = True
        day["_raw"] = day.get("_raw", []) + [e]

    for d, day in days.items():
        opening = None
        if day["open"]:
            opening = datetime.fromisoformat(f"{d}T{day['open']}:00").replace(tzinfo=ORLANDO)
        for e in day.pop("_raw"):
            typ = (e.get("type") or "").upper()
            start, end = to_orlando(e.get("openingTime")), to_orlando(e.get("closingTime"))
            if not start or not end or typ in ("OPERATING", "CLOSED", "INFO"):
                continue
            slot = {"start": start.strftime("%H:%M"), "end": end.strftime("%H:%M")}
            if e.get("description"):
                slot["name"] = e["description"]
            if typ == "EXTRA_HOURS":
                day[classify_extra(e, opening)].append(slot)
            elif typ in ("TICKETED_EVENT", "PRIVATE_EVENT"):
                day["events"].append(slot)
        for k in ("early", "evening", "events"):
            if not day[k]:
                del day[k]
    return days


def update_schedule(ids):
    current = load_json(SCHEDULE_FILE, {})
    if age_hours(current.get("generated")) < SCHEDULE_MAX_AGE_HOURS:
        log("  schedule.json récent, rien à faire")
        return
    if age_hours(current.get("attempted")) < SCHEDULE_RETRY_MINUTES / 60:
        log("  schedule.json : dernier essai il y a moins d'1 h, on attend")
        return

    parks = current.get("parks", {})
    today = datetime.now(ORLANDO).date()
    errors, fetched = [], 0
    try:
        for slug, info in ids.items():
            for y, m in months_to_fetch(today):
                try:
                    payload = get(f"/entity/{info['id']}/schedule/{y}/{m:02d}")
                except (RateLimited, OutOfTime):
                    raise
                except Exception as err:
                    errors.append(f"{slug} {y}-{m:02d}: {err}")
                    continue
                fetched += 1
                # dates connues conservées ; les dates renvoyées remplacent les anciennes
                parks.setdefault(slug, {}).update(parse_schedule((payload or {}).get("schedule")))
    except RateLimited as err:
        log(f"  ARRÊT : {err} — on réessaiera au prochain lancement")
        errors.append(str(err))
    except OutOfTime as err:
        log(f"  ARRÊT : {err}")
        errors.append(str(err))

    if not fetched:
        log("  schedule.json : aucune réponse, fichier précédent conservé")
        if current:
            write_json(SCHEDULE_FILE, {**current, "attempted": utc_stamp()}, compact=True)
        return
    out = {
        "generated": utc_stamp() if not errors else current.get("generated"),
        "attempted": utc_stamp(),
        "timezone": "America/New_York",
        "source": "https://themeparks.wiki",
        "parks": {slug: dict(sorted(days.items())) for slug, days in sorted(parks.items())},
    }
    write_json(SCHEDULE_FILE, out, compact=True)
    n = sum(1 for days in parks.values() for d in days.values() if d.get("open"))
    log(f"  schedule.json : {fetched} mois lus, {n} journées avec horaires" + (f", {len(errors)} erreur(s)" if errors else ""))
    for e in errors[:10]:
        log("    erreur", e)


# ---------------------------------------------------------------- 3. spectacles

def update_shows(ids):
    now = datetime.now(ORLANDO)
    today = now.date().isoformat()
    previous = load_json(SHOWS_FILE, {})
    same_day = str(previous.get("updated", ""))[:10] == today
    parks, ok = {}, 0
    for slug, info in ids.items():
        try:
            payload = get(f"/entity/{info['id']}/live")
        except RateLimited as err:
            log(f"  ARRÊT spectacles : {err}")
            break
        except OutOfTime as err:
            log(f"  ARRÊT spectacles : {err}")
            break
        except Exception as err:
            log(f"  spectacles {slug} : {err}")
            continue
        ok += 1
        shows = []
        for ent in (payload or {}).get("liveData", []):
            if (ent.get("entityType") or "").upper() != "SHOW":
                continue
            for st in ent.get("showtimes") or []:
                start, end = to_orlando(st.get("startTime")), to_orlando(st.get("endTime"))
                if not start or start.date().isoformat() != today:
                    continue
                shows.append({"id": ent.get("id"), "name": ent.get("name"),
                              "start": start.isoformat(timespec="minutes"),
                              "end": end.isoformat(timespec="minutes") if end else None})
        parks[slug] = sorted(shows, key=lambda s: (s["start"], s["name"] or ""))

    if not ok:
        log("  shows.json : aucune réponse, fichier précédent conservé")
        return
    # parcs en échec : on garde leurs spectacles précédents s'ils datent d'aujourd'hui
    for slug in ids:
        if slug not in parks:
            parks[slug] = previous.get("parks", {}).get(slug, []) if same_day else []
    write_json(SHOWS_FILE, {"updated": now.isoformat(timespec="minutes"), "timezone": "America/New_York",
                            "source": "https://themeparks.wiki", "parks": parks})
    log(f"  shows.json : {sum(len(v) for v in parks.values())} séances aujourd'hui ({ok}/{len(ids)} parcs)")


# ---------------------------------------------------------------- principal

def main():
    log(f"ThemeParks.wiki — {datetime.now(ORLANDO):%Y-%m-%d %H:%M} (Orlando)")
    try:
        ids = discover_ids()
    except Exception as err:  # y compris 429 : on réessaiera au prochain lancement
        log(f"  identifiants indisponibles ({err}) — fichiers précédents conservés")
        ids = load_json(IDS_FILE, {}).get("parks", {})
    ids = {slug: info for slug, info in ids.items() if slug in PARK_KEYWORDS and info.get("id")}
    if not ids:
        log("  aucun parc associé, rien à faire")
        return
    for step in (update_shows, update_schedule):
        try:
            step(ids)
        except Exception as err:
            log(f"  {step.__name__} : erreur inattendue ({err}) — fichiers précédents conservés")


if __name__ == "__main__":
    try:
        main()
    except BaseException as err:  # même un arrêt imprévu ne doit pas faire échouer la collecte
        print("ERREUR themeparks.py :", repr(err))
    sys.exit(0)
