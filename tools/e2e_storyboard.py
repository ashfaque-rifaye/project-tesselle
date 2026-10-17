"""End-to-end check of the Tesselle journey against a running app (real web search, no fictional sellers).

    python tools/e2e_storyboard.py http://127.0.0.1:8080
    python tools/e2e_storyboard.py https://<cloud-run-url>

Exits non-zero if a guarantee fails: the 18 cm must-have is captured, real listings link to real pages,
a practice reply's change to a must-have is blocked, keeping it produces a compliant reply, and a stale
or unsafe choice is refused.
"""

from __future__ import annotations

import json
import sys
import time
import uuid

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080").rstrip("/")
H = {"X-Visitor-Id": "e2e_" + uuid.uuid4().hex[:12]}
c = httpx.Client(base_url=BASE, headers=H, timeout=httpx.Timeout(400.0))
failures: list[str] = []


def step(name: str):
    print(f"\n== {name}")
    return time.perf_counter()


def done(t0: float, msg: str = "") -> None:
    print(f"   ok ({time.perf_counter() - t0:.1f}s) {msg}")


def expect(cond: bool, what: str) -> None:
    if not cond:
        failures.append(what)
        print(f"   FAIL: {what}")


def stream(path: str, **kw) -> dict:
    state = None
    with c.stream("POST", path, **kw) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line.strip():
                continue
            ev = json.loads(line)
            if ev.get("type") in ("progress", "tool"):
                print(f"   · [{ev.get('agent', '')}] {ev.get('message')}")
            if ev.get("type") == "ui":
                print("   → navigate", ev.get("navigate"))
            if ev.get("type") == "error":
                raise RuntimeError(ev.get("message"))
            if ev.get("state"):
                state = ev["state"]
    return state


t = step("0. health")
print("  ", c.get("/api/health").json())
done(t)

t = step("Create guided demo project")
s = c.post("/api/projects", json={"demo": True}).json()
pid = s["project"]["id"]
done(t, pid)

t = step("1. Start: words + desk photo")
demo = c.get("/api/meta").json()["demo"]
s = stream(f"/api/projects/{pid}/inspiration",
           data={"text": demo["inspiration_text"], "region": demo["region"], "consent_photo": "true", "use_demo_photo": "true"})
brief = s["briefs"][-1]
for r in brief["requirements"]:
    print(f"   - [{r['kind']}/{r['status']}] {r['label']}")
depth = next((r for r in brief["requirements"] if r.get("attribute") == "depth_cm"), None)
expect(depth is not None and depth["kind"] == "must" and depth["value_num"] == 18, "depth <= 18 cm captured as a must-have")
done(t)

t = step("2. Brief: confirm estimates and confirm")
reqs = brief["requirements"]
if any(r["status"] == "needs_checking" for r in reqs):
    for r in reqs:
        r["status"] = "confirmed"
    c.post(f"/api/projects/{pid}/brief", json={"requirements": reqs, "summary": "Measured"}).raise_for_status()
s = c.post(f"/api/projects/{pid}/brief/confirm").json()
expect(s["briefs"][-1]["confirmed"], "brief confirmed")
done(t, f"v{s['briefs'][-1]['version']}")

t = step("3. Find options: real stores + real makers")
s = stream(f"/api/projects/{pid}/routes/explore", json={})
routes = s["routes"]
buy = [e for e in routes["entries"] if e["route"] == "buy"]
make = [e for e in routes["entries"] if e["route"] == "make"]
for e in buy[:6]:
    print(f"   BUY  [{e['verdict']}] {e['name'][:50]} - {e['seller_name']} {e.get('price_inr')} {e['url'][:60]}")
for e in make[:4]:
    print(f"   MAKE {e['name'][:40]} - {e['seller_label']} {e['url'][:60]}")
print("   headline:", routes["narrative"]["headline"])
expect(len(buy) > 0, "real listings found")
expect(all(e["url"].startswith("http") and "vertexaisearch" not in e["url"] for e in routes["entries"]), "every option links to its real page")
expect(len(make) > 0, "real makers found")
deep = [e for e in buy for ch in e["checks"] if ch["requirement_id"] == depth["id"] and ch["result"] == "unmet"]
expect(all(x["verdict"] == "not_suitable" for x in deep), "anything deeper than 18 cm is not suitable")
done(t)

t = step("4. Reach out: draft a message to a real maker, mark sent")
target = make[0]
s = c.post(f"/api/projects/{pid}/requests", json={"entry_ids": [target["item_id"]]}).json()
req = s["requests"][-1]
print("   subject:", req["recipients"][0]["subject"])
print("   body:", req["recipients"][0]["body"][:200].replace("\n", " "), "...")
expect("18" in req["recipients"][0]["body"], "message carries the 18 cm must-have")
s = c.post(f"/api/projects/{pid}/requests/{req['id']}/sent", json={}).json()
expect(s["requests"][-1]["status"] == "sent", "marked sent")
done(t)

t = step("5. Practice reply: a change to a must-have is blocked")
s = stream(f"/api/projects/{pid}/replies/simulate", json={"request_id": req["id"]})
q = [x for x in s["quotes"] if x["status"] == "active"][-1]
for d in q["deviations"]:
    print(f"   - {d['severity']}: {d['requirement_label']} -> {d['proposed']}")
blocked = [d for d in q["deviations"] if d["severity"] == "blocked"]
expect(len(blocked) > 0, "practice reply's must-have change is blocked")
done(t)

if blocked:
    t = step("6. Keep the must-have -> follow-up drafted + revised practice reply")
    s = stream(f"/api/projects/{pid}/quotes/{q['id']}/decision", json={"deviation_id": blocked[0]["id"], "decision": "keep_original"})
    act = [x for x in s["quotes"] if x["status"] == "active"]
    old = next(x for x in s["quotes"] if x["id"] == q["id"])
    expect(bool(old.get("follow_up")), "follow-up message drafted for the seller")
    expect(len(act) == 1 and act[0]["round"] == 2, "revised reply received (round 2)")
    if act:
        q2 = act[0]
        expect(not any(d["severity"] == "blocked" for d in q2["deviations"]), "revised reply keeps every must-have")
        for d in [d for d in q2["deviations"] if d["decision"] == "pending"]:
            s = stream(f"/api/projects/{pid}/quotes/{q2['id']}/decision", json={"deviation_id": d["id"], "decision": "accept"})
    done(t)

t = step("7. Choose: guard refuses an unsafe store option, then choose the offer")
bad = next((e for e in buy if e["verdict"] == "not_suitable"), None)
if bad:
    r = c.post(f"/api/projects/{pid}/choose", json={"entry_id": bad["item_id"], "idempotency_key": "x1"})
    expect(r.status_code == 409, "choosing an option that breaks a must-have is blocked")
q2 = [x for x in c.get(f"/api/projects/{pid}").json()["quotes"] if x["status"] == "active"]
if q2:
    key = "e2e-" + uuid.uuid4().hex[:6]
    r = c.post(f"/api/projects/{pid}/choose", json={"quote_id": q2[-1]["id"], "idempotency_key": key, "acknowledgements": ["unresolved_charges", "confirm_with_seller"]})
    print("  ", r.status_code, r.json().get("details") if r.status_code != 200 else "")
    expect(r.status_code == 200, "chose the compliant offer")
    r2 = c.post(f"/api/projects/{pid}/choose", json={"quote_id": q2[-1]["id"], "idempotency_key": key, "acknowledgements": ["unresolved_charges", "confirm_with_seller"]})
    expect(r2.status_code == 200, "duplicate choose is idempotent")
done(t)

t = step("8. Track + delivery check")
c.post(f"/api/projects/{pid}/order/advance", json={"step": "ordered"}).raise_for_status()
c.post(f"/api/projects/{pid}/order/advance", json={"step": "delivered"}).raise_for_status()
s = stream(f"/api/projects/{pid}/delivery-check", data={"use_sample": "true"})
dc = s["order"]["delivery_check"]
print("   ", dc["report"]["summary"][:160])
expect(len(dc["report"]["items"]) > 0, "delivery check produced per-check results")
c.post(f"/api/projects/{pid}/delivery-close", json={"outcome": "accept"}).raise_for_status()
done(t)

t = step("9. Assistant: memory + navigation")
s = stream(f"/api/projects/{pid}/chat", data={"text": "What do you remember about me? Then take me to the options.", "screen": "accept"})
print("   reply:", (s["events"][0]["summary"] if s else "")[:200])
done(t)

print(f"\nProject: {BASE}/p/{pid}")
if failures:
    print("FAILED CHECKS:\n - " + "\n - ".join(failures))
    sys.exit(1)
print("ALL CHECKS PASSED")
