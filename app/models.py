"""Tesselle domain model: the versioned customer brief, offers, quotes and decisions.

Customer-facing vocabulary (blueprint §04): a `must` requirement is shown as "Must stay the same",
a `flexible` one as "Flexible", status `needs_checking` as "Needs checking".
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

Kind = Literal["must", "flexible"]
ReqStatus = Literal["confirmed", "needs_checking"]
Source = Literal["customer", "photo_estimate", "assistant", "seller"]
Op = Literal["<=", ">=", "==", "!=", "in", "not_in", "has", "text"]

# Structured attributes the deterministic guard can check against product specs. Any other short
# snake_case key (e.g. "screen_size_in", "fabric") is allowed too and is read from Specs.attributes.
ATTRIBUTES = [
    "depth_cm",
    "width_cm",
    "height_cm",
    "weight_kg",
    "price_inr",
    "mounting",
    "material",
    "finish",
    "color",
    "size",
    "compatible_with",
    "capacity",
    "features",
    "delivery_days",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Requirement(BaseModel):
    id: str = Field(description="Short stable slug, e.g. 'max-depth', 'no-drilling'.")
    label: str = Field(description="Plain-language label, e.g. 'Maximum depth 18 cm'.")
    kind: Kind = Field(description="'must' = cannot change without explicit approval; 'flexible' = may be traded off.")
    attribute: Optional[str] = Field(
        default=None,
        description="Prefer one of: " + ", ".join(ATTRIBUTES) + " (or another short snake_case key). "
        "Null for purely qualitative requirements.",
    )
    op: Optional[Op] = Field(default=None, description="Comparison operator for the attribute.")
    value_num: Optional[float] = Field(default=None, description="Numeric value for <=, >=, ==, != comparisons.")
    value_list: Optional[list[str]] = Field(
        default=None, description="Allowed/forbidden/required values for in, not_in, has (lowercase)."
    )
    unit: Optional[str] = None
    source: Source = "customer"
    status: ReqStatus = "confirmed"
    note: Optional[str] = Field(default=None, description="Why it matters, in the customer's words.")


class Unknown(BaseModel):
    id: str
    question: str = Field(description="The smallest useful next question.")
    why: str = Field(description="Why the answer matters for fulfilment.")
    topic: Optional[str] = Field(default=None, description="Short key for what it asks about, e.g. 'shelf-depth', 'budget', 'colour'.")
    answer: Optional[str] = None
    status: Literal["open", "answered", "dont_know"] = "open"


class Budget(BaseModel):
    target_inr: Optional[int] = None
    limit_inr: Optional[int] = None
    share_with_sellers: bool = True


class Delivery(BaseModel):
    region: Optional[str] = None
    pincode: Optional[str] = Field(default=None, description="6-digit Indian PIN code for delivery, if known.")
    desired_by: Optional[str] = None
    essential: bool = False


class Brief(BaseModel):
    version: int = 1
    title: str = "Untitled project"
    purpose: str = ""
    category: str = "general"
    requirements: list[Requirement] = Field(default_factory=list)
    budget: Budget = Field(default_factory=Budget)
    delivery: Delivery = Field(default_factory=Delivery)
    unknowns: list[Unknown] = Field(default_factory=list)
    acceptance_checks: list[str] = Field(default_factory=list)
    confirmed: bool = False
    created_at: str = Field(default_factory=now_iso)
    created_by: str = "customer"
    change_summary: str = "First draft from your inspiration."
    changed_ids: list[str] = Field(default_factory=list)

    def req(self, rid: str) -> Optional[Requirement]:
        return next((r for r in self.requirements if r.id == rid), None)

    def musts(self) -> list[Requirement]:
        return [r for r in self.requirements if r.kind == "must"]


# ---- Product / offer side -------------------------------------------------------------------


class Specs(BaseModel):
    width_cm: Optional[float] = None
    depth_cm: Optional[float] = None
    height_cm: Optional[float] = None
    material: Optional[str] = None
    finish: Optional[str] = None
    mounting: Optional[str] = None  # freestanding | adhesive | clamp | drill | wall-screw
    compartments: Optional[int] = None
    features: list[str] = Field(default_factory=list)
    price_inr: Optional[float] = None
    delivery_days: Optional[float] = None
    attributes: dict[str, Any] = Field(default_factory=dict, description="Any other stated property, by requirement attribute key.")


class Check(BaseModel):
    requirement_id: str
    label: str
    kind: Kind
    result: Literal["met", "unmet", "unknown"]
    observed: Optional[str] = None
    explanation: str = ""


class FitResult(BaseModel):
    verdict: Literal["meets", "possible_with_change", "not_suitable"]
    decisive: str
    checks: list[Check]


# ---- Quotes and deviations -------------------------------------------------------------------


class RequirementResponse(BaseModel):
    requirement_id: str
    response: Literal["achievable", "needs_clarification", "proposed_change", "not_achievable"]
    offered: Optional[str] = Field(default=None, description="What the seller actually offers for this requirement.")
    note: Optional[str] = None


class PriceLine(BaseModel):
    label: str
    amount_inr: Optional[float] = Field(default=None, description="Null when the charge is not yet known.")
    kind: Literal["item", "customisation", "sample", "shipping", "fee", "unresolved"] = "item"
    estimate: bool = False


class Deviation(BaseModel):
    id: str
    requirement_id: str
    requirement_label: str
    kind: Kind
    original: str
    proposed: str
    reason: str
    severity: Literal["blocked", "needs_decision"]
    decision: Literal["pending", "kept_original", "accepted"] = "pending"
    card: Optional[dict] = None


class Quote(BaseModel):
    id: str
    request_id: str
    seller_id: str
    seller_name: str
    brief_version: int
    round: int = 1
    title: str
    message: str
    offered_specs: Specs
    responses: list[RequirementResponse] = Field(default_factory=list)
    price_lines: list[PriceLine] = Field(default_factory=list)
    lead_time_days_min: Optional[int] = None
    lead_time_days_max: Optional[int] = None
    valid_until: Optional[str] = None
    sample_plan: Optional[str] = None
    terms: list[str] = Field(default_factory=list)
    deviations: list[Deviation] = Field(default_factory=list)
    readiness: Literal["ready", "needs_clarification", "not_suitable"] = "needs_clarification"
    status: Literal["active", "superseded", "expired", "approved"] = "active"
    image_path: Optional[str] = None
    staged: bool = True
    layout_description: Optional[str] = None
    note: Optional[str] = None
    follow_up: Optional[dict] = Field(default=None, description="Drafted reply to the seller after a decision.")
    created_at: str = Field(default_factory=now_iso)
