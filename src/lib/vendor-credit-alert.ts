// ---------------------------------------------------------------------------
// Out-of-credit alerting for the direct-vendor paths
//
// The three direct vendors (DeepSeek, Z.ai, Moonshot) each hold their own
// prepaid balance and two of them do not auto-reload. When a balance runs dry
// the vendor refuses every call and the whole model tier stops answering —
// until this alert existed, nobody found out until someone noticed campaigns
// had gone quiet.
//
// The alert is raised as the fleet's EXISTING staff event
// `provider_credits_exhausted`, which transactional-email-service owns: it
// holds the template, the hardcoded staff recipient list, and the per-org
// per-day dedup. chat-service registers NO template and supplies NO recipient —
// any backend service can raise this event, so a caller-owned template would
// mean every future caller shipping its own copy of the same staff email.
// (The first version of this module invented its own event name, registered its
// own template, and passed `recipientEmail`; all three were rejected by the
// deployed producer, so DeepSeek's 2026-08-25 outage alerted nobody.)
//
// Three things it deliberately does NOT do:
//
//  1. It does not recover. No fallback vendor, no fallback model, no retry.
//     The call fails exactly as it failed before this file existed; the email
//     is a notification ALONGSIDE the failure, never instead of it.
//  2. It does not block. Sending is fire-and-forget: the failing request never
//     waits on an email.
//  3. It does not alert per call. A cold-email campaign drives many calls a
//     minute, so an email per failure would be hundreds within a minute of a
//     balance emptying — an alert the owner learns to ignore.
// ---------------------------------------------------------------------------

// Type-only import: erased at compile time, so this module and
// openai-compatible.ts have no runtime import cycle. The vendor LABEL is
// passed in by the caller for the same reason.
import type { VendorId } from "./openai-compatible.js";

const TRANSACTIONAL_EMAIL_SERVICE_URL =
  process.env.TRANSACTIONAL_EMAIL_SERVICE_URL || "https://transactional-email.distribute.you";

/**
 * Staff event owned by transactional-email-service.
 *
 * This string is the PRODUCER's contract, not ours: it must stay byte-equal to
 * the value that service accepts, or `/platform-send` rejects the alert with
 * 400. Do not rename it to fit local vocabulary, and do not register a template
 * for it here — the producer templates it.
 */
export const PROVIDER_CREDITS_EXHAUSTED_EVENT = "provider_credits_exhausted";

/**
 * How long a vendor stays quiet after an ATTEMPTED send.
 *
 * A successful send latches until the vendor serves again. A FAILED send only
 * holds for this long, so a broken email path costs at most one attempt per
 * minute instead of losing the entire outage to one rejected request (which is
 * exactly what happened on 2026-08-25).
 */
export const ALERT_COOLDOWN_MS = 60_000;

interface VendorAlertState {
  /** When we last dispatched (or refused to dispatch) an alert for this vendor. */
  lastAttemptAt: number;
  /** Did that attempt reach transactional-email-service? */
  sent: boolean;
}

/**
 * Per-vendor latch.
 *
 * In-process, deliberately. The alternative — a row in Postgres — buys
 * cross-instance and cross-restart deduplication, at the cost of a write on the
 * failure path of a request that is already failing. The failure mode of the
 * cheap version is bounded and benign: a restart mid-outage re-arms the latch,
 * so the next refused call sends one more email. A duplicate alert during an
 * outage the owner is already acting on is a much smaller problem than a missed
 * one, and a restart does not refill the balance.
 */
const vendorAlerts = new Map<VendorId, VendorAlertState>();

/**
 * A vendor answered. Whatever was wrong with its balance is not wrong now, so
 * re-arm the alert for the next outage.
 *
 * Called on every successful vendor completion. A no-op in the normal case.
 */
export function markVendorServing(vendor: VendorId): void {
  vendorAlerts.delete(vendor);
}

/** Test seam: forget every latched vendor. */
export function resetVendorCreditAlerts(): void {
  vendorAlerts.clear();
}

/** Test seam: is this vendor currently latched (i.e. alerted, not yet re-armed)? */
export function isVendorCreditAlertLatched(vendor: VendorId): boolean {
  return vendorAlerts.has(vendor);
}

/** Identity of the inbound request that hit the empty balance. */
export interface VendorAlertIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
}

export interface OutOfCreditAlertContext {
  vendor: VendorId;
  /** Human-readable vendor name, e.g. "Z.ai" — rendered as "Provider" in the staff email. */
  vendorLabel: string;
  /** Model alias that was refused — context for the reader, not part of the latch key. */
  model: string;
  /** HTTP status the vendor refused with. */
  status: number;
  /** The vendor's own message, already truncated by the caller. */
  vendorMessage: string;
  /**
   * The org whose call hit the wall. `/platform-send` is `requireOrgIdOnly`,
   * so without it there is nothing to send against — see `notifyVendorOutOfCredit`.
   */
  identity?: VendorAlertIdentity;
}

/**
 * Post the alert to the fleet's staff-notification path.
 *
 * `/platform-send` (not `/send`): it is `requireOrgIdOnly`, it delivers to the
 * internal staff list, and it 400s on a caller-supplied `recipientEmail` or
 * `bccEmails` for this event. `orgId` is NOT sent in metadata either — the
 * producer fills it from `x-org-id`.
 */
async function sendOutOfCreditEmail(context: OutOfCreditAlertContext): Promise<void> {
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  const identity = context.identity;

  if (!apiKey) {
    throw new Error("TRANSACTIONAL_EMAIL_SERVICE_API_KEY is not set");
  }
  if (!identity?.orgId) {
    throw new Error("no org on the failing call — the staff alert path is org-scoped");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;

  const res = await fetch(`${TRANSACTIONAL_EMAIL_SERVICE_URL}/platform-send`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      eventType: PROVIDER_CREDITS_EXHAUSTED_EVENT,
      // `provider` and `reason` are REQUIRED non-empty by the producer (400
      // otherwise — a staff alert with blanks where the facts belong is not
      // actionable). `orgId` comes from the header, so we do not send it.
      metadata: {
        provider: context.vendorLabel,
        reason:
          `${context.vendorLabel} refused the call with HTTP ${context.status} in its own ` +
          `out-of-credit wording, so the prepaid balance is empty. Every call to this vendor ` +
          `fails until it is topped up.`,
        detail: [
          `model: ${context.model}`,
          `HTTP ${context.status}`,
          context.vendorMessage,
        ].join("\n"),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `transactional-email-service ${res.status}: ${text.slice(0, 300)}`,
    );
  }
}

/**
 * A vendor refused a call because its account is out of credit.
 *
 * Returns immediately — the send is detached, so the request that triggered it
 * fails at exactly the speed it failed before. Returns `true` when this call
 * dispatched an alert, `false` when the vendor was already latched.
 *
 * The latch is stamped BEFORE the send is dispatched, not after it resolves: a
 * burst of concurrent failures would otherwise all pass the check while the
 * first send was still in flight, which is precisely the flood this exists to
 * prevent. What the OUTCOME decides is how long the latch holds — a send that
 * reached the producer holds until the vendor serves again, a send that failed
 * holds only for `ALERT_COOLDOWN_MS`, so a dead email path costs one attempt a
 * minute rather than the whole outage.
 */
export function notifyVendorOutOfCredit(context: OutOfCreditAlertContext): boolean {
  const now = Date.now();
  const state = vendorAlerts.get(context.vendor);
  if (state && (state.sent || now - state.lastAttemptAt < ALERT_COOLDOWN_MS)) return false;

  vendorAlerts.set(context.vendor, { lastAttemptAt: now, sent: false });

  console.error(
    `[chat-service] [vendor-credit-alert] ${context.vendorLabel} is out of credit ` +
      `(model="${context.model}", status=${context.status}). Alerting staff.`,
  );

  // `/internal/platform-complete` carries a platform run and no org, so it
  // cannot raise this org-scoped staff event. Say so loudly rather than
  // dropping it silently — and never fabricate an org to satisfy the header.
  // (Every observed outage came through the org-scoped `/complete`.)
  if (!context.identity?.orgId) {
    console.error(
      `[chat-service] [vendor-credit-alert] No staff alert sent for ${context.vendorLabel}: ` +
        `the failing call carried no org, and the staff alert path is org-scoped. ` +
        `Top up ${context.vendorLabel} — this log is the only notice.`,
    );
    return true;
  }

  void sendOutOfCreditEmail(context)
    .then(() => {
      const current = vendorAlerts.get(context.vendor);
      // Only latch the attempt we started. If the vendor served in the
      // meantime, `markVendorServing` cleared the entry and re-latching here
      // would silence the NEXT outage.
      if (current && current.lastAttemptAt === now) current.sent = true;
    })
    .catch((err: unknown) => {
      console.error(
        "[chat-service] [vendor-credit-alert] Failed to send the out-of-credit email:",
        err instanceof Error ? err.message : String(err),
      );
    });

  return true;
}
