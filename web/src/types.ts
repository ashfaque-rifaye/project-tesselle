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
  category?: string;
  requirements: Requirement[];
  budget: { target_inr?: number | null; limit_inr?: number | null; share_with_sellers: boolean };
  delivery: { region?: string | null; pincode?: string | null; desired_by?: string | null; essential: boolean };
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
  applied?: { from_version: number; to_version: number; changes: { id: string; before?: string | null; after: string; kind: string }[]; reverted?: boolean } | null;
  label?: string;
  batch?: string;
  idea?: Idea | null;
  spots?: { index: number; name: string; x: number; y: number }[];
  in_photo?: boolean;
  base_path?: string | null;
  created_at: string;
}

export interface Idea { title: string; pitch: string; items: { name: string; why: string }[]; placement: string; tweaks: string[] }

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
  attributes?: Record<string, unknown>;
}

export type Verdict = "meets" | "possible_with_change" | "not_suitable" | "needs_quote";

export interface Contact {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  found_on?: string | null;
  found_page?: string | null;
}

export interface RouteEntry {
  item_id: string;
  item?: string | null;
  complement?: boolean;
  route: "buy" | "make";
  name: string;
  description: string;
  seller_id: string;
  seller_name: string;
  seller_label: string;
  url: string;
  image_url?: string | null;
  image_path?: string | null;
  source_title?: string | null;
  contact?: Contact;
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

export interface Source {
  name: string;
  domain: string;
  kind: "store" | "maker";
}

export interface Routes {
  brief_version: number;
  checked_at: string;
  city?: string;
  entries: RouteEntry[];
  groups: Record<Verdict, string[]>;
  sources: Source[];
  narrative: { headline: string; points: string[]; best_next: string; item_notes: { item_id: string; note: string }[] };
  duration_ms: number;
}

export type Channel = "email" | "call" | "whatsapp";

export interface Recipient {
  entry_id: string;
  name: string;
  url?: string | null;
  contact?: Contact;
  subject: string;
  body: string;
  channels: { mailto?: string | null; whatsapp?: string | null; gmail?: string | null; website?: string | null };
  channel?: Channel;
  attachments?: string[];
  status: "draft" | "sent" | "calling" | "called" | "replied" | "failed";
  error?: string | null;
  call_id?: string;
  sent_at?: string;
}

export interface Attachment {
  id: string;
  path: string;
  label: string;
  privacy: { metadata_removed: boolean; blurred: string[] };
}

export interface SellerRequest {
  id: string;
  kind?: string;
  brief_version: number;
  recipients: Recipient[];
  seller_names: string[];
  status: "draft" | "sent" | "responded";
  responses: { seller_name: string; quote_id?: string; at: string }[];
  created_at: string;
  sent_at?: string;
  ref?: string;
  attachments?: Attachment[];
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
  follow_up?: { subject: string; body: string } | null;
  to_confirm?: string[];
  created_at: string;
}

export interface Milestone {
  key: string;
  label: string;
  actor: string;
  state: "done" | "current" | "upcoming";
  done_at?: string;
}

export interface Checkout {
  method: "amazon_cart" | "store_checkout" | "product_page" | "maker_confirm";
  url?: string | null;
  label: string;
  steps: string[];
  grouped?: number;
}

export interface Confirmation {
  order_number?: string | null;
  store?: string | null;
  items?: string[];
  total_inr?: number | null;
  order_date?: string | null;
  expected_delivery?: string | null;
  status?: string;
  tracking_url?: string | null;
  manual?: boolean;
  captured_at?: string;
}

export interface CartItem {
  id: string;
  kind: "store" | "maker";
  title: string;
  seller_name: string;
  seller_id?: string;
  url?: string | null;
  image_url?: string | null;
  image_path?: string | null;
  price_inr?: number | null;
  qty: number;
  entry_id?: string | null;
  quote_id?: string | null;
  needs: Record<string, string>;
  added_at: string;
}

export interface Note { id: string; text: string; share: boolean; created_at: string; updated_at: string }

export interface Call {
  id: string;
  request_id: string;
  entry_id: string;
  name: string;
  status: string;
  transcript: { who: "agent" | "them"; text: string }[];
  created_at: string;
}

export interface LookItem {
  entry_id: string;
  name: string;
  seller_name: string;
  seller_id?: string;
  price_inr?: number | null;
  url?: string | null;
  image_url?: string | null;
  x?: number | null;
  y?: number | null;
  verdict?: Verdict;
  complement?: boolean;
}

export interface Look {
  id: string;
  kind: "look" | "space";
  image_path: string;
  before_path?: string;
  items: LookItem[];
  in_space: boolean;
  note: string;
  created_at: string;
}

export interface Order {
  id: string;
  order_ref: string;
  kind: "store" | "maker";
  qty?: number;
  checkout?: Checkout | null;
  confirmation?: Confirmation | null;
  project_id?: string;
  project_title?: string;
  source?: string;
  seller_id?: string;
  image_path?: string | null;
  entry_id?: string | null;
  quote_id?: string | null;
  seller_name: string;
  url?: string | null;
  image_url?: string | null;
  brief_version: number;
  title: string;
  specs?: Specs;
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
    sample?: boolean;
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
  cta?: string;
  quote_id?: string;
  deviation_id?: string;
  severity?: string;
  count?: number;
  order_id?: string;
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
  inspiration: { text?: string; image_path?: string | null; transcript?: string | null; photo_observations?: string[]; had_audio?: boolean; generated_image?: boolean;
    photos?: ProjectPhoto[] };
  rev: number;
  archived?: boolean;
  view?: { stage: Stage; device: string; at: string; scroll?: number | null; busy?: string | null; kind?: string } | null;
  layout?: BriefLayout | null;
  plan_route?: Route | null;
  idea?: { concept_id: string; title: string; items: string[] } | null;
  idea_batch?: string | null;
  live?: { label: string; agent?: string | null; message?: string | null; at: string } | null;
  created_at: string;
  updated_at: string;
}

export type Route = "buy" | "make" | "either" | "source";

export interface ProjectPhoto { path: string; kind: string; note?: string; source?: string; at: string; caption?: string; observations?: string[] }

export interface Facet { label: string; value?: string | null; icon: string; requirement_id?: string | null; ask?: string | null }

/** Shaped by Gemini for each purchase: which facts matter, how requirements group, the likely path. */
export interface BriefLayout {
  kind_label: string;
  icon: string;
  facets: Facet[];
  sections: { title: string; requirement_ids: string[] }[];
  route: Route;
  route_reason: string;
  maker_word: string;
  photo_helps: boolean;
  photo_prompt?: string | null;
  show_deadline: boolean;
  steps?: { stage: Stage; label?: string | null; sub?: string | null }[];
  plan_v?: number;
  brief_version?: number;
}

export interface VoiceTurn { id: string; who: "you" | "agent"; text: string; raw_text?: string; audio_path?: string | null; seconds: number; created_at: string; session?: string }

export interface ProjectState {
  project: Project;
  briefs: Brief[];
  concepts: Concept[];
  routes: Routes | null;
  requests: SellerRequest[];
  quotes: Quote[];
  order: Order | null;
  orders: Order[];
  cart: CartItem[];
  notes: Note[];
  calls: Call[];
  looks: Look[];
  events: ActivityEvent[];
  next_decision: NextDecision;
}

export interface Line {
  agent?: string;
  message: string;
}

export interface StreamEvent {
  type: "progress" | "tool" | "text" | "result" | "error" | "done" | "ui" | "heartbeat" | "heard";
  message?: string;
  agent?: string;
  text?: string;
  name?: string;
  node?: string;
  navigate?: Stage | "back";
  reply?: string;
  audio?: string | null;
  state?: ProjectState;
  details?: string[];
}
