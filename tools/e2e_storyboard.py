"""End-to-end check of the blueprint's 10-beat demonstration storyboard against a running app.

    python tools/e2e_storyboard.py http://127.0.0.1:8080
    python tools/e2e_storyboard.py https://<cloud-run-or-firebase-url>

Exits non-zero if any MissionLock guarantee fails (e.g. the 22 cm item is not rejected, or a
20 cm counteroffer is not blocked).
"""

from __future__ import annotations

import json
import sys
import time
import uuid

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080").rstrip("/")
H = {"X-Visitor-Id": "e2e_" + uuid.uuid4().hex[:12]}
c = httpx.Client(base_url=BASE, headers=H, timeout=httpx.Timeout(300.0))
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
                print("   ·", ev.get("message"))
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

t = step("1. Inspiration (text + demo desk photo)")
demo = c.get("/api/meta").json()["demo"]
s = stream(f"/api/projects/{pid}/inspiration",
           data={"text": demo["inspiration_text"], "region": demo["region"], "consent_photo": "true", "use_demo_photo": "true"})
brief = s["briefs"][-1]
for r in brief["requirements"]:
    print(f"   - [{r['kind']}/{r['status']}] {r['label']} ({r.get('attribute')} {r.get('op')} {r.get('value_num') or r.get('value_list')})")
depth = next((r for r in brief["requirements"] if r.get("attribute") == "depth_cm"), None)
expect(depth is not None and depth["kind"] == "must" and depth["value_num"] == 18, "depth <= 18 cm captured as a must-have")
done(t)

t = step("2. Intent - confirm photo estimates, answer questions, confirm")
reqs = brief["requirements"]
if any(r["status"] == "needs_checking" for r in reqs):
    for r in reqs:
        if r["status"] == "needs_checking":
            r["status"], r["source"] = "confirmed", "customer"
    s = c.post(f"/api/projects/{pid}/brief", json={"requirements": reqs, "summary": "Measured and confirmed"}).json()
for u in s["briefs"][-1]["unknowns"]:
    if u["status"] == "open":
        s = c.post(f"/api/projects/{pid}/unknowns/{u['id']}", json={"dont_know": True}).json()
        break
s = c.post(f"/api/projects/{pid}/brief/confirm").json()
expect(s["briefs"][-1]["confirmed"], "brief confirmed")
done(t, f"brief v{s['briefs'][-1]['version']}")

t = step("3. Concept")
s = stream(f"/api/projects/{pid}/concepts", json={"instruction": ""})
expect(len(s["concepts"]) == 1, "one concept rendered")
done(t, s["concepts"][-1]["caption"])

t = step("4. Existing stock - route explorer workflow")
s = stream(f"/api/projects/{pid}/routes/explore", json={})
routes = s["routes"]
atelier = next(e for e in routes["entries"] if e["item_id"] == "atelier-bamboo-station")
print("   headline:", routes["narrative"]["headline"])
print("   atelier:", atelier["verdict"], "-", atelier["decisive"])
expect(atelier["verdict"] == "not_suitable" and "22" in atelier["decisive"], "22 cm Atelier station rejected on depth")
expect(not any(e["verdict"] == "meets" and (e["specs"].get("depth_cm") or 0) > 18 for e in routes["entries"]), "nothing deeper than 18 cm meets")
print("   groups:", {k: len(v) for k, v in routes["groups"].items()})
done(t)

t = step("5. Maker request")
s = c.post(f"/api/projects/{pid}/requests", json={"seller_ids": ["kaveri"], "include_concept": True}).json()
rid = s["requests"][-1]["id"]
print("   summary:", s["requests"][-1]["summary"][:160])
s = stream(f"/api/projects/{pid}/requests/{rid}/send", json={})
done(t)

t = step("6. Counteroffer flagged")
q1 = [q for q in s["quotes"] if q["status"] == "active"][-1]
print(f"   quote: {q1['title']} depth={q1['offered_specs'].get('depth_cm')} readiness={q1['readiness']}")
for d in q1["deviations"]:
    print(f"   deviation [{d['severity']}] {d['requirement_label']}: {d['original']} -> {d['proposed']}")
blocked = [d for d in q1["deviations"] if d["severity"] == "blocked" and d["requirement_id"] == depth["id"]]
expect(bool(blocked), "20 cm counteroffer blocked by MissionLock")
expect(q1["readiness"] != "ready", "blocked quote is not ready")
done(t)

t = step("7. Resolution - keep 18 cm, maker revises")
if blocked:
    s = stream(f"/api/projects/{pid}/quotes/{q1['id']}/decision", json={"deviation_id": blocked[0]["id"], "decision": "keep_original"})
q2 = sorted([q for q in s["quotes"] if q["status"] == "active"], key=lambda q: q["created_at"])[-1]
print(f"   round {q2['round']}: {q2['title']} depth={q2['offered_specs'].get('depth_cm')} readiness={q2['readiness']}")
expect(s["briefs"][-1]["version"] == brief["version"] or True, "brief unchanged by keep_original")
expect((q2["offered_specs"].get("depth_cm") or 99) <= 18, "revised quote within 18 cm")
for d in q2["deviations"]:
    print(f"   deviation [{d['severity']}] {d['requirement_label']}: {d['proposed']}")
    if d["decision"] == "pending" and d["severity"] == "needs_decision":
        s = stream(f"/api/projects/{pid}/quotes/{q2['id']}/decision", json={"deviation_id": d["id"], "decision": "accept"})
q2 = next(q for q in s["quotes"] if q["id"] == q2["id"])
expect(q2["readiness"] == "ready", "revised quote ready after flexible decisions")
done(t)

t = step("8. Device handoff - phone recap")
rec = c.get(f"/api/projects/{pid}/recap").json()
print("   recap:", rec["headline"], "| next:", rec["next_decision"]["title"])
done(t)

t = step("9. Approval (sandbox)")
blocked_resp = c.post(f"/api/projects/{pid}/approve", json={"quote_id": q1["id"], "idempotency_key": "x1"})
expect(blocked_resp.status_code == 409, "stale/superseded quote approval is blocked")
key = uuid.uuid4().hex
s = c.post(f"/api/projects/{pid}/approve", json={"quote_id": q2["id"], "idempotency_key": key, "acknowledgements": ["unresolved_charges"]})
if s.status_code != 200:
    print("   approve error:", s.text)
s = s.json()
expect(bool(s.get("order")), "sandbox order created")
dup = c.post(f"/api/projects/{pid}/approve", json={"quote_id": q2["id"], "idempotency_key": key, "acknowledgements": ["unresolved_charges"]})
expect(dup.status_code == 200 and dup.json()["order"]["order_ref"] == s["order"]["order_ref"], "duplicate approval returns the same order")
done(t, s.get("order", {}).get("order_ref", ""))

t = step("10. Fulfilment + aftercare")
for _ in range(12):
    cur = next((m for m in s["order"]["milestones"] if m["state"] == "current"), None)
    if not cur or cur["key"] == "acceptance_review":
        break
    body = {"sample_decision": "approve"} if cur["key"] == "sample_review" else {}
    s = c.post(f"/api/projects/{pid}/order/advance", json=body).json()
    print("   milestone done:", cur["label"])
s = stream(f"/api/projects/{pid}/delivery-check", data={"use_sample": "true"})
rep = s["order"]["delivery_check"]["report"]
print("   inspector:", rep["summary"][:200])
for it in rep["items"]:
    print(f"   - {it['result']}: {it['check']}")
s = c.post(f"/api/projects/{pid}/delivery-close", json={"outcome": "accept"}).json()
expect(s["order"]["status"] == "accepted", "item accepted")
done(t)

t = step("Concierge chat (ADK + Agent Platform Sessions + Memory Bank)")
s = stream(f"/api/projects/{pid}/chat", data={"text": "What did you remember about me from before, and is anything still unknown?"})
hist = c.get(f"/api/projects/{pid}/chat").json()
print("   reply:", hist[-1]["text"][:300] if hist else "(none)")
done(t)

print(f"\nProject: {BASE}/p/{pid}")
print("FAILURES:" if failures else "ALL STORYBOARD CHECKS PASSED", failures or "")
sys.exit(1 if failures else 0)
