// ---------------------------------------------------------------------------
// Out-of-credit alerting for the direct-vendor paths
//
// The three direct vendors (DeepSeek, Z.ai, Moonshot) each hold their own
// prepaid balance and two of them do not auto-reload. When a balance runs dry
// the vendor refuses every call and the whole model tier stops answering —
// until now, nobody found out until someone noticed campaigns had gone quiet.
//
// This module emails the platform owner once per outage, naming the vendor.
//
// Three things it deliberately does NOT do:
//
//  1. It does not recover. No fallback vendor, no fallback model, no retry.
//     The call fails exactly as it failed before this file existed; the email
//     is a notification ALONGSIDE the failure, never instead of it.
//  2. It does not block. Sending is fire-and-forget: the failing request never
//     waits on an email, and a send that fails is logged and dropped rather
//     than turning one outage into two.
//  3. It does not alert per call. A cold-email campaign drives many calls a
//     minute, so an email per failure would be hundreds within a minute of a
//     balance emptying — an alert the owner learns to ignore. One per vendor
//     per outage, re-armed when that vendor serves a call again.
// ---------------------------------------------------------------------------

// Type-only import: erased at compile time, so this module and
// openai-compatible.ts have no runtime import cycle. The vendor LABEL is
// passed in by the caller for the same reason.
import type { VendorId } from "./openai-compatible.js";

const TRANSACTIONAL_EMAIL_SERVICE_URL =
  process.env.TRANSACTIONAL_EMAIL_SERVICE_URL || "https://transactional-email.distribute.you";

/**
 * App id this service registers its templates under.
 *
 * A template name has exactly one owner in the fleet — the service that SENDS
 * it — so this template lives here and nowhere else. `(appId, name)` is the
 * key transactional-email-service upserts on.
 */
export const CHAT_SERVICE_APP_ID = "chat-service";

/** Template name = `eventType` at send time. */
export const VENDOR_OUT_OF_CREDIT_EVENT = "vendor_out_of_credit";

/**
 * Which vendors we have already emailed about, and not yet seen serve again.
 *
 * In-process, deliberately. The alternative — a row in Postgres — buys
 * cross-instance and cross-restart deduplication, at the cost of a write on the
 * failure path of a request that is already failing. The failure mode of the
 * cheap version is bounded and benign: a restart mid-outage re-arms the latch,
 * so the next refused call sends one more email. A duplicate alert during an
 * outage the owner is already acting on is a much smaller problem than a missed
 * one, and a restart does not refill the balance. Same for multiple instances:
 * each sends at most one per outage.
 */
const alertedVendors = new Set<VendorId>();

/**
 * A vendor answered. Whatever was wrong with its balance is not wrong now, so
 * re-arm the alert for the next outage.
 *
 * Called on every successful vendor completion. A no-op in the normal case.
 */
export function markVendorServing(vendor: VendorId): void {
  alertedVendors.delete(vendor);
}

/** Test seam: forget every latched vendor. */
export function resetVendorCreditAlerts(): void {
  alertedVendors.clear();
}

/** Test seam: is this vendor currently latched (i.e. alerted, not yet re-armed)? */
export function isVendorCreditAlertLatched(vendor: VendorId): boolean {
  return alertedVendors.has(vendor);
}

export interface OutOfCreditAlertContext {
  vendor: VendorId;
  /** Human-readable vendor name, e.g. "Z.ai" — what the owner reads in the subject line. */
  vendorLabel: string;
  /** Model alias that was refused — context for the owner, not part of the latch key. */
  model: string;
  /** HTTP status the vendor refused with. */
  status: number;
  /** The vendor's own message, already truncated by the caller. */
  vendorMessage: string;
}

/**
 * Post the alert to the fleet's transactional email path.
 *
 * Recipient is read from the environment like every other deployment-specific
 * value in this service — the platform owner's address is not source code.
 */
async function sendOutOfCreditEmail(context: OutOfCreditAlertContext): Promise<void> {
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  const recipientEmail = process.env.PLATFORM_OWNER_EMAIL;

  if (!apiKey || !recipientEmail) {
    console.error(
      "[chat-service] [vendor-credit-alert] Cannot email the out-of-credit alert: " +
        `${!apiKey ? "TRANSACTIONAL_EMAIL_SERVICE_API_KEY" : "PLATFORM_OWNER_EMAIL"} is not set.`,
    );
    return;
  }

  const res = await fetch(`${TRANSACTIONAL_EMAIL_SERVICE_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      appId: CHAT_SERVICE_APP_ID,
      eventType: VENDOR_OUT_OF_CREDIT_EVENT,
      recipientEmail,
      metadata: {
        vendor: context.vendorLabel,
        vendorSlug: context.vendor,
        model: context.model,
        status: String(context.status),
        vendorMessage: context.vendorMessage,
        occurredAt: new Date().toISOString(),
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
 * armed the alert (i.e. an email was dispatched), `false` when the vendor was
 * already latched.
 *
 * The latch is set BEFORE the send is dispatched, not after it resolves: a
 * burst of concurrent failures would otherwise all pass the check while the
 * first send was still in flight, which is precisely the flood this exists to
 * prevent. A send that then fails leaves the latch SET — retrying an email
 * once per refused call while the email path is down is the same flood by
 * another route. Log it and move on.
 */
export function notifyVendorOutOfCredit(context: OutOfCreditAlertContext): boolean {
  if (alertedVendors.has(context.vendor)) return false;
  alertedVendors.add(context.vendor);

  console.error(
    `[chat-service] [vendor-credit-alert] ${context.vendorLabel} is out of credit ` +
      `(model="${context.model}", status=${context.status}). Emailing the platform owner.`,
  );

  void sendOutOfCreditEmail(context).catch((err: unknown) => {
    console.error(
      "[chat-service] [vendor-credit-alert] Failed to send the out-of-credit email:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return true;
}
