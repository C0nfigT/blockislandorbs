#!/usr/bin/env python3
"""Turn the public found-float registry into map points.

The tourism site stores a written location ("Rodman's Hollow") but pins nearly
every record on the visitor center. This script matches those descriptions to
named places on Block Island and spreads each find a little so a heatmap can
show density instead of one stacked dot.

Coordinates are NAD83/WGS84 from the USGS GNIS gazetteer where a feature
exists, and field-guide estimates (marked est.) where orbivores use a name
GNIS does not.
"""

import hashlib
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw_finds.json"
OUT = ROOT / "data" / "finds.json"
ISLAND = ROOT / "data" / "island.json"
TRAILS = ROOT / "data" / "trails.geojson"

# Finds at these places are hidden on footpaths, so they are spread along the
# path geometry instead of in a circle that spills into the ocean.
TRAIL_PLACES = {
    "rodmans-hollow", "enchanted-forest", "the-maze", "clay-head",
    "fresh-pond", "fresh-swamp", "hodge", "turnip-farm", "nathan-mott",
    "loffredo", "win-dodge", "lewis-dickens", "black-rock", "meadow-hill",
    "beacon-hill", "harrison", "old-mill", "payne-greenway", "middle-pond",
    "long-lot", "solviken", "martin-lots", "hyland", "murphy-cormier",
    "adrian-mitchell", "gaffney", "jones-trail", "magellan", "greenway",
    "marsh-hawk", "painted-rock", "mohegan-bluffs",
    "beach-ave", "north-light", "payne-overlook", "atwood", "overlook",
}

# id, name, lat, lng, spread meters, aliases
# Longer aliases win. Matching is on word boundaries after normalization.
PLACES = [
    ("rodmans-hollow", "Rodman's Hollow", 41.1525, -71.5845, 480,
     ["rodmans hollow", "rodman hollow", "rodmans", "rodman", "roadmans hollow", "roadman hollow", "rothmans hollow", "rothman", "rodmsn"]),
    ("enchanted-forest", "Enchanted Forest", 41.1732, -71.5738, 320,
     ["enchanted forest", "enchanted forrest", "enchanted", "haunted forest", "hanted forest"]),
    ("the-maze", "Clay Head Maze", 41.2075, -71.5645, 420,
     ["clay head maze", "clayhead maze", "the maze", "middle earth", "maze"]),
    ("clay-head", "Clay Head", 41.2105, -71.5580, 450,
     ["clay head trail", "clayhead trail", "clay head nature", "clayhead nature", "clay head", "clayhead", "clayhead beach", "clay head beach"]),
    ("fresh-pond", "Fresh Pond", 41.1606, -71.5787, 340,
     ["fresh pond"]),
    ("fresh-swamp", "Fresh Swamp", 41.1621, -71.5728, 280,
     ["fresh swamp"]),
    ("mansion-beach", "Mansion Beach", 41.2015, -71.5598, 260,
     ["mansion beach", "mansion"]),
    ("scotch-beach", "Scotch Beach", 41.1932, -71.5639, 240,
     ["scotch beach", "scotts beach", "scott s beach", "scotch"]),
    ("crescent-beach", "Crescent Beach", 41.1875, -71.5615, 280,
     ["crescent beach", "cresent beach", "crescent"]),
    ("town-beach", "Fred Benson Town Beach", 41.1815, -71.5605, 220,
     ["fred benson", "benson beach", "town beach", "state beach", "block island state beach"]),
    ("mohegan-bluffs", "Mohegan Bluffs", 41.1518, -71.5555, 320,
     ["mohegan bluffs", "mohegan bluff", "mohigan bluff", "moheggan", "mohegan", "mohigan", "the bluffs", "bluffs", "bluff"]),
    ("second-bluff", "Second Bluff", 41.1582, -71.5528, 180,
     ["second bluff", "2nd bluff", "second bluffs"]),
    ("first-bluff", "First Bluff", 41.1648, -71.5512, 160,
     ["first bluff", "1st bluff"]),
    ("southeast-light", "Southeast Lighthouse", 41.1526, -71.5520, 160,
     ["southeast lighthouse", "southeast light", "south east light", "se light", "se lighthouse"]),
    ("north-light", "North Light", 41.2273, -71.5762, 220,
     ["north lighthouse", "north light", "northern lighthouse", "northern light", "northlight", "block island north"]),
    ("sandy-point", "Sandy Point", 41.2305, -71.5765, 250,
     ["sandy point", "settlers rock", "settler s rock", "settlers", "settler"]),
    ("sachem-pond", "Sachem Pond", 41.2200, -71.5705, 300,
     ["sachem pond", "sachem", "little sachem"]),
    ("hodge", "Hodge Family Preserve", 41.2145, -71.5730, 380,
     ["hodge family", "hodge preserve", "hodge wildlife", "hodges", "hodge"]),
    ("turnip-farm", "Turnip Farm", 41.1662, -71.5748, 260,
     ["turnip farm", "turnip trail", "turnip"]),
    ("nathan-mott", "Nathan Mott Park", 41.1725, -71.5742, 340,
     ["nathan mott", "nathaniel mott", "nathen mott", "nathans mott", "nathan motts", "motts park", "mott park", "mott trail", "mott nature", "nathan s mott"]),
    ("loffredo", "Loffredo Loop", 41.1718, -71.5732, 220,
     ["loffredo", "lofredo", "leffredo", "lofreddo", "lored o", "loredo"]),
    ("win-dodge", "Win Dodge Preserve", 41.1578, -71.5930, 300,
     ["winfield dodge", "winn dodge", "win dodge", "windodge", "dodge preserve", "dodge farm", "dodge"]),
    ("lewis-dickens", "Lewis-Dickens Preserve", 41.1540, -71.6020, 320,
     ["lewis dickens", "elizabeth dickens", "dickens farm", "dickens trail", "dickens", "dickenson"]),
    ("west-beach", "West Beach", 41.1760, -71.6065, 650,
     ["west side beach", "west side rd", "west side road", "westside", "west beach", "west side"]),
    ("andys-way", "Andy's Way", 41.1695, -71.6040, 220,
     ["andys way", "andy s way", "andys"]),
    ("dinghy-beach", "Dinghy Beach", 41.1802, -71.5718, 200,
     ["dinghy beach", "dingy beach", "dinghey beach", "dinghy", "dingy"]),
    ("dories-cove", "Dories Cove", 41.1737, -71.6078, 220,
     ["dories cove", "dorrys cove", "dorys cove", "dories", "dorrys", "dorys", "dorries", "dorry"]),
    ("graces-cove", "Grace's Cove", 41.1840, -71.6005, 240,
     ["graces cove", "grace s cove", "gracie's cove", "gracie s cove", "grace cove", "graces", "gracie"]),
    ("black-rock", "Black Rock", 41.1470, -71.5953, 260,
     ["black rock", "blackrock"]),
    ("cooneymus", "Cooneymus", 41.1535, -71.5960, 400,
     ["cooneymus", "cooneymous", "conneymus", "cooneymus beach"]),
    ("southwest-point", "Southwest Point", 41.1560, -71.6100, 250,
     ["southwest point", "sw point", "south west point"]),
    ("transfer-station", "Transfer Station Beach", 41.1845, -71.6045, 220,
     ["transfer station", "dump beach", "the dump", "dump"]),
    ("beach-ave", "Beach Avenue", 41.1840, -71.5640, 240,
     ["beach avenue", "beach ave"]),
    ("meadow-hill", "Meadow Hill", 41.1715, -71.5765, 300,
     ["meadow hill", "meadow hills"]),
    ("beacon-hill", "Beacon Hill", 41.1757, -71.5910, 250,
     ["beacon hill", "beacon hollow"]),
    ("harrison", "Harrison Trail", 41.1738, -71.5785, 280,
     ["harrison trail", "harrison loop", "harrison"]),
    ("old-mill", "Old Mill Road", 41.1690, -71.5760, 280,
     ["old mill"]),
    ("pilot-hill", "Pilot Hill", 41.1576, -71.5628, 200,
     ["pilot hill"]),
    ("payne-greenway", "Payne Road Greenway", 41.1608, -71.5660, 300,
     ["payne road", "payne rd", "paynes road", "payne s road", "paynes rd", "payne"]),
    ("payne-overlook", "Payne Overlook", 41.1568, -71.5528, 160,
     ["payne overlook", "paynes overlook", "edward s payne", "edward payne"]),
    ("atwood", "Atwood Overlook", 41.1508, -71.5665, 180,
     ["atwood overlook", "attwood overlook", "atwood", "attwood"]),
    ("ocean-view", "Ocean View", 41.1672, -71.5548, 200,
     ["ocean view", "ocean pavilion", "oceanic pavilion"]),
    ("labyrinth", "Sacred Labyrinth", 41.1898, -71.5642, 80,
     ["sacred labyrinth", "labyrinth", "labrynth", "labrinyth"]),
    ("legion-park", "Legion Park", 41.1708, -71.5608, 80,
     ["legion park", "legion", "the cannon", "cannon", "veterans memorial", "vfw"]),
    ("rebecca", "Statue of Rebecca", 41.1730, -71.5576, 50,
     ["statue of rebecca", "rebecca"]),
    ("estas", "Esta's Park", 41.1726, -71.5582, 60,
     ["estas park", "esta s park", "estas"]),
    ("negus", "Negus Park", 41.1716, -71.5602, 70,
     ["negus"]),
    ("ball-obrien", "Ball O'Brien Park", 41.1738, -71.5628, 80,
     ["ball o brien", "ball obrien", "o brien park", "obrien park", "nicholas ball", "nichols park", "power company"]),
    ("harbor-pond", "Harbor Pond", 41.1770, -71.5662, 160,
     ["harbor pond"]),
    ("old-harbor", "Old Harbor", 41.1738, -71.5572, 180,
     ["old harbor", "water street", "water st", "downtown"]),
    ("new-harbor", "New Harbor", 41.1835, -71.5760, 250,
     ["new harbor", "great salt pond", "great salt"]),
    ("coast-guard", "Coast Guard Beach", 41.1768, -71.5595, 180,
     ["coast guard", "coastguard"]),
    ("beane-point", "Beane Point", 41.1885, -71.5940, 200,
     ["beane point", "beanes point", "beans point", "beane", "bean point"]),
    ("vaill-beach", "Vaill Beach", 41.1487, -71.5723, 180,
     ["vaill beach", "vail beach", "vaill"]),
    ("pebbly-beach", "Pebbly Beach", 41.1668, -71.5509, 150,
     ["pebbly beach", "pebbly"]),
    ("ballards", "Ballard's Beach", 41.1737, -71.5576, 120,
     ["ballards", "ballard s"]),
    ("corn-neck", "Corn Neck", 41.2020, -71.5625, 400,
     ["corn neck", "corner neck", "cornneck"]),
    ("lakeside", "Lakeside Drive", 41.1635, -71.5685, 200,
     ["lakeside"]),
    ("middle-pond", "Middle Pond", 41.2158, -71.5747, 200,
     ["middle pond"]),
    ("long-lot", "Long Lot", 41.2118, -71.5665, 250,
     ["long lot", "long lots", "longwood"]),
    ("solviken", "Solviken Preserve", 41.2095, -71.5780, 220,
     ["solviken", "solveiken"]),
    ("island-cemetery", "Island Cemetery", 41.1700, -71.5680, 120,
     ["island cemetery", "the cemetery", "cemetery"]),
    ("indian-cemetery", "Indian Cemetery", 41.1688, -71.5705, 80,
     ["indian cemetery", "indian cemetary"]),
    ("dodge-cemetery", "Dodge Cemetery", 41.1663, -71.5964, 80,
     ["dodge cemetery", "dodge cemetary"]),
    ("pet-cemetery", "Pet Cemetery", 41.1692, -71.5715, 60,
     ["pet cemetery", "dog cemetery", "old pet cemetery"]),
    ("john-es", "John E's Pond", 41.1558, -71.5597, 140,
     ["john e s", "john es", "tughole", "tug hole"]),
    ("harbor-church", "Harbor Church", 41.1716, -71.5570, 40,
     ["harbor church"]),
    ("historical-society", "Historical Society", 41.1723, -71.5623, 40,
     ["historical society"]),
    ("national-hotel", "The National Hotel", 41.1734, -71.5574, 40,
     ["national hotel", "the national"]),
    ("spring-house", "Spring House", 41.1686, -71.5552, 80,
     ["spring house", "spring street", "spring st"]),
    ("lobster-tree", "Lobster Pot Tree", 41.1736, -71.5570, 40,
     ["lobster pot", "lobster trap", "christmas tree"]),
    ("airport", "State Airport", 41.1689, -71.5795, 200,
     ["airport"]),
    ("rat-island", "Rat Island", 41.1795, -71.5717, 80,
     ["rat island"]),
    ("baby-beach", "Baby Beach", 41.1782, -71.5688, 100,
     ["baby beach"]),
    ("trims-pond", "Trim's Pond", 41.1798, -71.5717, 100,
     ["trims pond", "trim s pond"]),
    ("settlers-area", "Cow Cove", 41.2268, -71.5720, 150,
     ["cow cove"]),
    ("logwood", "Logwood Cove", 41.2212, -71.5773, 150,
     ["logwood"]),
    ("charleston", "Charleston Beach", 41.1951, -71.5931, 160,
     ["charlestown beach", "charleston beach", "charlestown", "charleston"]),
    ("stevens-cove", "Stevens Cove", 41.1676, -71.6114, 140,
     ["stevens cove"]),
    ("martin-lots", "Martin Lots", 41.1995, -71.5675, 280,
     ["martin lots", "martins lot", "martin lot", "martins trail", "martin trail", "martin"]),
    ("hyland", "Hyland Trail", 41.1765, -71.5820, 250,
     ["hyland"]),
    ("murphy-cormier", "Murphy-Cormier Trail", 41.1688, -71.5810, 220,
     ["murphy cormier", "murphy comier", "cormier"]),
    ("adrian-mitchell", "Adrian Mitchell Trail", 41.1708, -71.5768, 220,
     ["adrian mitchell", "mitchell trail"]),
    ("gaffney", "Gaffney Trail", 41.1675, -71.5775, 200,
     ["gaffney"]),
    ("jones-trail", "Jones Trail", 41.1510, -71.5825, 200,
     ["jones trail"]),
    ("magellan", "Magellan's Tree Trail", 41.1585, -71.5880, 180,
     ["magellan"]),
    ("overlook", "South Shore Overlook", 41.1525, -71.5580, 280,
     ["the overlook", "overlook"]),
    ("greenway", "Greenway, place not specified", 41.1650, -71.5780, 700,
     ["greenway", "green way"]),
    ("mosquito-beach", "Mosquito Beach", 41.1772, -71.5630, 120,
     ["mosquito beach", "mosquito"]),
    ("marsh-hawk", "Marsh Hawk Hollow", 41.1618, -71.5815, 200,
     ["marsh hawk"]),
    ("painted-rock", "Painted Rock", 41.2080, -71.5605, 80,
     ["painted rock"]),
    ("bi-school", "Block Island School", 41.1648, -71.5612, 60,
     ["block island school", "the school"]),
    ("ocean-ave", "Ocean Avenue", 41.1695, -71.5555, 220,
     ["ocean avenue", "ocean ave", "oceanview", "ocean view pavilion"]),
    ("town-general", "Old Harbor Village", 41.1728, -71.5588, 220,
     ["in town", "around town"]),
]

# Aliases that should lose to a more specific place even if this one is longer
# are ordered only by length. Keep specific phrases longer than generic ones.

OFF_ISLAND = re.compile(
    r"\b(mystic|cuttyhunk|wakefield|mainland|providence|boston|newport ri|on the ferry|bathroom on ferry|under my bed)\b"
)


def norm(text: str) -> str:
    text = (text or "").lower().replace("’", "'").replace("`", "'").replace("'", "")
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def build_alias_index():
    indexed = []
    for pid, _name, _lat, _lng, _rad, aliases in PLACES:
        for alias in aliases:
            a = norm(alias)
            if a:
                indexed.append((a, pid))
    indexed.sort(key=lambda item: len(item[0]), reverse=True)
    compiled = [(re.compile(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])"), pid, a) for a, pid in indexed]
    return compiled


ALIAS_INDEX = build_alias_index()
PLACE_BY_ID = {p[0]: p for p in PLACES}


def match_place(location: str):
    text = norm(location)
    if not text or OFF_ISLAND.search(text):
        return None
    # "connecticut ave" is on-island; bare connecticut is not
    if re.search(r"\bconnecticut\b", text) and "connecticut ave" not in text and "connecticut avenue" not in text:
        return None
    best = None
    best_len = -1
    for cre, pid, alias in ALIAS_INDEX:
        if len(alias) <= best_len:
            # index is length-sorted, so the first hit is the longest
            break
        if cre.search(text):
            best = pid
            best_len = len(alias)
            break
    return best


def load_island():
    polygon = json.loads(ISLAND.read_text())
    ring = polygon["coordinates"][0]
    # A point inland of the Great Salt Pond. The ring average falls in the water.
    return ring, (41.1705, -71.5785)


ISLAND_RING, ISLAND_CENTER = load_island()


def on_land(lat, lng, ring=ISLAND_RING):
    """Ray cast against the island shoreline. Ring points are [lng, lat]."""
    inside = False
    previous = ring[-1]
    for point in ring:
        lng1, lat1 = previous
        lng2, lat2 = point
        if (lat1 > lat) != (lat2 > lat):
            cross = (lng2 - lng1) * (lat - lat1) / (lat2 - lat1) + lng1
            if lng < cross:
                inside = not inside
        previous = point
    return inside


def move_toward(lat, lng, target_lat, target_lng, meters):
    north = (target_lat - lat) * 111_320
    east = (target_lng - lng) * 111_320 * math.cos(math.radians(lat))
    distance = math.hypot(north, east)
    if distance < 1:
        return lat, lng
    scale = min(meters, distance) / distance
    return lat + (target_lat - lat) * scale, lng + (target_lng - lng) * scale


def clear_of_water(lat, lng, margin_m=55):
    """True when the point and a small ring around it are all on land.

    The dot icon is a few pixels wide, so a find sitting on the shoreline
    still paints into the ocean. The margin keeps the marker on the beach.
    """
    if not on_land(lat, lng):
        return False
    for step in range(8):
        theta = step * math.pi / 4
        lat2 = lat + (margin_m * math.cos(theta)) / 111_320
        lng2 = lng + (margin_m * math.sin(theta)) / (111_320 * math.cos(math.radians(lat)))
        if not on_land(lat2, lng2):
            return False
    return True


def pull_ashore(lat, lng):
    if clear_of_water(lat, lng):
        return lat, lng
    target_lat, target_lng = ISLAND_CENTER
    if not on_land(lat, lng):
        low, high = 0.0, 1.0
        for _ in range(22):
            mid = (low + high) / 2
            mid_lat = lat + (target_lat - lat) * mid
            mid_lng = lng + (target_lng - lng) * mid
            if on_land(mid_lat, mid_lng):
                high = mid
            else:
                low = mid
        lat = lat + (target_lat - lat) * high
        lng = lng + (target_lng - lng) * high
    for _ in range(12):
        if clear_of_water(lat, lng):
            break
        nxt_lat, nxt_lng = move_toward(lat, lng, target_lat, target_lng, 14)
        if not on_land(nxt_lat, nxt_lng):
            break
        lat, lng = nxt_lat, nxt_lng
    if not on_land(lat, lng):
        return target_lat, target_lng
    return lat, lng


def meters_between(a, b):
    north = (b[0] - a[0]) * 111_320
    east = (b[1] - a[1]) * 111_320 * math.cos(math.radians(a[0]))
    return math.hypot(north, east)


def load_trail_lines():
    geo = json.loads(TRAILS.read_text())
    lines = []
    for feature in geo["features"]:
        coords = [(point[1], point[0]) for point in feature["geometry"]["coordinates"]]
        if len(coords) >= 2:
            lines.append(coords)
    return lines


TRAIL_LINES = load_trail_lines()


def ways_near(lat, lng, radius_m):
    anchor = (lat, lng)
    kept = []
    for line in TRAIL_LINES:
        if any(meters_between(anchor, point) <= radius_m for point in line):
            kept.append(line)
            continue
        # Catch a long segment that passes the anchor between vertices.
        close = False
        for start, end in zip(line, line[1:]):
            if meters_between(anchor, start) > radius_m * 3 and meters_between(anchor, end) > radius_m * 3:
                continue
            if meters_between(anchor, start) <= radius_m or meters_between(anchor, end) <= radius_m:
                close = True
                break
        if close:
            kept.append(line)
    return kept


def index_lines(lines):
    pieces = []
    total = 0.0
    for coords in lines:
        parts = [0.0]
        for start, end in zip(coords, coords[1:]):
            parts.append(parts[-1] + meters_between(start, end))
        length = parts[-1]
        if length < 12:
            continue
        total += length
        pieces.append((total, coords, parts, length))
    return total, pieces


def point_along(net, distance):
    total, pieces = net
    distance = distance % total if total else 0
    for end, coords, parts, length in pieces:
        if distance > end and end != total:
            continue
        local = distance - (end - length)
        for index in range(1, len(parts)):
            if parts[index] + 1e-6 < local:
                continue
            span = parts[index] - parts[index - 1] or 1
            blend = (local - parts[index - 1]) / span
            lat = coords[index - 1][0] + (coords[index][0] - coords[index - 1][0]) * blend
            lng = coords[index - 1][1] + (coords[index][1] - coords[index - 1][1]) * blend
            return lat, lng, coords[index][0] - coords[index - 1][0], coords[index][1] - coords[index - 1][1]
    coords = pieces[-1][1]
    return coords[-1][0], coords[-1][1], 0.0, 0.0


def snap_to_trail(net, key):
    digest = hashlib.sha256(("trail:" + key).encode()).digest()
    u1 = int.from_bytes(digest[:4], "big") / 2**32
    u2 = int.from_bytes(digest[4:8], "big") / 2**32
    lat, lng, dlat, dlng = point_along(net, u1 * net[0])
    north = dlat * 111_320
    east = dlng * 111_320 * math.cos(math.radians(lat))
    span = math.hypot(north, east) or 1.0
    # Floats are hidden within a few feet of the tread, not out in the brush.
    offset = (u2 * 2 - 1) * 6
    lat2 = lat + (-east / span) * offset / 111_320
    lng2 = lng + (north / span) * offset / (111_320 * math.cos(math.radians(lat)))
    if on_land(lat2, lng2):
        return lat2, lng2
    return lat, lng


def jitter(key: str, lat: float, lng: float, radius_m: float):
    digest = hashlib.sha256(key.encode()).digest()
    u1 = int.from_bytes(digest[:4], "big") / 2**32
    u2 = int.from_bytes(digest[4:8], "big") / 2**32
    u1 = min(max(u1, 1e-6), 1 - 1e-6)
    # Rayleigh-ish spread, clamped so points stay near the named place.
    dist = radius_m * math.sqrt(-2.0 * math.log(u1)) * 0.42
    dist = min(dist, radius_m)
    theta = u2 * 2 * math.pi
    dlat = (dist * math.cos(theta)) / 111_320
    dlng = (dist * math.sin(theta)) / (111_320 * math.cos(math.radians(lat)))
    lat2, lng2 = pull_ashore(lat + dlat, lng + dlng)
    return round(lat2, 6), round(lng2, 6)


def year_of(doc):
    for cat in doc.get("categories") or []:
        name = str(cat.get("catName") or "")
        if name.isdigit() and 2011 <= int(name) <= 2035:
            return int(name)
    return None


def month_of(doc):
    raw = doc.get("startDate") or ""
    if len(raw) < 10:
        return None
    # Archive imports were all stamped January 1 and are not real months.
    if raw[5:10] == "01-01":
        return None
    try:
        month = int(raw[5:7])
    except ValueError:
        return None
    return month if 1 <= month <= 12 else None


def float_number(title: str):
    match = re.search(r"(\d{1,4})", title or "")
    return int(match.group(1)) if match else None


def main():
    docs = json.loads(RAW.read_text())
    global trail_networks
    trail_networks = {}
    for pid, _name, lat, lng, radius, _aliases in PLACES:
        if pid not in TRAIL_PLACES:
            continue
        lines = ways_near(lat, lng, min(800, max(radius + 160, 520)))
        net = index_lines(lines)
        if net[0] >= 120:
            trail_networks[pid] = net
            print(f"  trail {pid}: {net[0]/1000:.1f} km, {len(net[1])} paths")
    finds = []
    unmatched = Counter()
    placed = Counter()
    for doc in docs:
        year = year_of(doc)
        if year is None:
            continue
        location = (doc.get("location") or "").strip()
        pid = match_place(location)
        rec = {
            "id": str(doc.get("recid") or ""),
            "n": float_number(doc.get("title") or ""),
            "year": year,
            "month": month_of(doc),
            "title": re.sub(r"\s+", " ", (doc.get("title") or "").strip()),
            "where": location,
            "place": pid,
            "url": doc.get("url") or "",
        }
        if pid:
            _id, _name, lat, lng, radius, _aliases = PLACE_BY_ID[pid]
            key = rec["id"] or location + str(year)
            net = trail_networks.get(pid)
            if net:
                jlat, jlng = snap_to_trail(net, key)
                rec["onTrail"] = True
            else:
                jlat, jlng = jitter(key, lat, lng, radius)
            rec["lat"] = round(jlat, 6)
            rec["lng"] = round(jlng, 6)
            placed[pid] += 1
        else:
            unmatched[norm(location) or "(blank)"] += 1
        finds.append(rec)

    places_out = []
    for pid, name, lat, lng, _radius, _aliases in PLACES:
        if not placed[pid]:
            continue
        net = trail_networks.get(pid)
        if net:
            lat, lng, _dlat, _dlng = point_along(net, net[0] * 0.5)
        else:
            lat, lng = pull_ashore(lat, lng)
        places_out.append({"id": pid, "name": name, "lat": round(lat, 6), "lng": round(lng, 6)})
    payload = {
        "meta": {
            "source": "https://www.blockislandinfo.com/glass-float-project/found-floats/",
            "archive": "https://www.blockislandinfo.com/glass-float-project/found-float-archives/",
            "fetched": datetime.now(timezone.utc).date().isoformat(),
            "total": len(finds),
            "placed": sum(placed.values()),
            "note": (
                "Finders describe a place in words. The registry map pins are almost all "
                "the tourism office, so each dot is matched to a named spot on the island "
                "Trail finds are spread along the OpenStreetMap footpaths. Other finds are nudged slightly so they can form a heat map. "
                "Months before 2024 were not recorded; those finds were imported on January 1."
            ),
        },
        "places": places_out,
        "finds": finds,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {OUT}  finds={len(finds)} placed={sum(placed.values())} "
          f"({100 * sum(placed.values()) / len(finds):.1f}%) places={len(places_out)}")
    print("top places:")
    for pid, count in placed.most_common(15):
        print(f"  {count:4}  {PLACE_BY_ID[pid][1]}")
    print("top unmatched:")
    for text, count in unmatched.most_common(25):
        print(f"  {count:4}  {text}")


if __name__ == "__main__":
    main()
