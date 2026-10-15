"""Loads the labelled fictional demonstration catalogue (app/data/catalog.json)."""

import json
from pathlib import Path

_DATA = json.loads((Path(__file__).parent / "data" / "catalog.json").read_text(encoding="utf-8"))

SELLERS: dict[str, dict] = {s["id"]: s for s in _DATA["sellers"]}
ITEMS: dict[str, dict] = {i["id"]: i for i in _DATA["items"]}
DEMO: dict = _DATA["demo"]
NOTE: str = _DATA["_note"]
