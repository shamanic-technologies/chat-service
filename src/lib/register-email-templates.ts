// ---------------------------------------------------------------------------
// Email templates OWNED by chat-service, registered at boot
//
// Fleet convention: a template name has exactly one owner — the service that
// SENDS it. chat-service is the only service that knows a direct vendor refused
// a call for want of credit, so it owns `vendor_out_of_credit` and no other
// service should carry a copy.
//
// `PUT /templates` is an idempotent upsert keyed on (appId, name), so this runs
// on every cold start and the stored template always reflects the code.
// ---------------------------------------------------------------------------

import { CHAT_SERVICE_APP_ID, VENDOR_OUT_OF_CREDIT_EVENT } from "./vendor-credit-alert.js";

const TRANSACTIONAL_EMAIL_SERVICE_URL =
  process.env.TRANSACTIONAL_EMAIL_SERVICE_URL || "https://transactional-email.distribute.you";

/**
 * Templates interpolate `{{variable}}` from the metadata passed at send time.
 * The variables here are the ones `sendOutOfCreditEmail` sets.
 */
export const CHAT_SERVICE_EMAIL_TEMPLATES = [
  {
    name: VENDOR_OUT_OF_CREDIT_EVENT,
    subject: "{{vendor}} is out of credit — top it up",
    htmlBody: [
      "<p><strong>{{vendor}}</strong> refused a request because the account is out of credit.</p>",
      "<p>Every call to this vendor fails until the balance is topped up.</p>",
      "<ul>",
      "<li>Vendor: {{vendor}} ({{vendorSlug}})</li>",
      "<li>Model: {{model}}</li>",
      "<li>Status: {{status}}</li>",
      "<li>Vendor said: {{vendorMessage}}</li>",
      "<li>First seen: {{occurredAt}}</li>",
      "</ul>",
    ].join(""),
    textBody: [
      "{{vendor}} refused a request because the account is out of credit.",
      "Every call to this vendor fails until the balance is topped up.",
      "",
      "Vendor: {{vendor}} ({{vendorSlug}})",
      "Model: {{model}}",
      "Status: {{status}}",
      "Vendor said: {{vendorMessage}}",
      "First seen: {{occurredAt}}",
    ].join("\n"),
  },
];

/**
 * Upsert this service's templates.
 *
 * Never throws. A template registration that fails must not stop the service
 * from booting: chat-service's job is serving completions, and a missing alert
 * template degrades one notification rather than every request.
 */
export async function registerEmailTemplates(): Promise<void> {
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!apiKey) {
    console.warn(
      "[chat-service] [email-templates] TRANSACTIONAL_EMAIL_SERVICE_API_KEY is not set; " +
        "skipping template registration. Out-of-credit alerts will not send.",
    );
    return;
  }

  try {
    const res = await fetch(`${TRANSACTIONAL_EMAIL_SERVICE_URL}/templates`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        appId: CHAT_SERVICE_APP_ID,
        templates: CHAT_SERVICE_EMAIL_TEMPLATES,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[chat-service] [email-templates] Registration failed: ${res.status} ${text.slice(0, 300)}`,
      );
      return;
    }

    console.log(
      `[chat-service] [email-templates] Registered ${CHAT_SERVICE_EMAIL_TEMPLATES.length} template(s) for appId="${CHAT_SERVICE_APP_ID}".`,
    );
  } catch (err) {
    console.error(
      "[chat-service] [email-templates] Registration failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
