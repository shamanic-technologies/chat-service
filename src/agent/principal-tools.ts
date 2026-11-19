// ---------------------------------------------------------------------------
// Distry's principal tools (DISTRY-PRINCIPAL-1119, owner 2026-11-19: Distry is
// the CEO of distribute.you, Kevin the shareholder, and the sole point of
// contact with the outside world).
//
//  - Stakeholders: who a person or an organization is to us and EVERYTHING
//    that happened with them, every channel merged (crm-service's people read
//    and Unibox timeline, through the gateway, on distribute.you's own brand).
//  - Finance: what each client pays us, costs us and the margin, plus fleet
//    totals, as features-service serves them (never computed here).
//  - Engines: one tool per Engine of the live catalogue (`engines` family),
//    each running that Engine's best script as the Rating picks it and waiting
//    for its Unit (workflow-service).
//
// Every one of them reads across clients or spends on our account: they load
// ONLY in a conversation with distribute.you staff, never with a client, a
// prospect or a guest (`principalToolsAllowed`, pinned by tests). The staff
// check is the same one the prompt-template tools use (staff-only-tools.ts).
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";
import { apiServiceFetch, type ApiCallParams } from "../lib/api-client.js";

/** The run Distry's staff reads of our own Unibox ride (under OUR org, Copilot support). */
export const DISTRY_STAFF_READ_TASK_NAME = "distry-staff-read";

export const FIND_STAKEHOLDERS_TOOL_NAME = "find_stakeholders";
export const READ_PERSON_UNIBOX_TOOL_NAME = "read_person_unibox";
export const READ_ORGANIZATION_UNIBOX_TOOL_NAME = "read_organization_unibox";
export const READ_COMPANY_FINANCIALS_TOOL_NAME = "read_company_financials";
/** The config entry that turns on one tool per callable Engine (built at run time). */
export const ENGINES_TOOL_FAMILY = "engines";
/** Every Engine tool's name starts with this. */
export const ENGINE_TOOL_PREFIX = "engine__";

export const STAKEHOLDER_TOOL_NAMES = [FIND_STAKEHOLDERS_TOOL_NAME, READ_PERSON_UNIBOX_TOOL_NAME, READ_ORGANIZATION_UNIBOX_TOOL_NAME] as const;

/** Every principal tool a version may turn on, with what it does (the editor lists them). */
export const PRINCIPAL_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [FIND_STAKEHOLDERS_TOOL_NAME]: "Staff only. Find people we are in touch with (name, email, phone, company, words they wrote) and who each is to us.",
  [READ_PERSON_UNIBOX_TOOL_NAME]: "Staff only. One person's whole Unibox: every message and event with us, every channel, newest last.",
  [READ_ORGANIZATION_UNIBOX_TOOL_NAME]: "Staff only. One organization's people and everything that happened with each of them, merged by date.",
  [READ_COMPANY_FINANCIALS_TOOL_NAME]: "Staff only. Revenue, cost and margin per client and for the whole company, as served by features-service.",
  [ENGINES_TOOL_FAMILY]: "Staff only. One tool per Engine of the live catalogue that can run now: runs its best script (the Rating's pick) and waits for the Unit.",
};

/** The names a config can list that are principal tools (Engine tools included by prefix). */
export function isPrincipalToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRINCIPAL_TOOL_DESCRIPTIONS, name) || name.startsWith(ENGINE_TOOL_PREFIX) || name === "read_engine_call";
}

/** The run an Engine call rides under the account it is for (an order of work, not support). */
export const DISTRY_ENGINE_CALL_TASK_NAME = "distry-engine-call";

/**
 * Who may hold a principal tool in a turn: distribute.you staff talking for
 * themselves. A guest turn (it runs under our own identity, a staff user
 * included), a Lead event turn and a proactive turn never do.
 */
export function principalToolsAllowed(turn: { requesterIsStaff: boolean; guest: boolean; leadTurn: boolean; proactive: boolean }): boolean {
  return turn.requesterIsStaff && !turn.guest && !turn.leadTurn && !turn.proactive;
}

/** The config's tools for this turn: principal tools dropped unless allowed. */
export function withoutPrincipalToolsUnlessAllowed(toolNames: readonly string[], allowed: boolean): string[] {
  return allowed ? [...toolNames] : toolNames.filter((t) => !isPrincipalToolName(t));
}

// ---------------------------------------------------------------------------
// Stakeholders: crm-service's people + Unibox timeline, on OUR brand
// ---------------------------------------------------------------------------

export const FIND_STAKEHOLDERS_TOOL: Anthropic.Tool = {
  name: FIND_STAKEHOLDERS_TOOL_NAME,
  description:
    "Find the people distribute.you is in touch with and who each is to us: name, emails, phones, company, their state with us (lead, client, lost...), last activity, and their personId. " +
    "Search by name, email, a domain, a phone, a company, or words they wrote. Read before you speak about or to someone, so you know them; then read_person_unibox for everything that happened with them.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Name, email, domain, phone (4+ digits), company, or words from their messages." },
      limit: { type: "integer", description: "At most 25 (default 10)." },
    },
    required: ["query"],
  },
};

export const READ_PERSON_UNIBOX_TOOL: Anthropic.Tool = {
  name: READ_PERSON_UNIBOX_TOOL_NAME,
  description:
    "One person's whole Unibox with us: every email, WhatsApp, LinkedIn, call, chat with you, payment, signup, meeting, oldest first, the latest items. " +
    "Name them by personId (from find_stakeholders) or by an identity: email or phone.",
  input_schema: {
    type: "object",
    properties: {
      personId: { type: "string", description: "The person's id from find_stakeholders." },
      email: { type: "string" },
      phone: { type: "string", description: "+<digits>" },
      limit: { type: "integer", description: "How many of the latest items (default 40, at most 100)." },
    },
  },
};

export const READ_ORGANIZATION_UNIBOX_TOOL: Anthropic.Tool = {
  name: READ_ORGANIZATION_UNIBOX_TOOL_NAME,
  description:
    "One organization as we know it: its people (who each is to us) and everything that happened with each of them, merged by date. " +
    "Name it by its company name or its domain (acme.com).",
  input_schema: {
    type: "object",
    properties: {
      organization: { type: "string", description: "Company name or domain." },
      limit: { type: "integer", description: "Latest items across its people (default 60, at most 150)." },
    },
    required: ["organization"],
  },
};

export const STAKEHOLDER_TOOLS: readonly Anthropic.Tool[] = [FIND_STAKEHOLDERS_TOOL, READ_PERSON_UNIBOX_TOOL, READ_ORGANIZATION_UNIBOX_TOOL];

/** distribute.you's own account: where our Unibox lives. */
export interface OurAccount {
  orgId: string;
  userId: string;
  brandId: string;
}

export function ourAccountFromEnv(env: NodeJS.ProcessEnv = process.env): OurAccount {
  const orgId = env.COPILOT_FOLLOWUP_ORG_ID;
  const userId = env.COPILOT_FOLLOWUP_USER_ID;
  const brandId = env.COPILOT_FOLLOWUP_BRAND_ID;
  if (!orgId || !userId || !brandId) throw new Error("COPILOT_FOLLOWUP_ORG_ID / COPILOT_FOLLOWUP_USER_ID / COPILOT_FOLLOWUP_BRAND_ID not configured: our Unibox cannot be read");
  return { orgId, userId, brandId };
}

export interface StakeholderDeps {
  account: OurAccount;
  /** A run under OUR org for these reads (opened once per turn). */
  runId: () => Promise<string>;
  fetch?: (path: string, params: ApiCallParams) => Promise<Response>;
}

const TEXT_MAX = 700;
const cut = (s: unknown, max = TEXT_MAX): string | null => {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}… (cut)` : t;
};
const clampInt = (v: unknown, def: number, max: number): number => {
  const n = typeof v === "number" && Number.isInteger(v) && v > 0 ? v : def;
  return Math.min(n, max);
};

async function getJson(deps: StakeholderDeps, path: string): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const params: ApiCallParams = { orgId: deps.account.orgId, userId: deps.account.userId, runId: await deps.runId() };
  const res = await (deps.fetch ?? ((p, prm) => apiServiceFetch(p, "GET", prm)))(path, params);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** Who a person is to us, compact (the list's full row is ~5k chars). */
export function personCard(p: Record<string, unknown>): Record<string, unknown> {
  return {
    personId: p.personId ?? null,
    name: p.displayName ?? null,
    company: p.company ?? null,
    emails: Array.isArray(p.emails) ? p.emails.slice(0, 4) : [],
    phones: Array.isArray(p.phones) ? p.phones.slice(0, 3) : [],
    state: p.state ?? null,
    stateDetail: p.stateDetail ?? null,
    tags: [...(Array.isArray(p.humanTags) ? p.humanTags : []), ...(Array.isArray(p.connectionTags) ? p.connectionTags : [])].slice(0, 8),
    sources: Array.isArray(p.sources) ? p.sources : [],
    firstActivityAt: p.firstActivityAt ?? null,
    lastActivityAt: p.lastActivityAt ?? null,
  };
}

/** One Unibox item, compact. */
export function timelineLine(i: Record<string, unknown>): Record<string, unknown> {
  const ev = i.event as { step?: unknown } | null | undefined;
  return {
    at: i.at ?? null,
    channel: i.channel ?? null,
    kind: i.kind ?? null,
    direction: i.direction ?? null,
    ...(ev && typeof ev.step === "string" ? { step: ev.step } : {}),
    ...(typeof i.subject === "string" && i.subject ? { subject: cut(i.subject, 160) } : {}),
    text: cut(i.text),
  };
}

export async function findStakeholders(args: Record<string, unknown>, deps: StakeholderDeps) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error(`[${FIND_STAKEHOLDERS_TOOL_NAME}] query is required`);
  const limit = clampInt(args.limit, 10, 25);
  const qs = new URLSearchParams({ brandId: deps.account.brandId, q: query, limit: String(limit) });
  const { status, json, text } = await getJson(deps, `/v1/orgs/people?${qs}`);
  if (status >= 400 || !json) throw new Error(`[${FIND_STAKEHOLDERS_TOOL_NAME}] people read ${status}: ${text.slice(0, 300)}`);
  const people = (Array.isArray(json.people) ? json.people : []) as Array<Record<string, unknown>>;
  return { query, total: json.total ?? people.length, people: people.map(personCard) };
}

/** Name a person for the timeline route: personId, else an identity key. */
function personQuery(args: Record<string, unknown>): URLSearchParams {
  const qs = new URLSearchParams();
  const id = typeof args.personId === "string" ? args.personId.trim() : "";
  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const phone = typeof args.phone === "string" ? args.phone.replace(/[^\d+]/g, "") : "";
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`[${READ_PERSON_UNIBOX_TOOL_NAME}] personId must be the id find_stakeholders gave`);
    qs.set("personId", id);
  } else if (email) qs.set("personKey", `email:${email}`);
  else if (phone) qs.set("personKey", `phone:${phone.startsWith("+") ? phone : `+${phone}`}`);
  else throw new Error(`[${READ_PERSON_UNIBOX_TOOL_NAME}] name the person: personId, email or phone`);
  return qs;
}

async function readTimeline(deps: StakeholderDeps, who: URLSearchParams, limit: number) {
  const qs = new URLSearchParams(who);
  qs.set("brandId", deps.account.brandId);
  qs.set("limit", String(limit));
  // API call logs are noise for knowing a person (one staff person carried 34k).
  qs.set("excludeSources", "api");
  const { status, json, text } = await getJson(deps, `/v1/orgs/people/timeline?${qs}`);
  if (status === 404) return null;
  if (status >= 400 || !json) throw new Error(`[${READ_PERSON_UNIBOX_TOOL_NAME}] timeline read ${status}: ${text.slice(0, 300)}`);
  return json;
}

export async function readPersonUnibox(args: Record<string, unknown>, deps: StakeholderDeps) {
  const limit = clampInt(args.limit, 40, 100);
  const json = await readTimeline(deps, personQuery(args), limit);
  if (!json) return { found: false, note: "No person of ours holds that id, email or phone." };
  const person = (json.person ?? null) as Record<string, unknown> | null;
  const items = (Array.isArray(json.items) ? json.items : []) as Array<Record<string, unknown>>;
  const page = json.page as { hasOlder?: boolean } | undefined;
  return {
    found: true,
    person: person ? personCard(person) : null,
    items: items.map(timelineLine),
    olderItemsExist: page?.hasOlder ?? false,
    totalItems: json.totalItems ?? items.length,
  };
}

/** People of one organization at most: each costs one timeline read. */
export const ORGANIZATION_PEOPLE_MAX = 8;

export async function readOrganizationUnibox(args: Record<string, unknown>, deps: StakeholderDeps) {
  const organization = typeof args.organization === "string" ? args.organization.trim() : "";
  if (!organization) throw new Error(`[${READ_ORGANIZATION_UNIBOX_TOOL_NAME}] organization is required (company name or domain)`);
  const limit = clampInt(args.limit, 60, 150);
  const found = await findStakeholders({ query: organization, limit: 25 }, deps);
  const needle = organization.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  // The search also matches words in messages: keep the people who speak for it (company or email domain).
  const members = found.people.filter((p) => {
    const company = typeof p.company === "string" ? p.company.toLowerCase() : "";
    const emails = (p.emails as unknown[]).filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase());
    return (company && (company.includes(needle) || needle.includes(company))) || emails.some((e) => e.endsWith(`@${needle}`) || e.split("@")[1]?.includes(needle));
  });
  const read = members.slice(0, ORGANIZATION_PEOPLE_MAX);
  const perPerson = Math.max(5, Math.ceil(limit / Math.max(1, read.length)));
  const threads = await Promise.all(
    read.map(async (p) => {
      if (typeof p.personId !== "string") return [];
      const json = await readTimeline(deps, new URLSearchParams({ personId: p.personId }), perPerson);
      const items = (json && Array.isArray(json.items) ? json.items : []) as Array<Record<string, unknown>>;
      return items.map((i): Record<string, unknown> => ({ person: p.name ?? p.personId, ...timelineLine(i) }));
    }),
  );
  const items = threads
    .flat()
    .sort((a, b) => String(a.at ?? "9999").localeCompare(String(b.at ?? "9999")))
    .slice(-limit);
  return {
    organization,
    people: members.map((p) => ({ ...p })),
    peopleRead: read.length,
    ...(members.length > read.length ? { note: `${members.length - read.length} more people not read: read_person_unibox for one of them.` } : {}),
    items,
  };
}
