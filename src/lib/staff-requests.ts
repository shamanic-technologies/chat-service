import { and, desc, eq, sql } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { staffRequests, type StaffRequest, type StaffRequestPiece } from "../db/schema.js";

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
  kind: "bug" | "feature";
  repo: string;
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
  const pieceKey = str("pieceKey", 80);
  if (!PIECE_KEY_RE.test(pieceKey)) {
    throw new StaffRequestValidationError(`pieceKey must be kebab-case (e.g. "linkedin-post-reaction-trigger")`);
  }
  const raw = args.decomposition;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new StaffRequestValidationError("decomposition must list every piece of the user's request with its outcome");
  }
  const decomposition: StaffRequestPiece[] = raw.map((p, i) => {
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
    title: str("title", 200),
    userRequest: str("userRequest", 4000),
    decomposition,
    missingPiece: str("missingPiece", 4000),
  };
}

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
    `## Missing piece (${row.kind})`,
    ``,
    row.missingPiece,
    ``,
    `## The request, decomposed`,
    ``,
    `| Piece | Outcome | Detail |`,
    `|---|---|---|`,
    ...row.decomposition.map(
      (p) => `| ${p.piece.replace(/\|/g, "\\|")} | ${p.outcome} | ${(p.detail ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
    ),
    ``,
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

export function buildTelegramMessage(row: StaffRequest, requesterEmail: string | null): string {
  const e = escapeTelegramHtml;
  return [
    `🛠 <b>Copilot ${row.kind === "bug" ? "bug report" : "feature request"}</b> · ${e(row.repo)}`,
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
          eq(staffRequests.repo, input.repo),
          eq(staffRequests.kind, input.kind),
          eq(staffRequests.pieceKey, input.pieceKey),
        ),
      )
      .returning();
    row = bumped;
  } else {
    row = inserted[0];
  }

  // 2. Issue — once per row; a repeat retries only while none exists.
  if (!row.issueUrl) {
    try {
      const prefix = input.kind === "bug" ? "[Copilot bug]" : "[Copilot feature]";
      const issue = await deps.openGithubIssue(row.repo, `${prefix} ${row.title}`, buildIssueBody(row));
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
  if (!duplicate) {
    if (requesterIsStaff) {
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
    duplicate,
    requestCount: row.requestCount,
    issueUrl: row.issueUrl,
    issueError: row.issueUrl ? null : row.issueError,
    staffPinged,
    telegramSkippedReason: row.telegramSkippedReason,
    telegramError: row.telegramError,
  };
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
