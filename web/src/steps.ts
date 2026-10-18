import { STAGE_LABEL } from "./stages/ctx";
import type { ProjectState, Route, Stage } from "./types";

export const ORDER: Stage[] = ["inspire", "clarify", "visualise", "routes", "request", "compare", "approve", "fulfil", "accept"];

export interface StepInfo {
  stage: Stage;
  label: string;
  sub: string;
  status: "done" | "now" | "open" | "locked" | "optional" | "skipped";
  why: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** Which steps this purchase needs. The rail is planned, not fixed: before the brief there is only the first
 *  step; once Gemini knows what it is, it plans the path and names each step for this purchase ("Sizes &
 *  style", "Find tailors", "Get quotes"...). Ready-made skips the maker steps, made-to-order and bulk add
 *  them. Choosing and ordering picks is one step ("Shop & pick"); "Review & order" is a screen inside it. */
export function plannedStages(s: ProjectState): Stage[] {
  const b = s.briefs[s.briefs.length - 1];
  if (!b) return ["inspire"];
  const layout = s.project.layout;
  const route: Route = s.project.plan_route || layout?.route || "either";
  const ai = (layout?.plan_v === 2 ? layout.steps || [] : []).map((x) => x.stage);
  const reqs = s.requests || [];
  const quotes = (s.quotes || []).filter((q) => q.status !== "superseded");
  const usedMakers = reqs.length > 0 || quotes.length > 0;
  const boughtDirect = !usedMakers && ((s.cart || []).length > 0 || (s.orders || []).some((o) => o.status !== "cancelled"));
  const hasPhoto = !!s.project.inspiration?.image_path && !s.project.inspiration?.generated_image;
  const out: Stage[] = ["inspire", "clarify"];
  const ideas = s.concepts.length > 0 || (ai.length ? ai.includes("visualise") || hasPhoto : route !== "buy" || hasPhoto);
  if (ideas) out.push("visualise");
  out.push("routes");
  const makers = usedMakers || (!boughtDirect && (ai.length ? ai.includes("request") : route !== "buy"));
  if (makers) out.push("request", "compare");
  out.push("fulfil", "accept");
  return out;
}

/** The step a screen belongs to in the rail ("Review & order" is part of "Shop & pick"). */
export const railStage = (st: Stage): Stage => (st === "approve" ? "routes" : st);

/** The journey adapts to what the customer actually does; each step says what it holds and why. */
export function buildSteps(s: ProjectState): StepInfo[] {
  const b = s.briefs[s.briefs.length - 1];
  const routes = s.routes;
  const reqs = s.requests || [];
  const quotes = (s.quotes || []).filter((q) => q.status !== "superseded");
  const cart = s.cart || [];
  const orders = (s.orders || []).filter((o) => o.status !== "cancelled");
  const reached = ORDER.indexOf(s.project.stage || "inspire");
  const nd = railStage(s.next_decision.stage);
  const layout = s.project.layout;
  const named = Object.fromEntries((layout?.plan_v === 2 ? layout.steps || [] : []).map((x) => [x.stage, x]));
  const route: Route = s.project.plan_route || layout?.route || "either";
  const makersWord = layout?.maker_word || "makers";
  const usedMakers = reqs.length > 0 || quotes.length > 0;
  const musts = b ? b.requirements.filter((r) => r.kind === "must").length : 0;
  const fit = routes ? (routes.groups.meets?.length || 0) + (routes.groups.possible_with_change?.length || 0) : 0;
  const makers = routes ? routes.entries.filter((e) => e.route === "make").length : 0;
  const sent = reqs.flatMap((r) => r.recipients).filter((r) => r.status !== "draft").length;
  const toBuy = orders.filter((o) => o.milestones.some((m) => m.key === "ordered" && m.state === "current")).length;
  const checked = orders.filter((o) => o.delivery_check?.outcome).length;
  const ideas = s.concepts.filter((c) => c.idea).length || s.concepts.length;
  const label: Partial<Record<Stage, string>> = {
    routes: route === "source" ? `Find ${makersWord}` : STAGE_LABEL.routes,
    request: `Ask ${makersWord}`,
    compare: `${cap(makersWord).replace(/s$/, "")} replies`,
  };

  // Live counts win; otherwise the sub-line Gemini wrote for this purchase.
  const info: Record<Stage, { sub: string; why: string; optional?: boolean }> = {
    inspire: { sub: b ? "From what you shared" : "Say, type or show it", why: "Tell Tesselle what you want - by voice, words, a photo or a video." },
    clarify: { sub: b ? `${plural(musts, "must-have")}${b.confirmed ? " · confirmed" : " · check it"}` : "Gemini writes it", why: "Gemini turns what you shared into the few things that decide what fits. Check and change them any time." },
    visualise: { sub: ideas ? plural(ideas, "idea") : s.project.inspiration?.image_path ? "Ideas in your photo" : "2-3 ideas to choose from", why: "Gemini draws 2-3 ideas - into your own photo if you share one, keeping everything you have - and lists the real products each needs.", optional: route === "buy" },
    routes: { sub: cart.length ? `${plural(cart.length, "pick")} · ready to order` : routes ? `${fit} fit · ${plural(makers, makersWord.replace(/s$/, ""))}` : route === "buy" ? "Real stores near you" : route === "source" ? `Real ${makersWord}` : "Real stores and makers", why: "The shopping agent finds the real products in stores that deliver to you, checks each one, and you pick what to order - right here." },
    request: { sub: reqs.length ? `${sent}/${reqs.flatMap((r) => r.recipients).length} sent` : `Email, WhatsApp or an AI call`, why: `Tesselle finds their contact details, then messages or calls ${makersWord} for you - with your photos, privacy-checked.`, optional: !usedMakers && route !== "make" && route !== "source" },
    compare: { sub: quotes.length ? plural(quotes.length, "reply") : "Replies, checked for you", why: "Replies and call answers, each checked against your must-haves.", optional: !usedMakers && route !== "make" && route !== "source" },
    approve: { sub: cart.length ? plural(cart.length, "pick") : "Review your picks", why: "The fit checker clears each pick before ordering." },
    fulfil: { sub: orders.length ? `${plural(orders.length, "order")}${toBuy ? ` · ${toBuy} to buy` : ""}` : "The checkout agent", why: "The checkout agent fills the store cart (cash on delivery where offered), you confirm, then it tracks the order." },
    accept: { sub: orders.length ? `${checked}/${orders.length} checked` : "Photo check on arrival", why: "Gemini compares a photo of what arrived with what you asked for." },
  };
  const live: Partial<Record<Stage, boolean>> = {
    inspire: true, clarify: !!b, visualise: ideas > 0, routes: !!routes || cart.length > 0, request: reqs.length > 0, compare: quotes.length > 0,
    fulfil: orders.length > 0, accept: orders.length > 0,
  };

  return plannedStages(s).map((st) => {
    const i = ORDER.indexOf(st);
    let status: StepInfo["status"] = i < reached ? "done" : i === reached ? "open" : "locked";
    if (st === nd) status = "now";
    else if (status === "done" && st === "visualise" && !s.concepts.length) status = "skipped";
    else if (status === "done" && (st === "request" || st === "compare") && !usedMakers) status = "skipped";
    else if (status === "locked" && info[st].optional) status = "optional";
    if (st === "routes" && cart.length && status !== "now") status = "open";
    const g = named[st];
    return { stage: st, label: g?.label || label[st] || STAGE_LABEL[st], sub: live[st] || !g?.sub ? info[st].sub : g.sub, status, why: info[st].why };
  });
}

/** The name of a step in this project's own words. */
export function stepLabel(s: ProjectState, st: Stage): string {
  if (st === "approve") return STAGE_LABEL.approve;
  return buildSteps(s).find((x) => x.stage === st)?.label || STAGE_LABEL[st];
}

export function prevStep(steps: StepInfo[], view: Stage): Stage | null {
  if (view === "approve") return "routes";
  const i = steps.findIndex((x) => x.stage === view);
  for (let k = i - 1; k >= 0; k--) if (steps[k].status !== "locked") return steps[k].stage;
  return null;
}
