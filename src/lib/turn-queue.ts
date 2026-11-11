// ---------------------------------------------------------------------------
// One turn at a time per conversation (SOPHIE-CORE-1111, prod 2026-11-11).
//
// A client typed "now start a new campaign on zenotris.com" in the same second
// the dashboard opened a new chat for them: two /chat turns ran in parallel,
// each read the account before the other wrote, and the client got two
// contradictory answers. A person talks to ONE Sophie: a second message waits
// for the first turn to finish, then runs on the account as it now stands.
//
// The conversation is the person (org x user) across their web sessions,
// Telegram and their signed-in WhatsApp; a Lead event turn is its own lead
// thread (another person). chat-service runs as one process, so an in-process
// queue per key is the whole lock. A turn that never ends cannot block the
// person forever: after TURN_WAIT_MAX_MS the next one runs anyway, logged.
// ---------------------------------------------------------------------------

/** The longest a turn waits for the one before it (a Copilot turn's own budget is minutes, not more). */
export const TURN_WAIT_MAX_MS = 5 * 60_000;

const tails = new Map<string, Promise<void>>();

/** Which conversation a /chat request belongs to. */
export function turnKeyOf(body: unknown, identity: { orgId: string; userId: string }): string {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof b.leadTurnId === "string" && b.leadTurnId) {
    return `lead:${typeof b.sessionId === "string" && b.sessionId ? b.sessionId : b.leadTurnId}`;
  }
  return `person:${identity.orgId}:${identity.userId}`;
}

/** Runs `turn` once every earlier turn of the same key has finished (or waited TURN_WAIT_MAX_MS). */
export async function oneTurnAtATime<T>(key: string, turn: () => Promise<T>, maxWaitMs: number = TURN_WAIT_MAX_MS): Promise<T> {
  const previous = tails.get(key);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = (previous ?? Promise.resolve()).then(() => mine);
  tails.set(key, tail);
  if (previous) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      previous.then(() => "done" as const),
      new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), maxWaitMs))),
    ]);
    clearTimeout(timer);
    if (waited === "timeout") console.warn(`[turn-queue] ${key}: the turn before ran past ${maxWaitMs}ms, this one runs anyway`);
  }
  try {
    return await turn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** Test hook: how many conversations hold a queue right now. */
export function queuedConversations(): number {
  return tails.size;
}
