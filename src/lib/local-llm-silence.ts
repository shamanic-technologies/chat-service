// ---------------------------------------------------------------------------
// SOLO-PLAN-1125 (owner 2026-11-25): a founder whose LLM work runs on their own
// Claude (a routine / scheduled task taking the waiting work about once an
// hour) is told ONCE when no runner took that work for about two hours: the
// routine may have been deleted, paused or run out of Claude usage.
//
// - Fixed text, never a model call (`silenceNoticeText`).
// - Once per silence: the claim is one conditional UPDATE on the org row; a
//   runner asking for work again clears it (touchRunner), so the next silence
//   is told again.
// - The door they use: the org's linked Telegram chat, else the WhatsApp number
//   bound to the declarer's Copilot thread (sent from the Copilot's own line),
//   else their Copilot chat. A door that fails releases the claim: the next
//   tick tries again. No door at all is recorded (`none`) and logged, never
//   retried every tick.
// ---------------------------------------------------------------------------

import { and, desc, eq } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { messages, sessions } from "../db/schema.js";
import type { LocalLlmStore, SilentLocalOrg } from "./local-llm-store.js";
import { stripNul } from "./strip-nul.js";

/** No runner took the org's waiting work for this long: the founder is told. */
export const RUNNER_SILENT_NOTICE_MS = 2 * 3600_000;
export const SILENCE_TICK_MS = 5 * 60_000;
const COPILOT_CONFIG_KEY = "copilot";

/** The notice, word for word (no model call). */
export function silenceNoticeText(pendingCalls: number): string {
  const tasks = pendingCalls === 1 ? "1 task is" : `${pendingCalls} tasks are`;
  return [
    `Your Claude has not picked up your distribute.you work for 2 hours, so ${tasks} waiting.`,
    "Your Claude routine may be stopped: deleted, paused, or out of Claude usage.",
    "To restart it, open Claude, find the routine that takes your distribute.you work, and run it once. If it is gone, ask your Claude to create it again with the distribute.you connector.",
    "Your waiting work is kept until then.",
  ].join("\n");
}

export type SilenceDoor = "telegram" | "whatsapp" | "chat" | "none";

export interface SilenceDeps {
  store: LocalLlmStore;
  db: typeof Db;
  /** client-service: the member who linked the org's own Telegram chat, null when none. */
  telegramLinker: (orgId: string) => Promise<string | null>;
  /** client-service: one message to the org's linked Telegram chat; throws unless sent. */
  sendTelegram: (args: { orgId: string; text: string }) => Promise<void>;
  /** WhatsApp from the Copilot's own line to this number; throws unless sent. */
  sendWhatsapp: (args: { orgId: string; userId: string; phone: string; text: string; idempotencyKey: string }) => Promise<void>;
  now?: () => Date;
}

/** The declarer's Copilot threads: the WhatsApp number bound to one of them, and their latest web thread. */
async function declarerThreads(database: typeof Db, orgId: string, userId: string): Promise<{ phone: string | null; webSessionId: string | null }> {
  const rows = await database
    .select({ id: sessions.id, channelPhone: sessions.channelPhone, leadThread: sessions.leadThread })
    .from(sessions)
    .where(and(eq(sessions.orgId, orgId), eq(sessions.userId, userId), eq(sessions.configKey, COPILOT_CONFIG_KEY), eq(sessions.guest, false)))
    .orderBy(desc(sessions.updatedAt))
    .limit(50);
  const phone = rows.find((r) => r.channelPhone)?.channelPhone ?? null;
  const web = rows.find((r) => !r.leadThread);
  return { phone, webSessionId: web?.id ?? null };
}

/** Tells ONE silent org, on the first door that works. Throws when a door exists but refused (the claim is then released). */
export async function deliverSilenceNotice(deps: SilenceDeps, org: SilentLocalOrg, at: Date): Promise<SilenceDoor> {
  const text = silenceNoticeText(org.pendingCalls);
  if (await deps.telegramLinker(org.orgId)) {
    await deps.sendTelegram({ orgId: org.orgId, text });
    return "telegram";
  }
  if (!org.declaredByUserId) return "none";
  const threads = await declarerThreads(deps.db, org.orgId, org.declaredByUserId);
  if (threads.phone) {
    await deps.sendWhatsapp({
      orgId: org.orgId,
      userId: org.declaredByUserId,
      phone: threads.phone,
      text,
      idempotencyKey: `local-llm-silence:${org.orgId}:${at.toISOString()}`,
    });
    return "whatsapp";
  }
  if (threads.webSessionId) {
    await deps.db.insert(messages).values(stripNul({ sessionId: threads.webSessionId, role: "assistant" as const, content: text }));
    await deps.db.update(sessions).set({ updatedAt: at }).where(eq(sessions.id, threads.webSessionId));
    return "chat";
  }
  return "none";
}

/** One tick: every org silent for 2 h with work waiting is told once. Never throws (each org is logged on its own). */
export async function notifySilentRunners(deps: SilenceDeps): Promise<Array<{ orgId: string; door: SilenceDoor | "failed" }>> {
  const at = deps.now?.() ?? new Date();
  const silent = await deps.store.listSilentOrgs(at, new Date(at.getTime() - RUNNER_SILENT_NOTICE_MS));
  const out: Array<{ orgId: string; door: SilenceDoor | "failed" }> = [];
  for (const org of silent) {
    if (!(await deps.store.claimSilenceNotice(org.orgId, at))) continue;
    try {
      const door = await deliverSilenceNotice(deps, org, at);
      await deps.store.settleSilenceNotice(org.orgId, door);
      if (door === "none") {
        console.warn(`[local-llm] org="${org.orgId}" runner silent since ${org.runnerLastSeenAt?.toISOString() ?? "never"}, ${org.pendingCalls} call(s) waiting: no door to tell the founder (no Telegram, WhatsApp or Copilot thread)`);
      } else {
        console.log(`[local-llm] org="${org.orgId}" runner silent since ${org.runnerLastSeenAt?.toISOString() ?? "never"}, ${org.pendingCalls} call(s) waiting: founder told on ${door}`);
      }
      out.push({ orgId: org.orgId, door });
    } catch (err) {
      await deps.store.settleSilenceNotice(org.orgId, null);
      console.error(`[local-llm] org="${org.orgId}" silence notice not delivered (retried next tick): ${err instanceof Error ? err.message : String(err)}`);
      out.push({ orgId: org.orgId, door: "failed" });
    }
  }
  return out;
}
