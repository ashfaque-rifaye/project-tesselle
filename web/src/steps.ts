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

/** Which steps this purchase needs. The rail is built, not fixed: before the brief there is only
 *  "Start"; once Gemini knows what it is, the path appears - ready-made skips the maker steps, made-to-
 *  order and bulk sourcing add them, a concept step shows when something is being made or drawn. */
export function plannedStages(s: ProjectState): Stage[] {
  const b = s.briefs[s.briefs.length - 1];
  if (!b) return ["inspire"];
  const route: Route = s.project.plan_route || s.project.layout?.route || "either";
  const reqs = s.requests || [];
  const quotes = (s.quotes || []).filter((q) => q.status !== "superseded");
  const usedMakers = reqs.length > 0 || quotes.length > 0;
  const boughtDirect = !usedMakers && ((s.cart || []).length > 0 || (s.orders || []).some((o) => o.status !== "cancelled"));
  const out: Stage[] = ["inspire", "clarify"];
  if (s.concepts.length || route === "make" || route === "either") out.push("visualise");
  out.push("routes");
  if (usedMakers || (!boughtDirect && route !== "buy")) out.push("request", "compare");
  out.push("approve", "fulfil", "accept");
  return out;
}

/** The journey adapts to what the customer actually does; each step says what it holds and why. */
export function buildSteps(s: ProjectState): StepInfo[] {
  const b = s.briefs[s.briefs.length - 1];
  const routes = s.routes;
  const reqs = s.requests || [];
  const quotes = (s.quotes || []).filter((q) => q.status !== "superseded");
  const cart = s.cart || [];
  const orders = (s.orders || []).filter((o) => o.status !== "cancelled");
  const reached = ORDER.indexOf(s.project.stage || "inspire");
  const nd = s.next_decision.stage;
  const layout = s.project.layout;
  const route: Route = s.project.plan_route || layout?.route || "either";
  const makersWord = layout?.maker_word || "makers";
  const usedMakers = reqs.length > 0 || quotes.length > 0;
  const musts = b ? b.requirements.filter((r) => r.kind === "must").length : 0;
  const fit = routes ? (routes.groups.meets?.length || 0) + (routes.groups.possible_with_change?.length || 0) : 0;
  const makers = routes ? routes.entries.filter((e) => e.route === "make").length : 0;
  const sent = reqs.flatMap((r) => r.recipients).filter((r) => r.status !== "draft").length;
  const toBuy = orders.filter((o) => o.milestones.some((m) => m.key === "ordered" && m.state === "current")).length;
  const checked = orders.filter((o) => o.delivery_check?.outcome).length;
  const label: Partial<Record<Stage, string>> = {
    routes: route === "source" ? `Find ${makersWord}` : STAGE_LABEL.routes,
    request: `Ask ${makersWord}`,
    compare: `${cap(makersWord).replace(/s$/, "")} replies`,
  };

  const info: Record<Stage, { sub: string; why: string; optional?: boolean }> = {
    inspire: { sub: b ? "From what you shared" : "Say, type or show it", why: "Tell Tesselle what you want - by voice, words, a photo or a video." },
    clarify: { sub: b ? `v${b.version} · ${plural(musts, "must-have")}${b.confirmed ? "" : " · draft"}` : "Written by the brief agent", why: "Gemini turns what you shared into a brief you can check and change." },
    visualise: { sub: s.concepts.length ? plural(s.concepts.length, "concept") : route === "make" ? "See it before it's made" : "Optional - see the idea first", why: "The design agent draws your idea. Optional - skip it any time.", optional: route !== "make" },
    routes: { sub: routes ? `${fit} fit · ${plural(makers, makersWord.replace(/s$/, ""))}` : route === "buy" ? "Real stores near you" : route === "source" ? `Real ${makersWord}` : "Real stores and makers", why: "The shopping agent searches real stores and makers that deliver to you, and checks each one." },
    request: { sub: reqs.length ? `${sent}/${reqs.flatMap((r) => r.recipients).length} sent` : `Email, WhatsApp or an AI call`, why: `Tesselle messages or calls ${makersWord} for you - with your photos, privacy-checked.`, optional: !usedMakers && route !== "make" && route !== "source" },
    compare: { sub: quotes.length ? plural(quotes.length, "reply") : "Replies, checked for you", why: "Replies and call answers, each checked against your must-haves.", optional: !usedMakers && route !== "make" && route !== "source" },
    approve: { sub: cart.length ? plural(cart.length, "pick") : orders.length ? "Ordered" : "Add options here", why: "Add one or more options. The fit checker clears each one before ordering." },
    fulfil: { sub: orders.length ? `${plural(orders.length, "order")}${toBuy ? ` · ${toBuy} to buy` : ""}` : "Checkout agent", why: "The checkout agent fills the store cart (cash on delivery where offered), then tracks the order." },
    accept: { sub: orders.length ? `${checked}/${orders.length} checked` : "Photo check on arrival", why: "Gemini compares a photo of what arrived with your brief." },
  };

  return plannedStages(s).map((st) => {
    const i = ORDER.indexOf(st);
    let status: StepInfo["status"] = i < reached ? "done" : i === reached ? "open" : "locked";
    if (st === nd) status = "now";
    else if (status === "done" && st === "visualise" && !s.concepts.length) status = "skipped";
    else if (status === "done" && (st === "request" || st === "compare") && !usedMakers) status = "skipped";
    else if (status === "locked" && info[st].optional) status = "optional";
    if (st === "approve" && cart.length && status !== "now") status = "open";
    return { stage: st, label: label[st] || STAGE_LABEL[st], sub: info[st].sub, status, why: info[st].why };
  });
}

export function prevStep(steps: StepInfo[], view: Stage): Stage | null {
  const i = steps.findIndex((x) => x.stage === view);
  for (let k = i - 1; k >= 0; k--) if (steps[k].status !== "locked") return steps[k].stage;
  return null;
}
