// ---------------------------------------------------------------------------
// Who is distribute.you staff (SEC-STAFF-EMAIL-1120, prod 2026-11-20).
//
// A client-service user's stored email proves NOTHING about who the person is:
// client-service stores whatever email `/internal/resolve` receives (no verified
// flag, no provenance), and on 2026-11-20 a customer key created a user carrying
// kevin.lourd@gmail.com in its own org (an internal probe row carries it too).
// Until then the Copilot granted staff tools (shared prompt templates that write
// every org's cold emails, staff catalogue options, Distry's principal tools) to
// anyone whose stored email was on the allowlist or ended in @distribute.you.
//
// Staff power now comes ONLY from a proven identity: the requester's internal
// user id (resolved by the gateway from its own key, never typed by a caller) is
// one of the pinned staff USER ROWS below, AND that row's stored email is still
// the pinned address (same rule as api-service's fix for the same incident). No
// domain rule, no plus-addressing: an email string alone never grants anything.
// A new staff member is a deliberate edit here, with their client-service id.
// ---------------------------------------------------------------------------

/** client-service internal user id -> the staff email that row must carry. */
export const STAFF_USERS: ReadonlyMap<string, string> = new Map([
  // kevin.lourd@gmail.com (Clerk user_3AI7TH7LLPltlSpF2UCTD5U1lLa)
  ["cfe148ed-e3d8-40a2-8920-f8c040a81934", "kevin.lourd@gmail.com"],
  // kevin@distribute.you (Clerk user_2yaCEpxeoOEIfXTdxTMY8pM8jXW)
  ["7b417d70-29b5-471b-a8e1-20e75225c0af", "kevin@distribute.you"],
]);

/**
 * THE staff predicate: every staff decision in chat-service (grants AND the
 * silence/filter uses) goes through it. True only for a pinned staff user id
 * whose stored email is still that staff address (exact, case-insensitive).
 */
export function isStaffUser(userId: string | null | undefined, email: string | null | undefined): boolean {
  if (!userId) return false;
  const pinned = STAFF_USERS.get(userId);
  if (!pinned) return false;
  return email?.trim().toLowerCase() === pinned;
}
