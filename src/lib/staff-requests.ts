import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { staffRequests, type StaffRequest, type StaffRequestKind, type StaffRequestPiece } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Staff requests — what the Copilot does when a piece of the user's ask needs
// CODE (no tool, no route, no data switch can do it).
//
// Order is load-bearing:
//   1. RECORD the request (durable row, deduped per org on repo+kind+pieceKey);
//   2. OPEN a GitHub issue in the repo of the service that owns the missing
//      piece (once per row; retried on a later repeat while it has none);
//   3. PING staff on Telegram (same bot/chat as billing-service and the
//      dashboard), SKIPPED when the requester is staff: staff alerts never
//      report staff's own actions. Pinged once per row, never on a repeat.
// A failure in 2 or 3 is stored on the row, logged, and returned to the model:
// the request is never lost because a side channel was down.
//
// Four kinds, each reaching someone who acts (an issue is never filed alone):
//   bug, feature    -> issue in the owning repo + Telegram to staff
//   skill_upgrade   -> issue in chat-service (skills are its rows; staff edit
//                      them live) or in the service whose doc is wrong, with
//                      the proposed text + Telegram
//   contact_human   -> NO issue (a person, not a codebase): Telegram to the
//                      owner straight away; one ping per org per
//                      CONTACT_PING_WINDOW_MS so a looping model cannot spam.
// ---------------------------------------------------------------------------

type Database = typeof Db;

const GITHUB_OWNER = "shamanic-technologies";

/**
 * Repos a staff request may target: the fleet's GitHub repo names. A name not
 * here is refused (the model must not invent a repo). Note the qualification /
 * leads service lives in `sales-lead-service`.
 */
export const STAFF_REQUEST_REPOS = [
  "api-service",
  "apollo-service",
  "billing-service",
  "brand-service",
  "campaign-service",
  "chat-service",
  "client-service",
  "content-generation-service",
  "costs-service",
  "crm-service",
  "distribute.you",
  "email-gateway-service",
  "features-service",
  "google-service",
  "human-service",
  "instantly-service",
  "key-service",
  "outlets-service",
  "postmark-service",
  "replies-service",
  "runs-service",
  "sales-lead-service",
  "scraping-service",
  "social-service",
  "stripe-service",
  "telegram-service",
  "transactional-email-service",
  "twillio-service",
  "workflow-service",
] as const;

export type StaffRequestRepo = (typeof STAFF_REQUEST_REPOS)[number];

export const PIECE_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Staff, mirrored from api-service `src/lib/staff.ts` (STAFF_EMAILS) plus any
 * `@distribute.you` address, plus-addressing ignored — the same rule as
 * billing-service `isStaffEmail`.
 */
const STAFF_EMAILS = new Set(["kevin.lourd@gmail.com", "kevin@distribute.you"]);
const STAFF_DOMAIN = "@distribute.you";

export function isStaffEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.endsWith(STAFF_DOMAIN)) return true;
  const [local, domain] = normalized.split("@");
  return STAFF_EMAILS.has(`${local.split("+")[0]}@${domain}`);
}

export class StaffRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffRequestValidationError";
  }
}

export interface StaffRequestInput {
  kind: StaffRequestKind;
  /** null only for contact_human. */
  repo: string | null;
  pieceKey: string;
  title: string;
  userRequest: string;
  decomposition: StaffRequestPiece[];
  missingPiece: string;
}

const OUTCOMES = new Set(["exists", "create", "needs_code"]);

export function parseStaffRequestArgs(args: Record<string, unknown>): StaffRequestInput {
  const str = (name: string, max: number): string => {
    const v = args[name];
    if (typeof v !== "string" || v.trim() === "") throw new StaffRequestValidationError(`${name} is required`);
    if (v.length > max) throw new StaffRequestValidationError(`${name} must be at most ${max} characters`);
    return v.trim();
  };
  const kind = args.kind;
  if (kind !== "bug" && kind !== "feature") throw new StaffRequestValidationError(`kind must be "bug" or "feature"`);
  const repo = str("repo", 100);
  if (!(STAFF_REQUEST_REPOS as readonly string[]).includes(repo)) {
    throw new StaffRequestValidationError(`repo "${repo}" is not a fleet repo. Use one of: ${STAFF_REQUEST_REPOS.join(", ")}`);
  }
  const title = str("title", 200);
  // pieceKey is the dedupe key: optional, derived from the title when absent.
  const pieceKey = args.pieceKey === undefined || args.pieceKey === null ? pieceKeyOf(title) : str("pieceKey", 80);
  if (!PIECE_KEY_RE.test(pieceKey)) {
    throw new StaffRequestValidationError(`pieceKey must be kebab-case (e.g. "linkedin-post-reaction-trigger")`);
  }
  const raw = args.decomposition;
  // Optional (no friction for a plain bug or feature); when sent, every piece needs an outcome.
  if (raw !== undefined && raw !== null && (!Array.isArray(raw) || raw.length === 0)) {
    throw new StaffRequestValidationError("decomposition, when sent, must list every piece of the user's request with its outcome");
  }
  const decomposition: StaffRequestPiece[] = ((raw ?? []) as unknown[]).map((p, i) => {
    const o = (p ?? {}) as Record<string, unknown>;
    if (typeof o.piece !== "string" || o.piece.trim() === "") {
      throw new StaffRequestValidationError(`decomposition[${i}].piece is required`);
    }
    if (typeof o.outcome !== "string" || !OUTCOMES.has(o.outcome)) {
      throw new StaffRequestValidationError(`decomposition[${i}].outcome must be exists | create | needs_code`);
    }
    return {
      piece: o.piece.trim(),
      outcome: o.outcome as StaffRequestPiece["outcome"],
      ...(typeof o.detail === "string" && o.detail.trim() ? { detail: o.detail.trim() } : {}),
    };
  });
  return {
    kind,
    repo,
    pieceKey,
    title,
    userRequest: str("userRequest", 4000),
    decomposition,
    missingPiece: str("missingPiece", 4000),
  };
}

/** A stable kebab-case dedupe key from free text (max 80 chars). */
export function pieceKeyOf(text: string): string {
  const k = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  if (!k) throw new StaffRequestValidationError("title must contain letters or digits");
  return k;
}

function text(args: Record<string, unknown>, name: string, max: number): string {
  const v = args[name];
  if (typeof v !== "string" || v.trim() === "") throw new StaffRequestValidationError(`${name} is required`);
  if (v.length > max) throw new StaffRequestValidationError(`${name} must be at most ${max} characters`);
  return v.trim();
}

/**
 * request_skill_upgrade: a skill (chat-service row) or a service's own doc is
 * wrong, stale or too thin. A skill goes to chat-service; a service doc to the
 * repo of that service. `skillSlug` existence is checked by the caller (DB).
 */
export function parseSkillUpgradeArgs(args: Record<string, unknown>): StaffRequestInput & { skillSlug: string | null } {
  const skillSlug = typeof args.skillSlug === "string" && args.skillSlug.trim() ? args.skillSlug.trim() : null;
  const docRepo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : null;
  if (!skillSlug && !docRepo) {
    throw new StaffRequestValidationError("name what to upgrade: skillSlug (a skill) or repo (the service whose doc is wrong)");
  }
  if (skillSlug && docRepo) throw new StaffRequestValidationError("send skillSlug OR repo, not both");
  if (docRepo && !(STAFF_REQUEST_REPOS as readonly string[]).includes(docRepo)) {
    throw new StaffRequestValidationError(`repo "${docRepo}" is not a fleet repo. Use one of: ${STAFF_REQUEST_REPOS.join(", ")}`);
  }
  const title = text(args, "title", 200);
  const problem = text(args, "problem", 4000);
  const proposedChange = text(args, "proposedChange", 8000);
  const target = skillSlug ? `skill \`${skillSlug}\`` : `the ${docRepo} docs (openapi descriptions, README)`;
  return {
    kind: "skill_upgrade",
    repo: skillSlug ? "chat-service" : docRepo,
    pieceKey: pieceKeyOf(`${skillSlug ? `skill-${skillSlug}` : "docs"}-${title}`),
    title,
    userRequest: typeof args.userRequest === "string" && args.userRequest.trim() ? args.userRequest.trim().slice(0, 4000) : "(raised by the agent itself)",
    decomposition: [],
    missingPiece: `Upgrade ${target}.\n\n**What is wrong:** ${problem}\n\n**Proposed change:**\n\n${proposedChange}`,
    skillSlug,
  };
}

export const CONTACT_URGENCIES = ["normal", "urgent"] as const;

/** contact_human: the user wants a person. No repo, no issue: a Telegram ping to the owner. */
export function parseContactHumanArgs(args: Record<string, unknown>): StaffRequestInput & { urgency: (typeof CONTACT_URGENCIES)[number] } {
  const urgency = args.urgency === undefined || args.urgency === null ? "normal" : args.urgency;
  if (!(CONTACT_URGENCIES as readonly unknown[]).includes(urgency)) {
    throw new StaffRequestValidationError(`urgency must be one of ${CONTACT_URGENCIES.join(", ")}`);
  }
  const reason = text(args, "reason", 200);
  return {
    kind: "contact_human",
    repo: null,
    pieceKey: pieceKeyOf(reason),
    title: reason,
    userRequest: text(args, "message", 4000),
    decomposition: [],
    missingPiece: `The user asked to talk to a person${urgency === "urgent" ? " (URGENT)" : ""}.`,
    urgency: urgency as (typeof CONTACT_URGENCIES)[number],
  };
}

/** One contact_human ping per org inside this window; later ones are recorded, not re-pinged. */
export const CONTACT_PING_WINDOW_MS = 10 * 60_000;

// --- requester email (client-service) ---------------------------------------

export async function fetchRequesterEmail(userId: string): Promise<string | null> {
  const url = process.env.CLIENT_SERVICE_URL;
  const key = process.env.CLIENT_SERVICE_API_KEY;
  if (!url || !key) throw new Error("CLIENT_SERVICE_URL / CLIENT_SERVICE_API_KEY not configured");
  const res = await fetch(`${url}/internal/users/${encodeURIComponent(userId)}`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`client-service ${res.status}: ${await res.text().catch(() => "")}`);
  const body = (await res.json()) as { user?: { email?: string | null } };
  return body.user?.email ?? null;
}

// --- GitHub ------------------------------------------------------------------

export function buildIssueBody(row: StaffRequest): string {
  const lines = [
    `**Raised by the Copilot chat** for org \`${row.orgId}\`${row.brandId ? `, brand \`${row.brandId}\`` : ""}, user \`${row.userId}\`${row.requesterIsStaff ? " (staff)" : ""}.`,
    ``,
    `## What the user asked`,
    ``,
    `> ${row.userRequest.replace(/\n/g, "\n> ")}`,
    ``,
    row.kind === "skill_upgrade" ? `## Upgrade` : `## Missing piece (${row.kind})`,
    ``,
    row.missingPiece,
    ``,
    ...(row.decomposition.length
      ? [
          `## The request, decomposed`,
          ``,
          `| Piece | Outcome | Detail |`,
          `|---|---|---|`,
          ...row.decomposition.map(
            (p) => `| ${p.piece.replace(/\|/g, "\\|")} | ${p.outcome} | ${(p.detail ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
          ),
          ``,
        ]
      : []),
    `---`,
    `chat-service staff request \`${row.id}\` · piece \`${row.pieceKey}\`${row.sessionId ? ` · session \`${row.sessionId}\`` : ""}.`,
    `When this ships, the Copilot can switch the piece on for the user.`,
  ];
  return lines.join("\n");
}

export async function openGithubIssue(
  repo: string,
  title: string,
  body: string,
): Promise<{ url: string; number: number }> {
  const token = process.env.GITHUB_ISSUES_TOKEN;
  if (!token) throw new Error("GITHUB_ISSUES_TOKEN not configured");
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${encodeURIComponent(repo)}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      "user-agent": "chat-service",
    },
    // No labels: a label absent from the repo needs more than issues:write.
    body: JSON.stringify({ title, body }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as { html_url?: string; number?: number; message?: string } | null;
  if (!res.ok || !json?.html_url || typeof json.number !== "number") {
    throw new Error(`github ${res.status}: ${json?.message ?? "no body"}`);
  }
  return { url: json.html_url, number: json.number };
}

// --- Telegram (same bot/chat as billing-service + dashboard) -----------------

export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendStaffTelegram(html: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim();
  if (!token || !chatId) return { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || body?.ok !== true) return { ok: false, error: `telegram ${res.status}: ${body?.description ?? "no body"}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const KIND_LABELS: Record<StaffRequestKind, string> = {
  bug: "🛠 <b>Copilot bug report</b>",
  feature: "🛠 <b>Copilot feature request</b>",
  skill_upgrade: "📚 <b>Copilot skill/doc upgrade</b>",
  contact_human: "🙋 <b>A user asks for a human</b>",
};

export function buildTelegramMessage(row: StaffRequest, requesterEmail: string | null): string {
  const e = escapeTelegramHtml;
  if (row.kind === "contact_human") {
    return [
      `${KIND_LABELS.contact_human}${row.missingPiece.includes("URGENT") ? " · <b>URGENT</b>" : ""}`,
      `<b>${e(row.title)}</b>`,
      `Message: ${e(row.userRequest.slice(0, 1500))}`,
      `From: ${e(requesterEmail ?? row.userId)} · org ${e(row.orgId)}${row.brandId ? ` · brand ${e(row.brandId)}` : ""}`,
      row.sessionId ? `Chat session: ${e(row.sessionId)}` : `Chat session: none`,
    ].join("\n");
  }
  return [
    `${KIND_LABELS[row.kind]} · ${e(row.repo ?? "no repo")}`,
    `<b>${e(row.title)}</b>`,
    `User asked: ${e(row.userRequest.slice(0, 500))}`,
    `Missing: ${e(row.missingPiece.slice(0, 500))}`,
    `From: ${e(requesterEmail ?? row.userId)} · org ${e(row.orgId)}`,
    row.issueUrl ? `Issue: ${e(row.issueUrl)}` : `Issue: not opened (${e(row.issueError ?? "unknown")})`,
  ].join("\n");
}

// --- submit ------------------------------------------------------------------

export interface StaffRequestContext {
  orgId: string;
  userId: string;
  brandId: string | null;
  sessionId: string | null;
}

export interface StaffRequestDeps {
  fetchRequesterEmail: (userId: string) => Promise<string | null>;
  openGithubIssue: typeof openGithubIssue;
  sendStaffTelegram: typeof sendStaffTelegram;
}

const DEFAULT_DEPS: StaffRequestDeps = { fetchRequesterEmail, openGithubIssue, sendStaffTelegram };

export interface StaffRequestResult {
  requestId: string;
  kind: StaffRequestKind;
  /** Where it landed, in words the model can repeat ("GitHub issue + Telegram"). */
  destination: string;
  duplicate: boolean;
  requestCount: number;
  issueUrl: string | null;
  issueError: string | null;
  staffPinged: boolean;
  telegramSkippedReason: string | null;
  telegramError: string | null;
}

export async function submitStaffRequest(
  database: Database,
  ctx: StaffRequestContext,
  input: StaffRequestInput,
  deps: StaffRequestDeps = DEFAULT_DEPS,
): Promise<StaffRequestResult> {
  // Who asked: staff or not (decides the Telegram ping). A lookup failure is
  // recorded and the ping still goes out — a duplicate alert beats a lost one.
  let requesterEmail: string | null = null;
  let lookupError: string | null = null;
  try {
    requesterEmail = await deps.fetchRequesterEmail(ctx.userId);
  } catch (err) {
    lookupError = err instanceof Error ? err.message : String(err);
    console.error(`[staff-request] requester lookup failed for user="${ctx.userId}": ${lookupError}`);
  }
  const requesterIsStaff = isStaffEmail(requesterEmail);
  const isContact = input.kind === "contact_human";
  if (!isContact && !input.repo) throw new StaffRequestValidationError(`${input.kind} needs a repo`);

  // 1. Record (dedupe per org on repo + kind + pieceKey).
  const inserted = await database
    .insert(staffRequests)
    .values({
      orgId: ctx.orgId,
      userId: ctx.userId,
      brandId: ctx.brandId,
      sessionId: ctx.sessionId,
      kind: input.kind,
      repo: input.repo,
      pieceKey: input.pieceKey,
      title: input.title,
      userRequest: input.userRequest,
      decomposition: input.decomposition,
      missingPiece: input.missingPiece,
      requesterIsStaff,
    })
    .onConflictDoNothing({
      target: [staffRequests.orgId, staffRequests.repo, staffRequests.kind, staffRequests.pieceKey],
    })
    .returning();

  let row: StaffRequest;
  const duplicate = inserted.length === 0;
  if (duplicate) {
    const [bumped] = await database
      .update(staffRequests)
      .set({ requestCount: sql`${staffRequests.requestCount} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(staffRequests.orgId, ctx.orgId),
          eq(staffRequests.repo, input.repo as string),
          eq(staffRequests.kind, input.kind),
          eq(staffRequests.pieceKey, input.pieceKey),
        ),
      )
      .returning();
    row = bumped;
  } else {
    row = inserted[0];
  }

  // 2. Issue — once per row; a repeat retries only while none exists. A
  //    contact_human reaches a person, not a codebase: no issue.
  if (!isContact && !row.issueUrl) {
    try {
      const prefix = ISSUE_PREFIXES[input.kind as Exclude<StaffRequestKind, "contact_human">];
      const issue = await deps.openGithubIssue(row.repo as string, `${prefix} ${row.title}`, buildIssueBody(row));
      [row] = await database
        .update(staffRequests)
        .set({ issueUrl: issue.url, issueNumber: issue.number, issueError: null, updatedAt: new Date() })
        .where(eq(staffRequests.id, row.id))
        .returning();
    } catch (err) {
      const issueError = err instanceof Error ? err.message : String(err);
      console.error(`[staff-request] issue NOT opened for request="${row.id}" repo="${row.repo}": ${issueError}`);
      [row] = await database
        .update(staffRequests)
        .set({ issueError, updatedAt: new Date() })
        .where(eq(staffRequests.id, row.id))
        .returning();
    }
  }

  // 3. Telegram — first time only, never for staff's own requests.
  let staffPinged = false;
  const recentContactPing = isContact && !requesterIsStaff ? await hasRecentContactPing(database, ctx.orgId, row.id) : false;
  if (!duplicate) {
    if (recentContactPing) {
      [row] = await database
        .update(staffRequests)
        .set({ telegramSkippedReason: "recent_contact_already_pinged", updatedAt: new Date() })
        .where(eq(staffRequests.id, row.id))
        .returning();
    } else if (requesterIsStaff) {
      [row] = await database
        .update(staffRequests)
        .set({ telegramSkippedReason: "requester_is_staff", updatedAt: new Date() })
        .where(eq(staffRequests.id, row.id))
        .returning();
    } else {
      const sent = await deps.sendStaffTelegram(
        buildTelegramMessage(row, requesterEmail ?? (lookupError ? `${ctx.userId} (email lookup failed)` : null)),
      );
      if (sent.ok) {
        staffPinged = true;
        [row] = await database
          .update(staffRequests)
          .set({ telegramSentAt: new Date(), telegramError: null, updatedAt: new Date() })
          .where(eq(staffRequests.id, row.id))
          .returning();
      } else {
        console.error(`[staff-request] Telegram ping failed for request="${row.id}": ${sent.error}`);
        [row] = await database
          .update(staffRequests)
          .set({ telegramError: sent.error, updatedAt: new Date() })
          .where(eq(staffRequests.id, row.id))
          .returning();
      }
    }
  }

  return {
    requestId: row.id,
    kind: row.kind,
    destination: isContact
      ? "Telegram to the team (the owner reads it on his phone)"
      : `GitHub issue in ${row.repo} + Telegram to the team`,
    duplicate,
    requestCount: row.requestCount,
    issueUrl: row.issueUrl,
    issueError: row.issueUrl ? null : row.issueError,
    staffPinged,
    telegramSkippedReason: row.telegramSkippedReason,
    telegramError: row.telegramError,
  };
}

const ISSUE_PREFIXES: Record<Exclude<StaffRequestKind, "contact_human">, string> = {
  bug: "[Copilot bug]",
  feature: "[Copilot feature]",
  skill_upgrade: "[Copilot skill upgrade]",
};

/** Did this org already ping a human in the last CONTACT_PING_WINDOW_MS (another row)? */
async function hasRecentContactPing(database: Database, orgId: string, exceptId: string): Promise<boolean> {
  const since = new Date(Date.now() - CONTACT_PING_WINDOW_MS);
  const rows = await database
    .select({ id: staffRequests.id })
    .from(staffRequests)
    .where(
      and(
        eq(staffRequests.orgId, orgId),
        eq(staffRequests.kind, "contact_human"),
        gte(staffRequests.telegramSentAt, since),
        ne(staffRequests.id, exceptId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function listStaffRequests(
  database: Database,
  opts: { orgId?: string; limit: number },
): Promise<StaffRequest[]> {
  const q = database.select().from(staffRequests);
  const filtered = opts.orgId ? q.where(eq(staffRequests.orgId, opts.orgId)) : q;
  return filtered.orderBy(desc(staffRequests.updatedAt)).limit(opts.limit);
}

export function toStaffRequestBody(r: StaffRequest) {
  return {
    ...r,
    telegramSentAt: r.telegramSentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** What `list_staff_requests` returns to the model (this org only, compact). */
export async function listStaffRequestsForModel(database: Database, orgId: string) {
  const rows = await listStaffRequests(database, { orgId, limit: 50 });
  return {
    requests: rows.map((r) => ({
      requestId: r.id,
      kind: r.kind,
      repo: r.repo,
      pieceKey: r.pieceKey,
      title: r.title,
      issueUrl: r.issueUrl,
      requestCount: r.requestCount,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
