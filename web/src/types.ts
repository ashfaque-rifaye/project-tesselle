export type Kind = "must" | "flexible";

export interface Requirement {
  id: string;
  label: string;
  kind: Kind;
  attribute?: string | null;
  op?: string | null;
  value_num?: number | null;
  value_list?: string[] | null;
  unit?: string | null;
  source: "customer" | "photo_estimate" | "assistant" | "seller";
  status: "confirmed" | "needs_checking";
  note?: string | null;
}

export interface Unknown {
  id: string;
  question: string;
  why: string;
  answer?: string | null;
  status: "open" | "answered" | "dont_know";
}

export interface Brief {
  version: number;
  title: string;
  purpose: string;
  requirements: Requirement[];
  budget: { target_inr?: number | null; limit_inr?: number | null; share_with_sellers: boolean };
  delivery: { region?: string | null; desired_by?: string | null; essential: boolean };
  unknowns: Unknown[];
  acceptance_checks: string[];
  confirmed: boolean;
  created_at: string;
  created_by: string;
  change_summary: string;
  changed_ids: string[];
}

export interface Concept {
  id: string;
  image_path: string;
  caption: string;
  instruction: string;
  parent_id?: string | null;
  pin?: [number, number] | null;
  brief_version: number;
  effects: { requirement_id?: string | null; suggestion: string }[];
  created_at: string;
}

export interface Check {
  requirement_id: string;
  label: string;
  kind: Kind;
  result: "met" | "unmet" | "unknown";
  observed?: string | null;
  explanation: string;
}

export interface Specs {
  width_cm?: number | null;
  depth_cm?: number | null;
  height_cm?: number | null;
  material?: string | null;
  finish?: string | null;
  mounting?: string | null;
  compartments?: number | null;
  features: string[];
  price_inr?: number | null;
  delivery_days?: number | null;
}

export type Verdict = "meets" | "possible_with_change" | "not_suitable" | "needs_quote";

export interface RouteEntry {
  item_id: string;
  route: "buy" | "source" | "customise" | "make";
  name: string;
  description: string;
  seller_id: string;
  seller_name: string;
  seller_label: string;
  image_path: string;
  specs: Specs;
  stock: string;
  checked_at: string;
  price_inr?: number | null;
  shipping_inr?: number | null;
  shipping_estimate: boolean;
  unresolved: string[];
  verdict: Verdict;
  decisive: string;
  checks: Check[];
  relevance?: number | null;
}

export interface Routes {
  brief_version: number;
  checked_at: string;
  entries: RouteEntry[];
  groups: Record<Verdict, string[]>;
  sources: string[];
  narrative: { headline: string; explanation: string; item_notes: { item_id: string; note: string }[]; next_steps: string[] };
  duration_ms: number;
}

export interface SellerRequest {
  id: string;
  seller_ids: string[];
  seller_names: string[];
  brief_version: number;
  shared: {
    title: string;
    purpose: string;
    requirements: { id: string; label: string; kind: Kind; status: string }[];
    budget?: { target_inr?: number; limit_inr?: number } | null;
    delivery_region?: string | null;
    concept_image_path?: string | null;
    photo_included: boolean;
    not_shared: string[];
  };
  summary: string;
  questions: string[];
  status: "draft" | "sent" | "responded";
  responses: { seller_id: string; seller_name: string; decision: string; message?: string; quote_id?: string; at: string }[];
  created_at: string;
  sent_at?: string;
}

export interface PriceLine {
  label: string;
  amount_inr?: number | null;
  kind: string;
  estimate: boolean;
}

export interface DecisionCard {
  title: string;
  what_changes: string;
  consequence: string;
  keep_label: string;
  accept_label: string;
  question_for_seller: string;
}

export interface Deviation {
  id: string;
  requirement_id: string;
  requirement_label: string;
  kind: Kind;
  original: string;
  proposed: string;
  reason: string;
  severity: "blocked" | "needs_decision";
  decision: "pending" | "kept_original" | "accepted";
  card?: DecisionCard | null;
}

export interface Quote {
  id: string;
  request_id: string;
  seller_id: string;
  seller_name: string;
  brief_version: number;
  round: number;
  title: string;
  message: string;
  offered_specs: Specs;
  responses: { requirement_id: string; response: string; offered?: string | null; note?: string | null }[];
  price_lines: PriceLine[];
  lead_time_days_min?: number | null;
  lead_time_days_max?: number | null;
  valid_until?: string | null;
  sample_plan?: string | null;
  terms: string[];
  deviations: Deviation[];
  readiness: "ready" | "needs_clarification" | "not_suitable";
  status: "active" | "superseded" | "expired" | "approved";
  image_path?: string | null;
  staged: boolean;
  note?: string | null;
  created_at: string;
}

export interface Milestone {
  key: string;
  label: string;
  actor: string;
  estimate: string;
  state: "done" | "current" | "upcoming";
  evidence?: string | null;
}

export interface Order {
  id: string;
  order_ref: string;
  sandbox: boolean;
  quote_id: string;
  seller_name: string;
  brief_version: number;
  title: string;
  specs: Specs;
  price_lines: PriceLine[];
  known_total_inr?: number | null;
  unresolved: string[];
  acceptance_checks: string[];
  status: string;
  milestones: Milestone[];
  delivery_check?: {
    photo_path: string;
    report: { summary: string; items: { check: string; result: string; evidence: string; how_to_verify: string }[] };
    at: string;
    outcome?: string | null;
    note?: string;
  } | null;
  created_at: string;
}

export interface Stat {
  agent?: string;
  model?: string;
  purpose?: string;
  latency_ms?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  thought_tokens?: number;
  framework?: string;
  tools?: string[];
}

export interface ActivityEvent {
  id: string;
  ts: string;
  actor: string;
  kind: string;
  summary: string;
  detail?: string | null;
  stats: Stat[];
}

export interface NextDecision {
  stage: Stage;
  title: string;
  detail: string;
  quote_id?: string;
  deviation_id?: string;
  severity?: string;
}

export type Stage = "inspire" | "clarify" | "visualise" | "routes" | "request" | "compare" | "approve" | "fulfil" | "accept";

export interface Project {
  id: string;
  owner: string;
  title: string;
  demo: boolean;
  stage: Stage;
  brief_version: number;
  approved_brief_version?: number | null;
  selected_concept_id?: string | null;
  inspiration: { text?: string; image_path?: string | null; transcript?: string | null; photo_observations?: string[]; had_audio?: boolean };
  rev: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectState {
  project: Project;
  briefs: Brief[];
  concepts: Concept[];
  routes: Routes | null;
  requests: SellerRequest[];
  quotes: Quote[];
  order: Order | null;
  events: ActivityEvent[];
  next_decision: NextDecision;
}

export interface StreamEvent {
  type: "progress" | "tool" | "text" | "result" | "error" | "done";
  message?: string;
  text?: string;
  name?: string;
  node?: string;
  state?: ProjectState;
  details?: string[];
}
