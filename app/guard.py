"""Brief guard: deterministic checks that protect what the customer asked for.

Language models propose; this module decides. Every fit verdict, every quote deviation and every
approval gate is computed here in plain code against the confirmed brief, so no agent (and no
seller) can silently rewrite a must-have. Agents only explain these results in plain language.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from .models import Brief, Check, Deviation, FitResult, Quote, Requirement, Specs

_LABELS = {
    "depth_cm": "depth",
    "width_cm": "width",
    "height_cm": "height",
    "price_inr": "price",
    "delivery_days": "delivery time",
    "weight_kg": "weight",
}


def _fmt_num(attr: str, v: float) -> str:
    if attr == "price_inr":
        return f"₹{v:,.0f}"
    if attr == "delivery_days":
        return f"{v:g} days"
    if attr.endswith("_cm"):
        return f"{v:g} cm"
    if attr.endswith("_kg"):
        return f"{v:g} kg"
    return f"{v:g}"


def _spec_value(specs: Specs, attr: str) -> Any:
    value = getattr(specs, attr, None) if attr in Specs.model_fields and attr != "attributes" else None
    if value in (None, [], ""):
        value = (specs.attributes or {}).get(attr)
    return value


def check_requirement(req: Requirement, specs: Specs, listing: bool = False) -> Check:
    """listing=True: specs come from a store listing's text, where an unmentioned feature is
    'not stated' (unknown) rather than proof that it is missing."""
    base = dict(requirement_id=req.id, label=req.label, kind=req.kind)
    if req.status == "needs_checking":
        return Check(
            **base,
            result="unknown",
            explanation=f"'{req.label}' is not confirmed by you yet, so no fit claim is made.",
        )
    if not req.attribute or not req.op or req.op == "text":
        return Check(**base, result="unknown", explanation="Needs the seller to confirm.")

    value = _spec_value(specs, req.attribute)
    if value is None or value == [] or value == "":
        noun = _LABELS.get(req.attribute, req.attribute.replace("_", " "))
        return Check(**base, result="unknown", explanation=f"The listing doesn't state the {noun}.")

    attr = req.attribute
    if req.op in ("<=", ">=", "==", "!=") and req.value_num is not None:
        try:
            v = float(value)
        except (TypeError, ValueError):
            return Check(**base, result="unknown", explanation=f"Stated as '{value}' - needs confirming against {req.value_num:g}.")
        target = req.value_num
        ok = {"<=": v <= target, ">=": v >= target, "==": abs(v - target) < 1e-6, "!=": abs(v - target) >= 1e-6}[req.op]
        observed = _fmt_num(attr, v)
        if ok:
            return Check(**base, result="met", observed=observed, explanation=f"{observed} satisfies '{req.label}'.")
        noun = _LABELS.get(attr, attr)
        if req.op == "<=":
            why = f"It is {observed}, {_fmt_num(attr, v - target)} over your limit of {_fmt_num(attr, target)}."
            if attr in ("depth_cm", "width_cm", "height_cm"):
                why = f"It is {observed} {noun}; your maximum is {_fmt_num(attr, target)}."
        elif req.op == ">=":
            why = f"It is {observed}; you need at least {_fmt_num(attr, target)}."
        else:
            why = f"It is {observed}; you asked for {_fmt_num(attr, target)}."
        return Check(**base, result="unmet", observed=observed, explanation=why)

    wanted = [w.lower() for w in (req.value_list or [])]
    if isinstance(value, list):
        have = [str(x).lower() for x in value]
    else:
        have = [str(value).lower()]
    observed = ", ".join(have)

    def matches(w: str) -> bool:
        return any(w in h or h in w for h in have)

    if req.op == "in":
        ok = any(matches(w) for w in wanted)
        expl = f"{observed} is one of your accepted options." if ok else f"It is {observed}; you accept {', '.join(wanted)}."
    elif req.op == "not_in":
        bad = [w for w in wanted if matches(w)]
        ok = not bad
        expl = f"{observed} - no {', '.join(wanted)} needed." if ok else f"It needs {bad[0]}, which you ruled out."
    elif req.op == "has":
        missing = [w for w in wanted if not matches(w)]
        ok = not missing
        if missing and listing:
            return Check(**base, result="unknown", observed=observed,
                         explanation=f"The listing doesn't mention {', '.join(missing)} - check the store page.")
        expl = f"Includes {', '.join(wanted)}." if ok else f"Missing: {', '.join(missing)}."
    else:
        return Check(**base, result="unknown", explanation="Needs seller confirmation.")
    return Check(**base, result="met" if ok else "unmet", observed=observed, explanation=expl)


def fit(brief: Brief, specs: Specs, listing: bool = False) -> FitResult:
    """Requirement-by-requirement fit. Verdict rules (blueprint §05):
    - any must-have unmet                    -> not_suitable (never promoted, however cheap)
    - a must unknown or a flexible unmet     -> possible_with_change
    - everything checkable met               -> meets
    """
    checks = [check_requirement(r, specs, listing) for r in brief.requirements if r.attribute or r.op]
    # Budget is evaluated from the brief's budget block, separately from requirements.
    if specs.price_inr is not None:
        if brief.budget.limit_inr:
            ok = specs.price_inr <= brief.budget.limit_inr
            checks.append(
                Check(
                    requirement_id="budget-limit",
                    label=f"Spending limit ₹{brief.budget.limit_inr:,}",
                    kind="must",
                    result="met" if ok else "unmet",
                    observed=f"₹{specs.price_inr:,.0f}",
                    explanation="Within your spending limit." if ok else f"₹{specs.price_inr:,.0f} is above your limit.",
                )
            )
        if brief.budget.target_inr:
            ok = specs.price_inr <= brief.budget.target_inr
            checks.append(
                Check(
                    requirement_id="budget-target",
                    label=f"Target budget ₹{brief.budget.target_inr:,}",
                    kind="flexible",
                    result="met" if ok else "unmet",
                    observed=f"₹{specs.price_inr:,.0f}",
                    explanation="Within your target budget."
                    if ok
                    else f"₹{specs.price_inr - brief.budget.target_inr:,.0f} above your target (flexible).",
                )
            )

    unmet_musts = [c for c in checks if c.kind == "must" and c.result == "unmet"]
    unknown_musts = [c for c in checks if c.kind == "must" and c.result == "unknown"]
    unmet_flex = [c for c in checks if c.kind == "flexible" and c.result == "unmet"]
    if unmet_musts:
        return FitResult(verdict="not_suitable", decisive=unmet_musts[0].explanation, checks=checks)
    if unknown_musts:
        return FitResult(
            verdict="possible_with_change",
            decisive=f"Check first: {unknown_musts[0].label.lower()} - {unknown_musts[0].explanation}",
            checks=checks,
        )
    if unmet_flex:
        return FitResult(
            verdict="possible_with_change",
            decisive=f"Changes a flexible preference: {unmet_flex[0].explanation}",
            checks=checks,
        )
    return FitResult(verdict="meets", decisive="Meets every must-have you set.", checks=checks)


def quote_deviations(brief: Brief, quote: Quote) -> list[Deviation]:
    """Compare a seller quote against the brief version it claims to address."""
    devs: list[Deviation] = []
    responses = {r.requirement_id: r for r in quote.responses}
    for req in brief.requirements:
        resp = responses.get(req.id)
        chk = check_requirement(req, quote.offered_specs) if (req.attribute and req.op) else None
        proposed_change = resp is not None and resp.response in ("proposed_change", "not_achievable")
        if (chk and chk.result == "unmet") or proposed_change:
            devs.append(
                Deviation(
                    id=f"dev-{req.id}",
                    requirement_id=req.id,
                    requirement_label=req.label,
                    kind=req.kind,
                    original=req.label,
                    proposed=(resp.offered if resp and resp.offered else (chk.observed if chk else "Changed")) or "Changed",
                    reason=(resp.note if resp and resp.note else (chk.explanation if chk else "Seller proposed a change.")),
                    severity="blocked" if req.kind == "must" else "needs_decision",
                )
            )
    if brief.budget.limit_inr:
        total = known_total(quote)
        if total is not None and total > brief.budget.limit_inr:
            devs.append(
                Deviation(
                    id="dev-budget-limit",
                    requirement_id="budget-limit",
                    requirement_label=f"Spending limit ₹{brief.budget.limit_inr:,}",
                    kind="must",
                    original=f"₹{brief.budget.limit_inr:,}",
                    proposed=f"₹{total:,.0f} known so far",
                    reason="The known charges exceed your absolute spending limit.",
                    severity="blocked",
                )
            )
    if brief.budget.target_inr:
        total = known_total(quote)
        limit_hit = any(d.id == "dev-budget-limit" for d in devs)
        if total is not None and total > brief.budget.target_inr and not limit_hit:
            devs.append(
                Deviation(
                    id="dev-budget-target",
                    requirement_id="budget-target",
                    requirement_label=f"Target budget ₹{brief.budget.target_inr:,}",
                    kind="flexible",
                    original=f"₹{brief.budget.target_inr:,}",
                    proposed=f"₹{total:,.0f} known so far",
                    reason=f"₹{total - brief.budget.target_inr:,.0f} above your target budget (flexible).",
                    severity="needs_decision",
                )
            )
    return devs


def known_total(quote: Quote) -> Optional[float]:
    """Sum of known charges. Unknown charges are never folded into a misleading all-in total."""
    amounts = [p.amount_inr for p in quote.price_lines if p.amount_inr is not None and p.kind != "unresolved"]
    return sum(amounts) if amounts else None


def unresolved_charges(quote: Quote) -> list[str]:
    return [p.label for p in quote.price_lines if p.amount_inr is None or p.kind == "unresolved"]


def readiness(brief: Brief, quote: Quote) -> str:
    """Offer readiness (blueprint §06): ready | needs_clarification | not_suitable."""
    if quote.brief_version != brief.version:
        return "needs_clarification"
    if any(d.severity == "blocked" and d.decision != "accepted" for d in quote.deviations):
        return "not_suitable"
    if any(d.severity == "needs_decision" and d.decision == "pending" for d in quote.deviations):
        return "needs_clarification"
    return "ready"


def unconfirmed_musts(brief: Brief, quote: Quote) -> list[str]:
    """Must-haves the reply neither confirms nor contradicts - the customer confirms them with the seller."""
    confirmed = {r.requirement_id for r in quote.responses if r.response == "achievable"}
    out = []
    for req in brief.musts():
        if req.id in confirmed or any(d.requirement_id == req.id for d in quote.deviations):
            continue
        if not (req.attribute and req.op) or check_requirement(req, quote.offered_specs).result == "unknown":
            out.append(req.label)
    return out


def approval_blockers(brief: Brief, quote: Quote, existing_order: bool) -> list[str]:
    """Approval safeguards (blueprint §08). Empty list means the approval may proceed."""
    blockers: list[str] = []
    if existing_order:
        blockers.append("An order already exists for this project - a second commitment is blocked.")
    if not brief.confirmed:
        blockers.append("Your brief is not confirmed.")
    if quote.status != "active":
        blockers.append(f"This quote is {quote.status} and cannot be approved.")
    if quote.brief_version != brief.version:
        blockers.append(
            f"This quote answers brief v{quote.brief_version}, but your current brief is v{brief.version}. "
            "The seller must reconfirm first."
        )
    if quote.valid_until:
        try:
            if datetime.fromisoformat(quote.valid_until) < datetime.now(timezone.utc):
                blockers.append("This quote has expired.")
        except ValueError:
            pass
    if readiness(brief, quote) != "ready":
        blockers.append("The quote is not ready: a must-have is unmet or a change still needs your decision.")
    total = known_total(quote)
    if brief.budget.limit_inr and total and total > brief.budget.limit_inr:
        blockers.append("Known charges exceed your spending limit.")
    return blockers


def diff_briefs(old: Brief, new: Brief) -> list[dict[str, Any]]:
    """Change lens: requirement-level differences between two brief versions."""
    changes: list[dict[str, Any]] = []
    old_map = {r.id: r for r in old.requirements}
    new_map = {r.id: r for r in new.requirements}
    for rid, r in new_map.items():
        o = old_map.get(rid)
        if o is None:
            changes.append({"id": rid, "change": "added", "before": None, "after": r.label, "kind": r.kind})
        elif (o.label, o.kind, o.value_num, o.value_list, o.status) != (r.label, r.kind, r.value_num, r.value_list, r.status):
            changes.append({"id": rid, "change": "changed", "before": f"{o.label} ({o.kind}, {o.status})",
                            "after": f"{r.label} ({r.kind}, {r.status})", "kind": r.kind})
    for rid, o in old_map.items():
        if rid not in new_map:
            changes.append({"id": rid, "change": "removed", "before": o.label, "after": None, "kind": o.kind})
    if old.budget != new.budget:
        changes.append({"id": "budget", "change": "changed",
                        "before": f"target {old.budget.target_inr}, limit {old.budget.limit_inr}",
                        "after": f"target {new.budget.target_inr}, limit {new.budget.limit_inr}", "kind": "must"})
    if old.delivery != new.delivery:
        changes.append({"id": "delivery", "change": "changed", "before": old.delivery.model_dump_json(),
                        "after": new.delivery.model_dump_json(), "kind": "flexible"})
    return changes
