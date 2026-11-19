// ---------------------------------------------------------------------------
// A guest's plan, built BEFORE any account (DISTRY-ONE-AI-1118 increment B,
// owner plan 2026-11-19). The access ladder, the same on every channel and
// refused by the server, never by the prompt:
//
//   1. unknown person: everything public;
//   2. they gave their website: the SAME unclaimed org the signup page opens
//      (client-service /internal/resolve `anonymous: true`, billing trial-seed,
//      brand-service domain claim check), opened for THIS conversation, on
//      which the assistant builds their plan: brand, offer, who to reach,
//      sample companies, a sample email;
//   3. email proven by code: that org becomes theirs (client-service
//      agent-signups/complete with claimOrgId + claimOrgExternalId).
//
// What a guest may do on that org is the signup page's own allowlist
// (dashboard `anon-proxy-allowlist.ts`), mirrored below and checked on every
// gateway call before it leaves. Anything that spends past the plan, pays,
// starts or sends waits for the sign-in.
//
// Money: the plan's gateway spend (reading their site, drafting offers, the
// sample email) is billed to the unclaimed org's own trial seed, exactly as
// the signup page's walk; never to our own org. The chat turn itself stays on
// our line, as every guest turn (bounded by the website guard).
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { ApiCallParams } from "./api-client.js";

/** The throwaway external org id prefix: the signup page's own (`anon_<uuid v4>`). */
export const PLAN_ORG_PREFIX = "anon_";
/** The system principal an unclaimed org is opened with: the signup page's own. */
export const PLAN_PRINCIPAL = "system-anonymous-onboarding";
/** The runs-service task of the plan's work on the unclaimed org. */
export const PLAN_TASK_NAME = "copilot-guest-plan";

/** What the session holds of a guest's plan (sessions.plan_* columns). */
export interface PlanOrg {
  orgId: string;
  userId: string;
  /** The throwaway external id we minted: proof we opened it, sent with the email proof. Never shown. */
  externalOrgId: string;
  brandId: string | null;
  domain: string | null;
}

// --- The signup page's allowlist, mirrored (dashboard anon-proxy-allowlist.ts) ---

interface Rule {
  method: string;
  /** `:brand` = the plan's brand; `:seg` = any one segment. Paths as the gateway spells them after `/v1`. */
  segments: string[];
  /** A query parameter that must name the plan's brand. */
  queryBrand?: string;
}

const RULES: readonly Rule[] = [
  { method: "POST", segments: ["brands"] },
  { method: "GET", segments: ["brands", ":brand"] },
  { method: "POST", segments: ["brands", "extract-fields"] },
  { method: "GET", segments: ["brands", ":brand", "user-fields"] },
  { method: "PUT", segments: ["brands", ":brand", "user-fields"] },
  { method: "GET", segments: ["brands", ":brand", "offers"] },
  { method: "PUT", segments: ["brands", ":brand", "click-destination"] },
  { method: "PUT", segments: ["brands", ":brand", "business-context"] },
  { method: "POST", segments: ["brands", ":brand", "icp", "suggest"] },
  { method: "POST", segments: ["brands", ":brand", "offers", "proposals"] },
  { method: "POST", segments: ["brands", ":brand", "offers", "confirm"] },
  { method: "PUT", segments: ["brands", ":brand", "offers", ":seg", "economics"] },
  { method: "PUT", segments: ["brands", ":brand", "offers", ":seg", "user-fields"] },
  { method: "GET", segments: ["brands", ":brand", "offers", ":seg", "qualification", "criteria"] },
  { method: "POST", segments: ["brands", ":brand", "offers", ":seg", "qualification", "suggestions"] },
  { method: "PATCH", segments: ["brands", ":brand", "offers", ":seg", "qualification", "criteria", ":seg"] },
  { method: "POST", segments: ["brands", ":brand", "offers", ":seg", "qualification", "previews"] },
  { method: "GET", segments: ["brands", ":brand", "offers", ":seg", "qualification", "previews", ":seg"] },
  { method: "GET", segments: ["offers", ":seg", "sales-funnels"], queryBrand: "brandId" },
  { method: "GET", segments: ["orgs", "audiences"] },
  { method: "POST", segments: ["orgs", "audiences", "suggest"] },
  { method: "POST", segments: ["orgs", "audiences", "split"] },
  { method: "POST", segments: ["orgs", "audiences", "split", "confirm"] },
  { method: "POST", segments: ["orgs", "audiences", "split", "estimate"] },
  // The free sample of who an audience reaches, as an account reads it (the new-account skill's
  // step 5). The page reads its sibling `/preview/companies`; both are free reads that send nothing.
  { method: "GET", segments: ["orgs", "audiences", ":seg", "preview"] },
  { method: "GET", segments: ["orgs", "audiences", ":seg", "preview", "companies"] },
  { method: "POST", segments: ["orgs", "audiences", ":seg", "preview", "companies", ":seg", "email-check"] },
  { method: "POST", segments: ["content", "preview-email"] },
  { method: "POST", segments: ["content", "preview-email", "prepare"] },
  { method: "POST", segments: ["features", "unit-reports"] },
  { method: "GET", segments: ["features", ":seg"] },
  { method: "GET", segments: ["features", ":seg", "workflow-projection"] },
];

/** POST bodies that name a brand: it must be the plan's (dashboard `anonBodyRefusal`). */
const BODY_BRAND_PATHS = new Set([
  "/orgs/audiences/suggest",
  "/orgs/audiences/split",
  "/orgs/audiences/split/confirm",
  "/orgs/audiences/split/estimate",
  "/content/preview-email",
  "/content/preview-email/prepare",
]);

export type PlanRefusalReason = "needs_account" | "other_brand";

/**
 * PURE. Whether the plan's org may make this gateway call. `path` as
 * apiServiceFetch gets it (`/v1/...?query`). Null = allowed.
 */
export function planCallRefusal(method: string, path: string, body: unknown, brandId: string | null): PlanRefusalReason | null {
  const upper = method.toUpperCase();
  const [rawPath, rawQuery = ""] = path.split("?");
  if (!rawPath.startsWith("/v1/")) return "needs_account";
  const rel = rawPath.slice(3).replace(/\/+$/, "");
  const given = rel.split("/").filter((s) => s.length > 0);
  if (given.length === 0 || given.some((s) => s === "." || s === ".." || s.includes("\\"))) return "needs_account";
  const owned = brandId ?? "";
  let wrongBrand = false;
  let allowed = false;
  for (const rule of RULES) {
    if (rule.method !== upper || rule.segments.length !== given.length) continue;
    let matched = true;
    let mismatch = false;
    rule.segments.forEach((want, i) => {
      if (!matched) return;
      if (want === ":brand") {
        if (!owned || decodeURIComponent(given[i]) !== owned) mismatch = true;
      } else if (want !== ":seg" && want !== given[i]) {
        matched = false;
      }
    });
    if (!matched) continue;
    if (rule.queryBrand && (!owned || new URLSearchParams(rawQuery).get(rule.queryBrand) !== owned)) mismatch = true;
    if (mismatch) {
      wrongBrand = true;
      continue;
    }
    allowed = true;
    break;
  }
  if (!allowed) return wrongBrand ? "other_brand" : "needs_account";
  if (upper === "POST" && (BODY_BRAND_PATHS.has(rel) || rel === "/brands/extract-fields")) {
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    if (!owned || !rec) return "other_brand";
    if (rel === "/brands/extract-fields") {
      const ids = rec.brandIds;
      return Array.isArray(ids) && ids.length > 0 && ids.every((id) => id === owned) ? null : "other_brand";
    }
    return rec.brandId === owned ? null : "other_brand";
  }
  return null;
}

/** A plan call the server refused: reaches the model as a result it can say, never a crash. */
export class PlanRefusal extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanRefusal";
  }

  toResult(): Record<string, unknown> {
    return { ok: false, refused: true, reason: this.reason, message: this.message };
  }
}

const NEEDS_ACCOUNT =
  "Before their account, only their plan is built here: their brand from their website, what they sell, who to reach, sample companies and a sample email. This step needs their account: sign them in (start_sign_in), the plan you built becomes theirs.";
const OTHER_BRAND = "Before their account, this conversation works on one brand only: the one opened from their website.";

/** The guard of a plan call (ApiCallParams.guard): throws the refusal before the call leaves. */
export function planGuard(brandId: string | null): (method: string, path: string, body: unknown) => void {
  return (method, path, body) => {
    const reason = planCallRefusal(method, path, body, brandId);
    if (reason === "needs_account") throw new PlanRefusal(reason, NEEDS_ACCOUNT);
    if (reason === "other_brand") throw new PlanRefusal(reason, OTHER_BRAND);
  };
}

/** PURE: the website's domain (`acme.com`), or null when it is not one. */
export function websiteDomain(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const raw = url.trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !host.endsWith(".") ? host : null;
  } catch {
    return null;
  }
}

// --- Opening the unclaimed org: the signup page's own producer routes ---------

export interface PlanOpenDeps {
  fetchImpl: typeof fetch;
}

const defaultOpenDeps: PlanOpenDeps = { fetchImpl: fetch };

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[guest-plan] ${name} not configured`);
  return v;
}

async function postJson(url: string, key: string, body: unknown, deps: PlanOpenDeps, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await deps.fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, ...extraHeaders },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/**
 * brand-service: does an org already own this domain? Asked BEFORE anything is
 * created (the signup page's order). "unknown" (could not ask) is refused like
 * "claimed": a stranger never starts spending on a customer's domain.
 */
export async function domainClaim(domain: string, deps: PlanOpenDeps = defaultOpenDeps): Promise<"claimed" | "unclaimed" | "unknown"> {
  try {
    const { status, json } = await postJson(`${env("BRAND_SERVICE_URL")}/internal/brands/domain-claimed`, env("BRAND_SERVICE_API_KEY"), { domain }, deps);
    if (status !== 200 || typeof json.claimed !== "boolean") {
      console.error(`[guest-plan] domain-claimed answered ${status}: ${JSON.stringify(json).slice(0, 300)}`);
      return "unknown";
    }
    return json.claimed ? "claimed" : "unclaimed";
  } catch (err) {
    console.error(`[guest-plan] domain-claimed unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return "unknown";
  }
}

/**
 * client-service /internal/resolve with `anonymous: true`: the org comes into
 * being without an identity provider (what makes it claimable), with the
 * acquisition handed over at opening (the claim keeps the uuid, so the touch
 * survives signup).
 */
export async function openUnclaimedOrg(
  externalOrgId: string,
  acquisition: { channel: string; landingPath?: string },
  deps: PlanOpenDeps = defaultOpenDeps,
): Promise<{ orgId: string; userId: string }> {
  const { status, json } = await postJson(
    `${env("CLIENT_SERVICE_URL")}/internal/resolve`,
    env("CLIENT_SERVICE_API_KEY"),
    { externalOrgId, externalUserId: PLAN_PRINCIPAL, anonymous: true, acquisition },
    deps,
  );
  if (status < 200 || status >= 300 || typeof json.orgId !== "string" || typeof json.userId !== "string") {
    throw new Error(`[guest-plan] client-service resolve (anonymous) ${status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { orgId: json.orgId, userId: json.userId };
}

/** billing-service trial-seed: the signup page's advance. Until it lands the org can do nothing, so a failure fails the opening. */
export async function seedTrialCredit(orgId: string, deps: PlanOpenDeps = defaultOpenDeps): Promise<void> {
  const { status, json } = await postJson(
    `${env("BILLING_SERVICE_URL")}/internal/accounts/by-org/${encodeURIComponent(orgId)}/trial-seed`,
    env("BILLING_SERVICE_API_KEY"),
    {},
    deps,
  );
  if (status < 200 || status >= 300) throw new Error(`[guest-plan] billing trial-seed ${status}: ${JSON.stringify(json).slice(0, 300)}`);
}

/** A run under the plan's org: the plan's spend is declared on it (never on our line's run). */
export async function createPlanRun(identity: { orgId: string; userId: string }, deps: PlanOpenDeps = defaultOpenDeps): Promise<string> {
  const res = await deps.fetchImpl(`${process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org"}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env("RUNS_SERVICE_API_KEY"), "x-org-id": identity.orgId, "x-user-id": identity.userId },
    body: JSON.stringify({ serviceName: "chat-service", taskName: PLAN_TASK_NAME }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`[guest-plan] runs-service create run ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error("[guest-plan] runs-service create run answered without id");
  return json.id;
}

// --- A guest's gateway call ------------------------------------------------------

export interface GuestPlanDeps {
  /** The session's plan, as stored now. */
  readPlan: () => Promise<PlanOrg | null>;
  /** Stores the plan on the session (open, then its brand). */
  savePlan: (plan: PlanOrg) => Promise<void>;
  domainClaim: (domain: string) => Promise<"claimed" | "unclaimed" | "unknown">;
  openOrg: (externalOrgId: string) => Promise<{ orgId: string; userId: string }>;
  seedTrial: (orgId: string) => Promise<void>;
  /** One run per turn under the plan's org (the caller memoizes it). */
  runFor: (identity: { orgId: string; userId: string }) => Promise<string>;
  /** The call itself, as an account makes it (catalogue-tools `callApi` with these params). */
  call: (params: ApiCallParams) => Promise<unknown>;
}

/** The request a run_operation names, as far as the plan needs it: is it the brand creation, and for which website? */
export interface PlanRequest {
  method: string;
  /** The gateway path template or concrete path (`/v1/brands`). */
  path: string;
  body: unknown;
}

function isBrandCreate(req: PlanRequest): boolean {
  return req.method.toUpperCase() === "POST" && req.path.split("?")[0].replace(/\/+$/, "") === "/v1/brands";
}

/** The brand id a POST /v1/brands answer carries (gateway `{brandId, domain, name, created}`, maybe wrapped by answerForModel). */
export function brandIdOf(result: unknown): string | null {
  const r = result as { ok?: unknown; data?: { brandId?: unknown }; brandId?: unknown } | null;
  if (!r || typeof r !== "object") return null;
  if (typeof r.brandId === "string") return r.brandId;
  if (r.ok === true && r.data && typeof r.data.brandId === "string") return r.data.brandId;
  return null;
}

const CLAIMED =
  "This website is already set up with an account at distribute.you, so no plan is opened for it here. Say so plainly, without naming anyone, and offer to sign them in (start_sign_in) to reach that account.";
const CANNOT_CHECK =
  "We could not check whether this website already has an account, so nothing was opened. Say it plainly: try again in a moment, or sign them up or in now (their account can add the website).";

/**
 * Runs one gateway call of a guest's plan. Opens the conversation's unclaimed
 * org on the brand creation (once: reused on every later turn), then makes the
 * call AS that org, through the guard. A refusal comes back as a result.
 */
export async function runGuestPlanCall(req: PlanRequest, deps: GuestPlanDeps): Promise<unknown> {
  try {
    let plan = await deps.readPlan();
    if (isBrandCreate(req)) {
      const url = (req.body as { url?: unknown } | null)?.url;
      const domain = websiteDomain(url);
      if (!domain) {
        throw new PlanRefusal("website_needed", "Before their account, the plan starts from their website: create the brand with `url` set to it. Ask for it if they have not given it.");
      }
      // The domain was checked when the org opened: another one waits for the account.
      if (plan && plan.domain !== domain) {
        throw new PlanRefusal("one_website", `This conversation's plan is for ${plan.domain}. Another website waits for their account: sign them in, then add it.`);
      }
      if (!plan) {
        const claim = await deps.domainClaim(domain);
        if (claim === "claimed") throw new PlanRefusal("website_has_account", CLAIMED);
        if (claim !== "unclaimed") throw new PlanRefusal("could_not_check", CANNOT_CHECK);
        const externalOrgId = `${PLAN_ORG_PREFIX}${randomUUID()}`;
        const opened = await deps.openOrg(externalOrgId);
        // Nothing works on the org until its advance lands: a failure fails the opening (the org stays an
        // abandoned walk, as the signup page's).
        await deps.seedTrial(opened.orgId);
        plan = { orgId: opened.orgId, userId: opened.userId, externalOrgId, brandId: null, domain };
        await deps.savePlan(plan);
      }
    } else if (!plan) {
      throw new PlanRefusal("plan_not_open", "Before their account, the plan starts from their website: create their brand from it first (POST /v1/brands with their url).");
    }
    const identity = { orgId: plan.orgId, userId: plan.userId };
    const result = await deps.call({
      ...identity,
      runId: await deps.runFor(identity),
      ...(plan.brandId ? { trackingHeaders: { "x-brand-id": plan.brandId } } : {}),
      guard: planGuard(plan.brandId),
    });
    if (isBrandCreate(req) && !plan.brandId) {
      const brandId = brandIdOf(result);
      if (brandId) await deps.savePlan({ ...plan, brandId });
    }
    return result;
  } catch (err) {
    if (err instanceof PlanRefusal) return err.toResult();
    throw err;
  }
}
