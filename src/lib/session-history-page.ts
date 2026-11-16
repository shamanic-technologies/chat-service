// One page of a session's visible history, newest first in the read, oldest
// first in the answer (MON-PAGE-SPEED-1114). The Copilot panel loads on every
// dashboard page and only shows the latest turns first: reading the whole
// history (1.3 MB for a 1,010-message session) made every page reload slow.
// A page carries `hasOlder` + `olderCursor` (the oldest message id served), so
// the panel reads older turns on demand by passing it back as `before`.

import type { Message } from "../db/schema.js";
import { isShownMessage } from "./session-history.js";

export const HISTORY_PAGE_MAX = 200;

/**
 * Reads up to `n` stored rows of the session, newest first, strictly older than
 * the message `before` (null = from the newest). Hidden nudge triggers may be
 * left out by the reader; every other row is filtered here.
 */
export type ReadOlderRows = (before: string | null, n: number) => Promise<Message[]>;

export interface HistoryPage {
  /** Shown messages, oldest first. */
  messages: Message[];
  /** True when shown messages older than the first one exist. */
  hasOlder: boolean;
}

/** The newest `limit` shown messages older than `before`, oldest first. */
export async function readHistoryPage(
  readOlderRows: ReadOlderRows,
  limit: number,
  before: string | null,
): Promise<HistoryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_MAX) {
    throw new Error(`limit must be an integer in 1..${HISTORY_PAGE_MAX}, got ${limit}`);
  }
  const shown: Message[] = [];
  let cursor = before;
  // Read one extra shown row to know whether older ones exist; hidden rows
  // (empty assistant turns) are skipped, so keep reading until enough are shown.
  for (;;) {
    const batch = limit + 1 - shown.length;
    const rows = await readOlderRows(cursor, batch);
    for (const row of rows) if (isShownMessage(row)) shown.push(row);
    if (shown.length > limit || rows.length < batch) break;
    cursor = rows[rows.length - 1].id;
  }
  const hasOlder = shown.length > limit;
  return { messages: shown.slice(0, limit).reverse(), hasOlder };
}
