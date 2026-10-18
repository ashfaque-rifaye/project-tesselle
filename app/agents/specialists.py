"""Project Tesselle specialist agents (Google ADK LlmAgents on Gemini via Vertex AI).

Each specialist has one job and a typed output schema. None of them decides whether an offer meets
the brief: that verdict is computed deterministically by app.guard and handed to them.
"""

from __future__ import annotations

from typing import Literal, Optional

from google.adk.agents import LlmAgent
from pydantic import BaseModel, Field

from ..models import PriceLine, Requirement, RequirementResponse, Unknown
from .runtime import gen_config, model

# ---------------------------------------------------------------------------------------------
# 1. Brief agent: multimodal inspiration (words, voice, photo, video) -> draft brief
# ---------------------------------------------------------------------------------------------


class BriefDraft(BaseModel):
    title: str = Field(description="Short project name, e.g. 'Compact bamboo desk organiser'.")
    category: str = Field(description="One or two words, e.g. 'home office', 'phone accessory', 'gift', 'apparel'.")
    purpose: str = Field(description="The job it should do, in the customer's ordinary language.")
    requirements: list[Requirement]
    budget_target_inr: Optional[int] = Field(default=None, description="What they would like to spend.")
    budget_limit_inr: Optional[int] = Field(default=None, description="Only if they stated an absolute maximum.")
    delivery_region: Optional[str] = None
    delivery_desired_by: Optional[str] = Field(default=None, description="ISO date if they gave a deadline.")
    delivery_essential: bool = False
    unknowns: list[Unknown] = Field(description="At most 3 smallest-useful next questions.")
    acceptance_checks: list[str] = Field(description="3-5 checks the customer can make when it arrives.")
    photo_observations: list[str] = Field(description="What the photo or video shows that matters (estimates are unconfirmed).")
    transcript: Optional[str] = Field(default=None, description="Verbatim transcript if a voice note was given.")
    out_of_scope: bool = False
    out_of_scope_reason: Optional[str] = None


INTAKE_INSTRUCTION = """
You are the brief agent in Project Tesselle, a personal shopping agent for purchases that have to fit:
a space, a device, a person, an occasion or a deadline. It helps people find, source or get made
almost anything - home and office items, tech accessories, clothing, gifts, spare parts, crafts.

Turn the customer's inspiration (typed words, a voice note, photos of their space or of an inspiring
item, a short video) into a draft brief.

Rules:
- Record only what the customer said or clearly showed. NEVER invent measurements or specs.
- A photo can suggest a dimension but cannot prove it: add such values with source "photo_estimate"
  and status "needs_checking", and add an unknown asking for a measurement. Values the customer typed
  or spoke are source "customer", status "confirmed".
- kind "must" = essential or a hard limit ("must", "only", "no drilling", "can't go above", "maximum",
  "has to", "needs to fit"). kind "flexible" = wishes ("would be lovely", "something like", "ideally").
- Prefer checkable structure:
  sizes -> depth_cm / width_cm / height_cm / weight_kg with op "<=" or ">=" and value_num;
  "no drilling" -> attribute "mounting", op "not_in", value_list ["drill", "wall-screw"];
  materials / colours / sizes -> attribute "material" / "color" / "size", op "in", lowercase options;
  device fit -> attribute "compatible_with", op "has", value_list e.g. ["pixel 9"];
  things it must include -> attribute "features", op "has", short lowercase nouns ("pen cup",
  "phone slot", "card slot", "usb-c"). One requirement per feature so each can be traded off.
- Budget: budget_target_inr = what they would like to spend; budget_limit_inr only for an absolute
  ceiling. Do not add budget as a requirement.
- Unknowns: at most 3, each the smallest useful next question with why it matters, with a short
  `topic` key. Never ask about something already stated (no budget question when a budget was given,
  no city question when a city was given). Only ask what would change which products fit.
- Acceptance checks: 3-5 concrete checks for delivery day, drawn from the must-haves.
- Ids are short kebab-case slugs (max-depth, no-drilling, phone-slot, material).
- Out of scope (out_of_scope true, with a kind reason): weapons, medicines, hazardous or regulated
  goods, anything illegal, and safety-critical items such as load-bearing structures or car parts
  that need certified fitting.
- If a voice note is attached, put its verbatim transcript in `transcript`.
- Do not copy protected brand designs; describe functional goals instead.
"""

intake_agent = LlmAgent(
    name="brief_agent",
    description="Turns multimodal inspiration into a draft brief.",
    model=model(),
    instruction=INTAKE_INSTRUCTION,
    output_schema=BriefDraft,
    output_key="brief_draft",
    generate_content_config=gen_config("intake", thinking="low"),
)

# ---------------------------------------------------------------------------------------------
# 2. Design agent: brief + visual edit -> image prompt, and flags edits that touch the brief
# ---------------------------------------------------------------------------------------------


class BriefEffect(BaseModel):
    requirement_id: Optional[str] = Field(default=None, description="Existing requirement id affected, if any.")
    suggestion: str = Field(description="One short sentence saying what changes in the brief, e.g. 'Width 30 cm -> 25 cm'.")
    new_requirement: Optional[Requirement] = Field(
        default=None,
        description="The requirement exactly as it should read after this edit: same id to update an existing one, a new "
        "kebab-case id to add one. Use the customer's stated value; for a vague direction with no value (e.g. 'narrower') "
        "use a flexible qualitative requirement (op 'text'). Null when the edit does not touch the brief.")


class ConceptDirection(BaseModel):
    image_prompt: str = Field(description="A complete prompt for the image model.")
    caption: str = Field(description="2-5 word name for this variation.")
    brief_effects: list[BriefEffect] = Field(description="Brief requirements this visual edit might change. Empty if none.")


STUDIO_INSTRUCTION = """
You are the design agent of Project Tesselle. You write prompts for an image model that renders
CONCEPT images of a customer's idea. Concepts are illustrations only, never offers.

Given the brief and (optionally) the customer's refinement instruction:
- Write one rich image prompt: clean product concept render, three-quarter view, warm off-white
  seamless background, soft natural light, realistic materials, no text, no logos, no brand marks,
  no people. Respect every must-have visually.
- If the instruction refers to a marked area, say "apply the change only to the area marked by the
  ring in the reference image, and remove the ring".
- If the instruction changes something the brief records (a size, material, colour, feature), list it in
  brief_effects with new_requirement filled. The customer's own instruction is applied to the brief and
  they are told exactly what changed, with a one-tap revert. Never invent a number the customer did
  not give: "make it narrower" without a value becomes a flexible "Narrower profile" requirement.
- Never imitate a protected branded design; offer an original design with the same function.
"""

studio_director = LlmAgent(
    name="design_agent",
    description="Writes concept image prompts and flags visual edits that would change the brief.",
    model=model(),
    instruction=STUDIO_INSTRUCTION,
    output_schema=ConceptDirection,
    output_key="direction",
    generate_content_config=gen_config("studio-director"),
)

# ---------------------------------------------------------------------------------------------
# 3. Advisor: explains (never decides) the deterministic fit results, briefly
# ---------------------------------------------------------------------------------------------


class ItemNote(BaseModel):
    item_id: str
    note: str = Field(description="At most 14 words: the decisive difference for this customer.")


class RouteNarrative(BaseModel):
    headline: str = Field(description="At most 12 words, positive and honest: what was found for them.")
    points: list[str] = Field(description="2-3 bullet points, each at most 16 words: how the options were picked and what each path offers.")
    best_next: str = Field(description="At most 14 words: the most useful next step for the customer.")
    item_notes: list[ItemNote] = Field(default_factory=list)


ROUTE_INSTRUCTION = """
You are the advisor. You explain shopping options to a customer in plain, friendly language. You
receive the brief and every option checked: real store listings (route "buy") with a verdict from
the fit checker (meets / possible_with_change / not_suitable) and real makers who could quote
(route "make").

Rules:
- NEVER change or contradict a verdict. Something that breaks a must-have is never recommended.
- Lead with what WAS found and the best way forward ("6 good options from 4 stores - the walnut organiser fits
  best"). Never open with "No" or "Nothing". If ready-made items need a detail checked, say which one in a
  point; if a maker is the surest path, present it as an option ("a carpenter can build it to the cm").
- Short and scannable: headline <= 12 words, 2-4 points <= 16 words each, best_next <= 14 words.
  No jargon (no "routes", "verdicts", "vector search"). Speak like a helpful friend.
- Prices and stock come from store pages and can change; say "check on the store page" when it matters.
"""

route_analyst = LlmAgent(
    name="advisor",
    description="Summarises the options found, in short plain-language bullets.",
    model=model(),
    instruction=ROUTE_INSTRUCTION,
    output_schema=RouteNarrative,
    output_key="narrative",
    generate_content_config=gen_config("route-analyst"),
)

# ---------------------------------------------------------------------------------------------
# 4. Outreach agent: messages the customer sends to real makers / sellers
# ---------------------------------------------------------------------------------------------


class OutreachMessage(BaseModel):
    recipient: str = Field(description="Business name exactly as given.")
    subject: str = Field(description="Short email subject.")
    body: str = Field(description="Under 170 words. Friendly, specific, signed 'Thanks' without a name.")


class OutreachDrafts(BaseModel):
    messages: list[OutreachMessage]


OUTREACH_INSTRUCTION = """
You are the outreach agent. You write short messages Tesselle sends for the customer to real
businesses (makers, workshops, sellers) to ask for a quote or a change. The customer approves each one.

Each message: one line on what they want, then the must-haves as a short list ("must stay the same")
and the nice-to-haves, the budget only if the brief says it may be shared, the delivery city (and PIN
code if given), one short line about any attached photos, and a clear ask: "Could you confirm which of
these you can meet, a price with any delivery or extra charges, and how long it would take?".
Never include the customer's name, phone, email or street address.
Write in plain, polite English. For a follow-up after a counteroffer, politely restate the
requirement the customer kept and ask whether they can meet it, e.g. with a different layout.
"""

outreach_writer = LlmAgent(
    name="outreach_agent",
    description="Drafts quote requests and follow-ups that Tesselle sends to real businesses for the customer.",
    model=model(),
    instruction=OUTREACH_INSTRUCTION,
    output_schema=OutreachDrafts,
    output_key="drafts",
    generate_content_config=gen_config("outreach"),
)

# ---------------------------------------------------------------------------------------------
# 5. Reply reader: a seller's reply (pasted email, screenshot, PDF) -> structured quote
# ---------------------------------------------------------------------------------------------


class AttrValue(BaseModel):
    key: str = Field(description="Requirement attribute key, e.g. depth_cm, material, compatible_with.")
    value: str


class OfferedSpecs(BaseModel):
    width_cm: Optional[float] = None
    depth_cm: Optional[float] = None
    height_cm: Optional[float] = None
    material: Optional[str] = None
    finish: Optional[str] = None
    mounting: Optional[str] = None
    features: list[str] = Field(default_factory=list, description="Reuse the exact feature words from the brief.")
    attributes: list[AttrValue] = Field(default_factory=list, description="Any other stated property, keyed like the brief.")


class ReadQuote(BaseModel):
    seller_name: str
    title: str = Field(description="What is offered, e.g. 'Bamboo organiser - standard 20 cm jig'.")
    summary: str = Field(description="One or two sentences summarising the reply.")
    offered_specs: OfferedSpecs
    responses: list[RequirementResponse] = Field(description="One per brief requirement id the reply addresses.")
    price_lines: list[PriceLine] = Field(description="Every charge mentioned; amount_inr null when not given.")
    lead_time_days_min: Optional[int] = None
    lead_time_days_max: Optional[int] = None
    validity_days: Optional[int] = None
    terms: list[str] = Field(default_factory=list)


REPLY_INSTRUCTION = """
You are the reply reader. A seller or maker replied to the customer's request (pasted email text,
a screenshot or a PDF). Extract exactly what they OFFER - never what the customer wanted.
- For every brief requirement the reply addresses, add a response: achievable / needs_clarification /
  proposed_change / not_achievable, with what they actually offer in `offered`.
- offered_specs: only values stated in the reply. Unknown -> null. Reuse the brief's attribute keys.
- price_lines: each charge mentioned; anything mentioned but unpriced gets amount_inr null and kind
  "unresolved". Never add up prices yourself.
"""

reply_reader = LlmAgent(
    name="reply_reader",
    description="Turns a seller's reply into a structured quote the fit checker can verify.",
    model=model(),
    instruction=REPLY_INSTRUCTION,
    output_schema=ReadQuote,
    output_key="quote",
    generate_content_config=gen_config("reply-reader", thinking="low"),
)

# ---------------------------------------------------------------------------------------------
# 6. Practice reply: a clearly labelled simulated reply so anyone can try the flow end to end
# ---------------------------------------------------------------------------------------------


class SimulatedReply(BaseModel):
    text: str = Field(description="The reply email body, 80-150 words.")


SIMULATE_INSTRUCTION = """
Write a realistic reply email from a small maker answering the customer's request, for a clearly
labelled PRACTICE run of the app (it is never shown as a real business). Sign it "- The workshop".
ROUND 1: accept most requirements, but propose ONE change to the tightest numeric must-have because
it suits your standard tooling (e.g. a standard 20 cm jig when the customer's maximum depth is 18 cm),
explain the saving honestly, and give prices: the item, a small customisation fee, delivery as an
estimate, and lead time.
ROUND 2 (the customer kept their requirement): agree to meet it with a revised layout, mention any
small price rise, and restate prices and lead time.
"""

reply_simulator = LlmAgent(
    name="practice_reply",
    description="Writes a labelled practice reply so the reply flow can be tried without a real seller.",
    model=model(),
    instruction=SIMULATE_INSTRUCTION,
    output_schema=SimulatedReply,
    output_key="reply",
    generate_content_config=gen_config("practice-reply", temperature=0.5),
)

# ---------------------------------------------------------------------------------------------
# 7. Decision cards for seller-proposed changes
# ---------------------------------------------------------------------------------------------


class DecisionCard(BaseModel):
    title: str = Field(description="e.g. 'The maker proposes 20 cm depth'.")
    what_changes: str = Field(description="Original vs proposed, in one sentence.")
    consequence: str = Field(description="What accepting would mean for the customer, concretely.")
    keep_label: str = Field(description="Button text to keep the original, e.g. 'Keep 18 cm'.")
    accept_label: str = Field(description="Button text to accept, e.g. 'Accept 20 cm'.")
    question_for_seller: str = Field(description="What we ask the seller if the customer keeps the original.")


DEVIATION_INSTRUCTION = """
You write decision cards. A seller proposed a change to the customer's brief; the fit checker has
already classified it (blocked = it breaks a must-have; needs_decision = it changes a flexible
preference). Explain the trade-off and its real consequence BEFORE the customer chooses. Neutral,
calm, specific, plain language - no pressure. For a must-have, say plainly that accepting changes
something the customer said must stay the same. One sentence per field; button labels <= 4 words.
"""

deviation_explainer = LlmAgent(
    name="decision_writer",
    description="Explains seller-proposed changes as decision cards.",
    model=model(),
    instruction=DEVIATION_INSTRUCTION,
    output_schema=DecisionCard,
    output_key="card",
    generate_content_config=gen_config("deviation-explainer"),
)

# ---------------------------------------------------------------------------------------------
# 8. Recap: "Your sizes are confirmed. One reply needs your decision."
# ---------------------------------------------------------------------------------------------


class Recap(BaseModel):
    headline: str = Field(description="At most two short sentences: what is settled and what changed.")
    next_action: str = Field(description="The single next step, as a short imperative.")
    spoken: str = Field(description="The recap as one or two natural spoken sentences.")


RECAP_INSTRUCTION = """
Write a resume-where-you-left-off recap for a customer returning to a project, possibly on another
device. State what is settled, what changed, and the one next step. Never claim real-world events
(payments, deliveries, seller agreement) that the state does not show. Plain, friendly language.
"""

recap_agent = LlmAgent(
    name="recap",
    description="Short cross-device recap of a project's state and the next step.",
    model=model(),
    instruction=RECAP_INSTRUCTION,
    output_schema=Recap,
    output_key="recap",
    generate_content_config=gen_config("recap"),
)

# ---------------------------------------------------------------------------------------------
# 9. Delivery inspector: photo vs the acceptance checklist
# ---------------------------------------------------------------------------------------------


class InspectionItem(BaseModel):
    check: str
    result: Literal["looks_consistent", "possible_issue", "cannot_tell_from_photo"]
    evidence: str = Field(description="What in the photo supports this, or why it cannot be judged.")
    how_to_verify: str = Field(description="A simple way to verify, e.g. 'Measure the depth with a ruler'.")


class InspectionReport(BaseModel):
    items: list[InspectionItem]
    summary: str


INSPECTOR_INSTRUCTION = """
You help a customer check a delivered item against the checks they agreed before buying. Look at the
photo(s) carefully. A photo cannot prove exact dimensions or hidden quality: mark those
"cannot_tell_from_photo" and give a simple way to verify. Flag visible damage, missing parts or a
clearly different design as "possible_issue". Never declare the item accepted - the customer decides.
"""

delivery_inspector = LlmAgent(
    name="delivery_inspector",
    description="Compares delivery photos with the agreed acceptance checks.",
    model=model(),
    instruction=INSPECTOR_INSTRUCTION,
    output_schema=InspectionReport,
    output_key="inspection",
    generate_content_config=gen_config("delivery-inspector", thinking="medium"),
)
