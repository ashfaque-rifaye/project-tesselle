"""Project Tesselle specialist agents (Google ADK LlmAgents on Gemini via Vertex AI).

Each specialist has one job and a typed output schema. None of them may decide whether an offer
meets the brief: that verdict is computed deterministically by app.missionlock and handed to them.
"""

from __future__ import annotations

from typing import Literal, Optional

from google.adk.agents import LlmAgent
from pydantic import BaseModel, Field

from ..models import PriceLine, Requirement, RequirementResponse, Specs, Unknown
from .runtime import gen_config, model

# ---------------------------------------------------------------------------------------------
# 1. Intake: multimodal inspiration (words, voice, photo) -> draft MissionLock brief
# ---------------------------------------------------------------------------------------------


class BriefDraft(BaseModel):
    title: str = Field(description="Short project name, e.g. 'Compact bamboo desk organiser'.")
    purpose: str = Field(description="The job the product should do, in the customer's ordinary language.")
    requirements: list[Requirement]
    budget_target_inr: Optional[int] = Field(default=None, description="What they would like to spend.")
    budget_limit_inr: Optional[int] = Field(default=None, description="Only if they stated an absolute maximum.")
    delivery_region: Optional[str] = None
    delivery_desired_by: Optional[str] = None
    delivery_essential: bool = False
    unknowns: list[Unknown] = Field(description="At most 3 smallest-useful next questions.")
    acceptance_checks: list[str] = Field(description="3-5 checks the customer can make on delivery.")
    photo_observations: list[str] = Field(
        description="What the photo shows that matters (estimates are labelled as unconfirmed)."
    )
    transcript: Optional[str] = Field(default=None, description="Verbatim transcript if a voice note was given.")
    out_of_scope: bool = False
    out_of_scope_reason: Optional[str] = None


INTAKE_INSTRUCTION = """
You are MissionLock's intake specialist inside Project Tesselle, a personal commerce agent that
preserves what a customer actually needs on the way from inspiration to a real offer.

Turn the customer's inspiration (typed words, a voice note, photos of their space or of an
inspiring item) into a draft product brief.

Rules:
- Record only what the customer said or clearly showed. NEVER invent measurements.
- A photo can suggest a dimension but cannot prove it: add such values with source
  "photo_estimate" and status "needs_checking", and add an unknown asking for a measurement.
  Values the customer typed or spoke are source "customer", status "confirmed".
- kind "must" = essential or a hard limit ("must", "only", "no drilling", "can't go above",
  "maximum", "has to"). kind "flexible" = wishes ("would be lovely", "something like", "ideally").
- Prefer checkable structure: depth_cm / width_cm / height_cm with op "<=" or ">=" and value_num;
  "no drilling" -> attribute "mounting", op "not_in", value_list ["drill", "wall-screw"];
  materials -> attribute "material", op "in", value_list of lowercase options;
  things it must hold -> attribute "features", op "has", value_list using short lowercase nouns
  such as "pen cup", "phone slot", "notebook tray", "drawer".
  Use one requirement per feature so each can be traded off separately.
- Budget: budget_target_inr = what they would like to spend; budget_limit_inr only when they gave
  an absolute ceiling. Do not add budget as a requirement.
- Unknowns: at most 3, each the smallest useful next question with why it matters. Do not ask
  about anything already stated.
- Acceptance checks: 3-5 concrete checks for delivery day, drawn from the must-haves.
- Ids are short kebab-case slugs (max-depth, no-drilling, phone-slot, material).
- Scope: non-electrical desk organisers and accessory holders. Electrical, load-bearing,
  hazardous or safety-critical items -> out_of_scope true with a kind reason.
- If a voice note is attached, put its verbatim transcript in `transcript`.
- Do not copy protected brand designs; describe functional goals instead.
"""

intake_agent = LlmAgent(
    name="missionlock_intake",
    description="Turns multimodal inspiration into a draft MissionLock brief.",
    model=model(),
    instruction=INTAKE_INSTRUCTION,
    output_schema=BriefDraft,
    output_key="brief_draft",
    generate_content_config=gen_config("intake", thinking="low"),
)

# ---------------------------------------------------------------------------------------------
# 2. Studio director: brief + visual edit -> image prompt, and flags edits that touch the brief
# ---------------------------------------------------------------------------------------------


class BriefEffect(BaseModel):
    requirement_id: Optional[str] = Field(default=None, description="Existing requirement id affected, if any.")
    suggestion: str = Field(description="One sentence the customer can accept to update the brief.")


class ConceptDirection(BaseModel):
    image_prompt: str = Field(description="A complete prompt for the image model.")
    caption: str = Field(description="2-5 word name for this variation.")
    brief_effects: list[BriefEffect] = Field(
        description="Brief requirements this visual edit might change. Empty if none."
    )


STUDIO_INSTRUCTION = """
You are the art director of Project Tesselle's creative studio. You write prompts for an image model
that renders CONCEPT visualisations of a customer's product idea. Concepts are illustrative only.

Given the confirmed brief and (optionally) the customer's refinement instruction:
- Write one rich image prompt: clean product concept render, three-quarter view, warm off-white
  seamless background, soft natural light, realistic materials, no text, no logos, no brand marks,
  no people. Respect every must-have visually (e.g. a shallow footprint for a small maximum depth,
  freestanding when drilling is ruled out, every required compartment visible).
- If the instruction refers to a marked area, say "apply the change only to the area marked by
  the teal ring in the reference image, and remove the ring".
- If the instruction implies a change to the brief (e.g. "make it narrower" changes width,
  "remove the phone slot" removes a requirement), list it in brief_effects. A visual edit never
  silently changes the brief - the customer decides.
- Never imitate a protected branded design; offer an original design with the same function.
"""

studio_director = LlmAgent(
    name="studio_director",
    description="Writes concept image prompts and flags visual edits that would change the brief.",
    model=model(),
    instruction=STUDIO_INSTRUCTION,
    output_schema=ConceptDirection,
    output_key="direction",
    generate_content_config=gen_config("studio-director"),
)

# ---------------------------------------------------------------------------------------------
# 3. Route analyst: explains (never decides) the deterministic fit results
# ---------------------------------------------------------------------------------------------


class ItemNote(BaseModel):
    item_id: str
    note: str = Field(description="One sentence: the decisive difference for this customer.")


class RouteNarrative(BaseModel):
    headline: str = Field(description="One honest sentence summarising what was found.")
    explanation: str = Field(description="2-3 sentences: why, and the trade-offs between routes.")
    item_notes: list[ItemNote]
    next_steps: list[str] = Field(description="2-4 neutral options the customer can take next.")


ROUTE_INSTRUCTION = """
You explain fulfilment options to a customer. You receive the confirmed brief and, for every
option checked, a verdict computed by the MissionLock guard: meets / possible_with_change /
not_suitable, plus requirement-by-requirement checks, stock status and unresolved charges.

Rules:
- NEVER change or contradict a verdict. A cheaper or prettier item that breaks a must-have is
  never recommended.
- If nothing meets every must-have say exactly: "No suitable match found in the sources checked."
  then explain what each route could offer.
- Be precise about uncertainty: "Delivery not yet confirmed", "Material needs seller confirmation",
  "Import duty not yet known". A stock observation is not a reservation.
- All sellers and items are fictional demonstration data - do not call them real.
- Next steps are neutral options (change a flexible preference, request sourcing, ask a maker,
  save and pause), not pressure. Keep notes to one sentence each.
"""

route_analyst = LlmAgent(
    name="route_analyst",
    description="Explains fit verdicts across buy, source, customise and make routes.",
    model=model(),
    instruction=ROUTE_INSTRUCTION,
    output_schema=RouteNarrative,
    output_key="narrative",
    generate_content_config=gen_config("route-analyst"),
)

# ---------------------------------------------------------------------------------------------
# 4. Seller brief writer: privacy-filtered summary of what sellers receive
# ---------------------------------------------------------------------------------------------


class SellerBrief(BaseModel):
    summary: str = Field(description="3-4 sentence brief a maker can act on. No personal details.")
    questions_for_maker: list[str] = Field(description="1-3 questions the maker should answer in a quote.")


SELLER_BRIEF_INSTRUCTION = """
Write the brief a maker will receive. Include only: the product purpose, confirmed dimensions and
constraints, must-haves vs flexible preferences, budget only if sharing is allowed, delivery
region (city level). Never include names, addresses, contact details or descriptions of the
customer's home beyond what the product must fit. Ask the maker to mark each requirement as
achievable, needs clarification, proposed change or not achievable.
"""

seller_brief_writer = LlmAgent(
    name="seller_brief_writer",
    description="Drafts the privacy-filtered request that sellers receive.",
    model=model(),
    instruction=SELLER_BRIEF_INSTRUCTION,
    output_schema=SellerBrief,
    output_key="seller_brief",
    generate_content_config=gen_config("seller-brief"),
)

# ---------------------------------------------------------------------------------------------
# 5. Demo maker: an AI-simulated fictional seller that quotes against the brief
# ---------------------------------------------------------------------------------------------


class MakerResponse(BaseModel):
    decision: Literal["quote", "decline"]
    title: str = Field(description="Name of what is offered, e.g. 'Bamboo organiser - standard 20 cm jig'.")
    message: str = Field(description="Under 80 words, in the maker's voice.")
    offered_specs: Specs
    responses: list[RequirementResponse]
    price_lines: list[PriceLine]
    lead_time_days_min: int
    lead_time_days_max: int
    validity_days: int
    sample_plan: str
    terms: list[str]
    layout_description: str = Field(description="Visual description of the offered design for a proposal render.")


MAKER_INSTRUCTION = """
You are role-playing a FICTIONAL small seller in a Project Tesselle demonstration. Your responses are
AI-simulated and clearly labelled as such in the product. Never claim to be a real business.

Seller profile: {seller_name}. {capabilities}

You receive a customer-approved brief (with its version number) and, in later rounds, the
customer's decision on your previous proposal. Respond as a careful workshop owner would:
- Mark EVERY requirement id in `responses`: achievable / needs_clarification / proposed_change /
  not_achievable, with what you actually offer in `offered`.
- `offered_specs` describes exactly what you would make. For features you include, reuse the exact
  feature words from the brief (e.g. "pen cup", "phone slot", "notebook tray").
- Price lines: the item, any design/customisation charge, the sample photo step, shipping (mark
  estimate=true) and an `unresolved` line with amount_inr null for anything you cannot price yet.
- If the brief does not fit your craft at all, decide "decline" with a polite reason.

Commercial behaviour for this demonstration (stay realistic):
- ROUND 1: your cheapest, fastest route is your standard tray jig. If the brief's maximum depth is
  below your nearest standard jig depth, quote the standard jig depth as a `proposed_change` on the
  depth requirement, explaining the cost and lead-time advantage honestly.
- LATER ROUNDS where the customer KEPT their original requirement: design a revised compartment
  layout that fits within their maximum depth (for example: phone slot moved to the side, notebook
  stored upright). Mark depth achievable. Re-cutting the jig costs a little more, so the price may
  rise slightly; be explicit about it.
"""


def maker_agent(seller_name: str, capabilities: str) -> LlmAgent:
    return LlmAgent(
        name="demo_maker",
        description="AI-simulated fictional maker that answers seller requests.",
        model=model(),
        instruction=MAKER_INSTRUCTION.replace("{seller_name}", seller_name).replace("{capabilities}", capabilities),
        output_schema=MakerResponse,
        output_key="maker_response",
        generate_content_config=gen_config("demo-maker", thinking="medium", temperature=0.4),
    )


# ---------------------------------------------------------------------------------------------
# 6. Deviation explainer: decision cards for seller-proposed changes
# ---------------------------------------------------------------------------------------------


class DecisionCard(BaseModel):
    title: str = Field(description="e.g. 'The maker proposes 20 cm depth'.")
    what_changes: str = Field(description="Original vs proposed, in one sentence.")
    consequence: str = Field(description="What accepting would mean for the customer, concretely.")
    keep_label: str = Field(description="Button text to keep the original, e.g. 'Keep 18 cm - ask for another layout'.")
    accept_label: str = Field(description="Button text to accept, e.g. 'Accept 20 cm (creates brief v3)'.")
    question_for_seller: str = Field(description="What we will ask the seller if the customer keeps the original.")


DEVIATION_INSTRUCTION = """
You write decision cards for MissionLock. A seller proposed a change to the customer's brief; the
guard has already classified it (blocked = it breaks a must-have; needs_decision = it changes a
flexible preference). Explain the compromise and its real consequence BEFORE the customer
chooses. Neutral, calm, specific - no pressure, no recommendation to accept. For a must-have, say
plainly that accepting changes something the customer said must stay the same and creates a new
brief version. Keep each field to one sentence.
"""

deviation_explainer = LlmAgent(
    name="deviation_explainer",
    description="Explains seller-proposed changes as decision cards.",
    model=model(),
    instruction=DEVIATION_INSTRUCTION,
    output_schema=DecisionCard,
    output_key="card",
    generate_content_config=gen_config("deviation-explainer"),
)

# ---------------------------------------------------------------------------------------------
# 7. Recap: "Your dimensions are confirmed. Two quotes need review."
# ---------------------------------------------------------------------------------------------


class Recap(BaseModel):
    headline: str = Field(description="At most two short sentences: what is confirmed and what changed.")
    next_action: str = Field(description="The single next decision, as a short imperative.")
    spoken: str = Field(description="The recap as one or two natural spoken sentences.")


RECAP_INSTRUCTION = """
Write a resume-where-you-left-off recap for a customer returning to a project, possibly on a
different device. The customer must not need to reread anything. State what is confirmed, what
changed, and the one decision waiting. Never claim real-world events (payments, deliveries,
seller agreement) that the state does not show; sandbox orders are sandbox orders.
"""

recap_agent = LlmAgent(
    name="recap",
    description="Short cross-device recap of a project's state and the pending decision.",
    model=model(),
    instruction=RECAP_INSTRUCTION,
    output_schema=Recap,
    output_key="recap",
    generate_content_config=gen_config("recap"),
)

# ---------------------------------------------------------------------------------------------
# 8. Delivery inspector: photo vs the approved acceptance checklist
# ---------------------------------------------------------------------------------------------


class InspectionItem(BaseModel):
    check: str
    result: Literal["looks_consistent", "possible_issue", "cannot_tell_from_photo"]
    evidence: str = Field(description="What in the photo supports this, or why it cannot be judged.")
    how_to_verify: str = Field(description="A simple way for the customer to verify, e.g. 'Measure the depth with a ruler'.")


class InspectionReport(BaseModel):
    items: list[InspectionItem]
    summary: str


INSPECTOR_INSTRUCTION = """
You help a customer check a delivered item against the acceptance checks they approved before
ordering. Look at the photo(s) carefully. A photo cannot prove exact dimensions or hidden quality:
mark those "cannot_tell_from_photo" and give a simple way to verify. Flag visible damage, missing
parts or a clearly different design as "possible_issue". Never declare the item accepted - the
customer decides. Delivery confirmation is not acceptance of conformity.
"""

delivery_inspector = LlmAgent(
    name="delivery_inspector",
    description="Compares delivery photos with the approved acceptance checklist.",
    model=model(),
    instruction=INSPECTOR_INSTRUCTION,
    output_schema=InspectionReport,
    output_key="inspection",
    generate_content_config=gen_config("delivery-inspector", thinking="medium"),
)
