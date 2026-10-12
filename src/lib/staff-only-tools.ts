import { fetchRequesterEmail, isStaffEmail } from "./staff-requests.js";

// ---------------------------------------------------------------------------
// Staff-only Copilot tools.
//
// The shared prompt templates (`GET/PUT /v1/prompts`) are platform-wide: every
// org's cold emails are written from them. api-service gates those routes on
// `requireStaff` = the platform key AND a forwarded `x-email` in its staff
// allowlist. chat-service learns who is chatting from the gateway-resolved
// `x-user-id` (never from anything the browser types): it asks client-service
// for that user's email. Staff get the tools and the call carries their email
// as `x-email`; anyone else never sees the tools (filtered out of the turn's
// tool list, so the dispatcher's allowedTools guard also refuses a call).
// ---------------------------------------------------------------------------

export const STAFF_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_prompt_template",
  "update_prompt_template",
]);

export interface Requester {
  /** Email from client-service; null when unknown. */
  email: string | null;
  isStaff: boolean;
}

/**
 * Who is chatting, from client-service. A failed lookup is a customer (fail
 * closed): the staff-only tools disappear for that turn, nothing leaks.
 */
export async function lookupRequester(
  userId: string,
  fetchEmail: (userId: string) => Promise<string | null> = fetchRequesterEmail,
): Promise<Requester> {
  try {
    const email = await fetchEmail(userId);
    return { email, isStaff: isStaffEmail(email) };
  } catch (err) {
    console.error(`[chat] staff lookup failed for user="${userId}", treating as a customer:`, err);
    return { email: null, isStaff: false };
  }
}

export function hasStaffOnlyTool(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => STAFF_ONLY_TOOLS.has(name));
}

/** The config's tools minus the staff-only ones unless the requester is staff. */
export function toolsForRequester(toolNames: readonly string[], requester: Requester): string[] {
  if (requester.isStaff && requester.email) return [...toolNames];
  return toolNames.filter((name) => !STAFF_ONLY_TOOLS.has(name));
}
