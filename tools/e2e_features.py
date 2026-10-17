"""End-to-end check of the v4 features against a deployment:
voice/chat start with no brief, PIN code, questions, notes, rename, revert, picks -> orders -> confirmation ->
order history, shoppable look, live voice WebSocket.

    python tools/e2e_features.py https://tesselle-448771854429.asia-southeast1.run.app
"""

import asyncio
import json
import sys
import time

import httpx

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8080"
H = {"X-Visitor-Id": f"v_e2e_features_{int(time.time())}"}
c = httpx.Client(base_url=BASE, headers=H, timeout=300)
fails = []


def expect(ok, what):
    print(("  PASS " if ok else "  FAIL ") + what)
    if not ok:
        fails.append(what)


def stream(url, **kw):
    state = None
    with c.stream("POST", url, **kw) as r:
        if r.status_code >= 400:
            r.read()
            print("  HTTP", r.status_code, r.text[:200])
            return None
        for line in r.iter_lines():
            if line.strip():
                ev = json.loads(line)
                if ev["type"] in ("progress", "tool"):
                    print("     ", ev.get("agent") or "", "|", (ev.get("message") or "")[:100])
                if ev.get("state"):
                    state = ev["state"]
    return state


print("1. PIN code lookup")
expect(c.get("/api/pincode/600042").json()["city"] == "Chennai", "600042 -> Chennai")

print("2. Chat with no brief starts one (the old phone error)")
pid = c.post("/api/projects", json={"title": "E2E features"}).json()["project"]["id"]
stream(f"/api/projects/{pid}/chat", data={"text": "I need a freestanding bookshelf for my bedroom in Chennai 600042, at most 80 cm wide, "
                                                   "and I can't spend more than 6000 rupees", "screen": "inspire"})
s = c.get(f"/api/projects/{pid}").json()
b = s["briefs"][-1] if s["briefs"] else None
expect(bool(b), "brief created from the chat")
expect(bool(b and b["delivery"].get("pincode") == "600042"), "PIN code captured")
expect(bool(b and not any("budget" in u["question"].lower() for u in b["unknowns"] if u["status"] == "open")), "no budget question once a budget is given")

print("3. Rename, notes, revert")
s = c.post(f"/api/projects/{pid}/edit", json={"title": "Bedroom bookshelf"}).json()
expect(s["project"]["title"] == "Bedroom bookshelf", "project renamed")
s = c.post(f"/api/projects/{pid}/notes", json={"text": "Prefer white", "share": True}).json()
expect(len(s["notes"]) == 1, "note saved")
c.post(f"/api/projects/{pid}/brief/confirm").raise_for_status()
s = c.post(f"/api/projects/{pid}/brief", json={"budget": {"target_inr": None, "limit_inr": 5000, "share_with_sellers": True}, "summary": "Budget"}).json()
v = s["briefs"][-1]["version"]
s = c.post(f"/api/projects/{pid}/brief/revert", json={"to_version": 1}).json()
expect(s["briefs"][-1]["version"] == v + 1 and s["briefs"][-1]["budget"]["limit_inr"] == b["budget"]["limit_inr"], "revert restores v1 as a new version")

print("4. Options, picks, orders")
s = stream(f"/api/projects/{pid}/routes/explore", json={})
buy = [e for e in s["routes"]["entries"] if e["route"] == "buy" and e["verdict"] != "not_suitable"]
imgs = sum(1 for e in s["routes"]["entries"] if e["route"] == "buy" and e.get("image_url"))
expect(len(buy) >= 2, f"{len(buy)} listings that fit")
expect(imgs >= 1, f"{imgs} of {len([e for e in s['routes']['entries'] if e['route'] == 'buy'])} listings with product photos")
for e in buy[:2]:
    c.post(f"/api/projects/{pid}/cart", json={"entry_id": e["item_id"]}).raise_for_status()
s = c.post(f"/api/projects/{pid}/orders", json={"acknowledgements": ["check_on_store", "confirm_with_seller", "unresolved_charges"]}).json()
expect(len(s["orders"]) == 2 and not s["cart"], "two picks became two orders")
o = s["orders"][0]
s = stream(f"/api/projects/{pid}/orders/{o['id']}/confirm", data={"text": f"Your order 407-555 for {o['title'][:30]} is confirmed. Total Rs 2,499. Delivery by 24 Oct."})
oo = next(x for x in s["orders"] if x["id"] == o["id"])
expect((oo.get("confirmation") or {}).get("order_number") == "407-555", "confirmation read into the order")
hist = c.get("/api/orders").json()
expect(len(hist) >= 2, "order history lists the orders")
s = c.post(f"/api/projects/{pid}/orders/{s['orders'][1]['id']}/cancel").json()
expect(any(x["status"] == "cancelled" for x in s["orders"]), "changed my mind: order cancelled")

print("5. Shop the look")
s = stream(f"/api/projects/{pid}/looks", json={"in_space": True})
look = (s or {}).get("looks", [None])[-1]
expect(bool(look and any(i["x"] is not None for i in look["items"])), "shoppable picture with tagged products")


print("6. Live voice WebSocket")


async def live():
    import websockets
    url = BASE.replace("http", "ws") + f"/api/projects/{pid}/live"
    async with websockets.connect(url, origin="https://project-tesselle.web.app", max_size=None) as ws:
        await ws.send(json.dumps({"type": "hello", "stage": "routes"}))
        audio, said, t0 = 0, "", time.time()
        while time.time() - t0 < 40:
            m = await asyncio.wait_for(ws.recv(), timeout=30)
            if isinstance(m, bytes):
                audio += len(m)
                continue
            ev = json.loads(m)
            if ev["type"] == "said":
                said += ev["text"]
            if ev["type"] == "turn" and audio:
                break
        return audio, said

audio, said = asyncio.run(live())
print("     said:", said[:120])
expect(audio > 10000, f"voice agent spoke ({audio} bytes of audio)")

print("\nALL CHECKS PASSED" if not fails else f"\n{len(fails)} FAILED: " + "; ".join(fails))
sys.exit(1 if fails else 0)
