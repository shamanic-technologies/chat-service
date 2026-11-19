import { describe, it, expect, vi } from "vitest";
import {
  WEB_ACCOUNT_IDLE_MAX_MS,
  WEB_AFTER_SIGN_IN_TRIGGER,
  WEB_GUEST_DAILY_TURN_CAP_DEFAULT,
  WEB_SPEED_MAX_MESSAGES,
  WEB_SPEED_WINDOW_MS,
  WEB_TURN_STALE_MS,
  acceptWebMessage,
  answerWebMessage,
  buildWebBlock,
  busyVisitors,
  isLiveWebSession,
  orderedAnswer,
  parseContinueArgs,
  processWebMessage,
  readWebConversation,
  webFacts,
  webGuardVerdict,
  webGuestDailyTurnCap,
  webIdentityOf,
  webTurnOutcome,
  withChoicesList,
  type WebDeps,
} from "../../src/lib/web-visitor.js";
import * as webVisitor from "../../src/lib/web-visitor.js";
import { CHANNEL_FAILURE_TEXT, WHOLE_WAY_TO_USE, buildChannelBlock, identityLines, type ChatChannelContext } from "../../src/lib/channel-copilot.js";
import { buildTelegramBlock } from "../../src/lib/telegram-copilot.js";
import { turnKeyOf } from "../../src/lib/turn-queue.js";

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

const LINE = { orgId: "org-line", brandId: "brand-line", userId: "user-line" };
const ACCOUNT = { orgId: "org-ann", userId: "user-ann" };
const VISITOR = "v_test_visitor_0001";

/** Every bound value of a drizzle condition (the ids and keys a `where` names). */
function boundValues(cond: unknown, seen = new Set<unknown>()): unknown[] {
  if (!cond || typeof cond !== "object" || seen.has(cond)) return [];
  seen.add(cond);
  const c = cond as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
  if (c.constructor?.name === "Param") return [c.value];
  return (c.queryChunks ?? []).flatMap((x) => boundValues(x, seen));
}

/** jsonb does not keep key order: what is read back comes sorted (shorter keys first, then by bytes), like Postgres. */
function asJsonb<T>(v: T): T {
  if (Array.isArray(v)) return v.map(asJsonb) as unknown as T;
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
      .map((k) => [k, asJsonb(o[k])]),
  ) as T;
}

interface Fake {
  now: Date;
  session: Record<string, unknown> | null;
  rows: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
}

/** A stateful db: the visitor's one session, the stored message rows (found by the id or key a `where` names), counts computed from the rows. */
function fakeDb(state: Fake) {
  const nameOf = (table: unknown) => String((table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")]);
  let countQueries = 0;
  const select = (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => {
        const name = nameOf(table);
        let rows: unknown[] = [];
        if (fields && "n" in fields) {
          // acceptWebMessage counts twice, in this order: the visitor's last 10 minutes, then (a guest) the line's day.
          const values = boundValues(cond);
          const visitor = values.includes(VISITOR) || state.rows.some((r) => values.includes(r.senderPhone));
          const speed = countQueries++ % 2 === 0 && visitor;
          const live = state.rows.filter((r) => r.status !== "refused");
          rows = [
            {
              n: speed
                ? live.filter((r) => values.includes(r.senderPhone) && (r.createdAt as Date).getTime() >= state.now.getTime() - WEB_SPEED_WINDOW_MS).length
                : live.filter((r) => r.orgId === LINE.orgId && (r.createdAt as Date).toISOString().slice(0, 10) === state.now.toISOString().slice(0, 10)).length,
            },
          ];
          if (!speed) countQueries = 0;
        } else if (name === "channel_inbound_messages") {
          const values = boundValues(cond);
          rows = state.rows.filter((r) => values.includes(r.id) || values.includes(r.messageId));
        } else if (name === "sessions") rows = state.session ? [state.session] : [];
        else if (name === "messages") rows = state.messages;
        const p = Promise.resolve(rows) as Promise<unknown[]> & { orderBy: () => unknown };
        p.orderBy = () => {
          const q = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
          q.limit = () => Promise.resolve(rows);
          return q;
        };
        return p;
      },
    }),
  });
  const db = {
    select,
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const name = nameOf(table);
        if (name === "sessions") {
          state.session = { id: "s-1", channelPhone: null, channelEmail: null, webAccountEmail: null, updatedAt: state.now, ...values };
          return { returning: () => Promise.resolve([{ id: "s-1" }]) };
        }
        const duplicate = state.rows.some((r) => r.messageId === values.messageId);
        const row = { id: `row-${state.rows.length + 1}`, sessionId: null, replyText: null, error: null, sentAt: null, signedIn: false, answer: null, createdAt: state.now, updatedAt: state.now, ...values };
        if (!duplicate) state.rows.push(row);
        return { onConflictDoNothing: () => ({ returning: () => Promise.resolve(duplicate ? [] : [{ id: row.id }]) }) };
      },
    }),
    update: (table: unknown) => ({
      set: (s: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          if (nameOf(table) === "sessions") Object.assign(state.session!, s);
          else {
            const values = boundValues(cond);
            for (const r of state.rows.filter((x) => values.includes(x.id))) Object.assign(r, { ...s, ...("answer" in s ? { answer: asJsonb(s.answer) } : {}) });
          }
          return Promise.resolve();
        },
      }),
    }),
  };
  return db as unknown as WebDeps["db"];
}

function world(over: Partial<Fake> = {}) {
  const state: Fake = { now: new Date("2026-11-18T10:00:00Z"), session: null, rows: [], messages: [], ...over };
  const db = fakeDb(state);
  const runs: Array<{ orgId: string; userId: string }> = [];
  const deps: WebDeps = {
    db,
    copilotLine: () => LINE,
    createRootRun: vi.fn(async (identity) => {
      runs.push(identity);
      return `run-${runs.length}`;
    }),
    runChat: vi.fn(async () => ({ status: 200, body: sse([{ type: "token", content: "Hello." }]) })),
    reachWhatsapp: vi.fn(async () => ({ reachable: true as const, fromAccount: "+33700000000", persona: null })),
    sendWhatsapp: vi.fn(async () => {}),
    handOverByEmail: vi.fn(async () => ({ status: "pending" })),
    now: () => state.now,
    guestDailyTurnCap: () => WEB_GUEST_DAILY_TURN_CAP_DEFAULT,
  };
  const send = (messageId: string, text = "hi") => answerWebMessage(deps, { visitorId: VISITOR, messageId, text });
  return { state, deps, runs, send };
}

const accountSession = (over: Record<string, unknown> = {}) => ({
  id: "s-1", orgId: ACCOUNT.orgId, userId: ACCOUNT.userId, guest: false, channelPhone: null, channelEmail: null, webAccountEmail: "ann@acme.io", webVisitorId: VISITOR, updatedAt: new Date("2026-11-18T09:00:00Z"), ...over,
});

describe("the website block is the page's FORM, nothing else (DISTRY-ONE-AI-1118)", () => {
  const guest = buildWebBlock({ whatsapp: null, guest: true });
  const account = buildWebBlock({ whatsapp: null, guest: false });

  it("says how the page shows an answer: plain text, links as plain URLs (a payment link included), choices as buttons", () => {
    expect(guest).toContain("Channel: our website");
    expect(guest).toContain("plain text only");
    expect(guest).toContain("a payment link included, is written as the plain URL");
    expect(guest).toContain("shown as buttons");
    expect(guest).not.toMatch(/[—–]/);
  });

  // Prod 2026-11-18 07:53: « Get started avec mon website dutrou.com » was answered « créez votre
  // compte ici : https://dashboard.distribute.you/sign-up ». The block told it so.
  it("never sends a visitor to a page to start: no start button, no sign-up address, in any state", () => {
    for (const block of [guest, account, buildWebBlock({ whatsapp: "+33612345678", guest: true }), buildWebBlock({ whatsapp: null, email: "a@b.co", guest: false, afterSignIn: true })]) {
      expect(block).not.toMatch(/start button|the way is|sign-up|\/get-started/i);
    }
  });

  it("a guest signs up or in right in the conversation: email, a phone number (nothing verified one here), the code", () => {
    expect(guest).toContain("This conversation is NOT tied to any distribute.you account yet");
    expect(guest).toContain("sign them up or in, right here in this conversation: ask for their email (once) and a phone number for urgent matters, with its country code (once), call start_sign_in");
    expect(guest).toContain("Answer every question about distribute.you at once");
  });

  it("a signed-in visitor can do everything here, and the answer right after their sign-in picks up what they asked", () => {
    expect(account).toContain("This conversation is tied to the distribute.you account you act for");
    expect(account).toContain(WHOLE_WAY_TO_USE);
    expect(account).not.toContain("NOT tied");
    expect(account).not.toContain("what they asked before signing in");
    expect(buildWebBlock({ whatsapp: null, guest: false, afterSignIn: true })).toContain("Answer now, with that access, what they asked before signing in");
  });

  it("the hand-off is a delivery fact: offered once to a guest, stated once tied, never asked again", () => {
    expect(guest).toContain("call continue_on_channel");
    expect(account).not.toContain("continue_on_channel");
    const tied = buildWebBlock({ whatsapp: "+33612345678", guest: true });
    expect(tied).toContain("+33612345678");
    expect(tied).toContain("Never ask for it again");
    expect(tied).not.toContain("call continue_on_channel");
    const byEmail = buildWebBlock({ whatsapp: null, email: "ann@acme.io", guest: true });
    expect(byEmail).toContain("ann@acme.io");
    expect(byEmail).not.toContain("call continue_on_channel");
  });
});

describe("who the person is reads the same on every channel: one builder (DISTRY-ONE-AI-1118)", () => {
  const channel: ChatChannelContext = { kind: "whatsapp", assistant: { name: "Distry", role: null, instructions: null }, sender: { phone: "+15550001111", name: "Ann" }, thread: [] };

  it("a guest's lines on WhatsApp and on our website differ only by what ties the conversation and the number to ask", () => {
    const [whatsapp] = identityLines({ guest: true, place: "This WhatsApp number", numberKnown: true, canSignIn: true });
    const [website] = identityLines({ guest: true, place: "This conversation", numberKnown: false, canSignIn: true });
    expect(buildChannelBlock(channel, true)).toContain(whatsapp);
    expect(buildWebBlock({ whatsapp: null, guest: true })).toContain(website);
    const neutral = (s: string) => s.replace("This WhatsApp number", "X").replace("This conversation", "X").replace(", right here in this conversation", "").replace(" and a phone number for urgent matters, with its country code (once)", "");
    expect(neutral(website)).toBe(neutral(whatsapp));
  });

  it("an account's lines are the same on WhatsApp, Telegram and our website", () => {
    const telegram = identityLines({ guest: false, place: "This Telegram chat", numberKnown: false, canSignIn: false });
    for (const line of telegram) expect(buildTelegramBlock()).toContain(line);
    expect(buildChannelBlock(channel, false)).toContain(WHOLE_WAY_TO_USE);
    expect(buildWebBlock({ whatsapp: null, guest: false })).toContain(WHOLE_WAY_TO_USE);
    expect(identityLines({ guest: false, place: "This conversation", numberKnown: false, canSignIn: true })[0]).toContain("sign them in with start_sign_in then complete_sign_in");
  });
});

describe("web visitor: handles, facts and the answer's form", () => {
  it("a number is read in international form, spaces and 00 prefix included; anything else is refused for the model", () => {
    expect(parseContinueArgs({ phone: "+33 6 12 34 56 78" })).toEqual({ ok: true, phone: "+33612345678" });
    expect(parseContinueArgs({ phone: "0033 (6) 12-34-56-78" })).toEqual({ ok: true, phone: "+33612345678" });
    expect(parseContinueArgs({ phone: "06 12 34 56 78" }).ok).toBe(false);
    expect(parseContinueArgs({}).ok).toBe(false);
    expect(parseContinueArgs({ email: " Ann@Acme.io " })).toEqual({ ok: true, email: "ann@acme.io" });
    expect(parseContinueArgs({ email: "ann at acme" }).ok).toBe(false);
    expect(parseContinueArgs({ email: "ann@acme.io", phone: "+33612345678" }).ok).toBe(false);
  });

  it("no answer count walls a visitor: the page reads where the conversation goes on and whose account acts, nothing to count down", () => {
    for (const gone of ["WEB_MAX_VISITOR_MESSAGES", "WEB_ASK_CONTACT_AFTER", "webSignals", "WEB_DAILY_TURN_CAP"]) expect(Object.keys(webVisitor)).not.toContain(gone);
    expect(webFacts(null)).toEqual({ continuedOn: null, account: { signedIn: false, email: null } });
    expect(webFacts({ guest: true, userId: "u", channelPhone: "+33612345678", channelEmail: "a@b.co", webAccountEmail: null })).toEqual({ continuedOn: "whatsapp", account: { signedIn: false, email: null } });
    expect(webFacts({ guest: true, userId: "u", channelPhone: null, channelEmail: "a@b.co", webAccountEmail: null }).continuedOn).toBe("email");
    expect(webFacts(accountSession())).toEqual({ continuedOn: null, account: { signedIn: true, email: "ann@acme.io" } });
  });

  it("the answer reaches the page as plain text with its choices APART (the page draws buttons); a failed or empty turn is said in one line", () => {
    expect(webTurnOutcome(200, sse([{ type: "token", content: "See **pricing** at [our site](https://distribute.you/pricing) — it is simple." }]))).toEqual({
      reply: "See pricing at our site: https://distribute.you/pricing, it is simple.",
      choices: null,
      failure: null,
    });
    const cards = webTurnOutcome(200, sse([{ type: "token", content: "Here is the plan." }, { type: "choices", question: "Run it?", choices: [{ label: "**Yes**" }, { label: "Change who we reach", description: "other companies" }] }]));
    expect(cards).toEqual({ reply: "Here is the plan.", choices: { question: "Run it?", choices: [{ label: "Yes" }, { label: "Change who we reach", description: "other companies" }] }, failure: null });
    expect(cards.reply).not.toContain("1.");
    expect(withChoicesList(cards.reply, cards.choices)).toBe("Here is the plan.\n\nRun it?\n\n1. Yes\n2. Change who we reach (other companies)");
    expect(webTurnOutcome(200, sse([{ type: "choices", question: "Which one?", choices: [{ label: "A" }] }]))).toEqual({ reply: "Which one?", choices: { choices: [{ label: "A" }] }, failure: null });
    expect(webTurnOutcome(500, "boom")).toMatchObject({ reply: CHANNEL_FAILURE_TEXT, choices: null });
    expect(webTurnOutcome(200, sse([])).failure).toBe("the turn answered nothing");
    expect(webTurnOutcome(200, sse([{ type: "error", message: "x" }])).failure).toContain("x");
  });

  it("each visitor is its own conversation in the turn queue, never queued behind our line's own user", () => {
    const identity = { orgId: "org", userId: "user" };
    expect(turnKeyOf({ webVisitorId: "v_aaaaaaaaaaaaaaaa", channelMessageId: "x" }, identity)).toBe("web:v_aaaaaaaaaaaaaaaa");
    expect(turnKeyOf({ webVisitorId: "v_bbbbbbbbbbbbbbbb", channelMessageId: "x" }, identity)).not.toBe(turnKeyOf({ webVisitorId: "v_aaaaaaaaaaaaaaaa" }, identity));
    expect(turnKeyOf({ message: "hi" }, identity)).toBe("person:org:user");
  });
});

describe("the guard: abuse is cut, a person onboarding never is (DISTRY-ONE-AI-1118)", () => {
  it("a script is cut: the 21st message of a visitor inside 10 minutes runs nothing, and is stored as refused", async () => {
    const { state, deps, send } = world();
    const statuses: string[] = [];
    for (let i = 0; i < 25; i++) {
      state.now = new Date(state.now.getTime() + 5_000);
      statuses.push((await send(`m${i}`)).status);
    }
    expect(statuses.slice(0, WEB_SPEED_MAX_MESSAGES)).toEqual(Array(WEB_SPEED_MAX_MESSAGES).fill("answered"));
    expect(statuses.slice(WEB_SPEED_MAX_MESSAGES)).toEqual(Array(5).fill("busy"));
    expect(deps.runChat).toHaveBeenCalledTimes(WEB_SPEED_MAX_MESSAGES);
    expect(state.rows.filter((r) => r.status === "refused")).toHaveLength(5);
    expect(state.rows.at(-1)).toMatchObject({ status: "refused", error: "guard:speed" });
    // The same refused message sent again is still refused; a new one once the window passed runs.
    expect((await send("m24")).status).toBe("busy");
    state.now = new Date(state.now.getTime() + WEB_SPEED_WINDOW_MS + 1_000);
    expect((await send("later")).status).toBe("answered");
  });

  it("a person onboarding is never cut: 40 messages spread over an hour all get their answer", async () => {
    const { state, deps, send } = world();
    for (let i = 0; i < 40; i++) {
      state.now = new Date(state.now.getTime() + 90_000);
      expect((await send(`m${i}`)).status, `message ${i}`).toBe("answered");
    }
    expect(deps.runChat).toHaveBeenCalledTimes(40);
  });

  it("the daily breaker counts GUEST answers only: a signed-in visitor's turns are their org's and never stopped by it", async () => {
    const guest = world();
    guest.deps.guestDailyTurnCap = () => 3;
    for (let i = 0; i < 3; i++) expect((await guest.send(`g${i}`)).status).toBe("answered");
    expect(await guest.send("g3")).toMatchObject({ status: "busy", reply: null });
    expect(guest.state.rows.at(-1)).toMatchObject({ status: "refused", error: "guard:daily" });

    const signedIn = world({ session: accountSession(), rows: guest.state.rows.filter((r) => r.status !== "refused").map((r) => ({ ...r, senderPhone: "v_another_visitor_01" })) });
    signedIn.deps.guestDailyTurnCap = () => 3;
    expect((await signedIn.send("a1")).status).toBe("answered");
    expect(signedIn.state.rows.at(-1)).toMatchObject({ orgId: ACCOUNT.orgId, userId: ACCOUNT.userId, status: "answered" });
  });

  it("the verdict and the cap: speed first, the day's cap for a guest, tunable by WEB_GUEST_DAILY_TURN_CAP", () => {
    expect(webGuardVerdict({ visitorRecent: WEB_SPEED_MAX_MESSAGES - 1, guest: true, guestToday: 0, dailyCap: 10 })).toBeNull();
    expect(webGuardVerdict({ visitorRecent: WEB_SPEED_MAX_MESSAGES, guest: false, guestToday: 0, dailyCap: 10 })).toBe("speed");
    expect(webGuardVerdict({ visitorRecent: 0, guest: true, guestToday: 10, dailyCap: 10 })).toBe("daily");
    expect(webGuardVerdict({ visitorRecent: 0, guest: false, guestToday: 10_000, dailyCap: 10 })).toBeNull();
    expect(webGuestDailyTurnCap({})).toBe(WEB_GUEST_DAILY_TURN_CAP_DEFAULT);
    expect(WEB_GUEST_DAILY_TURN_CAP_DEFAULT).toBe(5000);
    expect(webGuestDailyTurnCap({ WEB_GUEST_DAILY_TURN_CAP: "800" })).toBe(800);
    expect(() => webGuestDailyTurnCap({ WEB_GUEST_DAILY_TURN_CAP: "lots" })).toThrow(/whole number/);
  });
});

describe("a visitor signs up or in right in the page chat (DISTRY-ONE-AI-1118)", () => {
  it("the turn that signed them in is followed at once by the answer with their account, in the same response", async () => {
    const { state, deps, runs, send } = world();
    (deps.runChat as ReturnType<typeof vi.fn>).mockImplementation(async (args: { orgId: string; message: string }) => {
      if (args.orgId === LINE.orgId) {
        // complete_sign_in re-keyed the session during the guest turn.
        Object.assign(state.session!, { ...ACCOUNT, guest: false, webAccountEmail: "ann@acme.io" });
        return { status: 200, body: sse([{ type: "token", content: "You are in." }]) };
      }
      return { status: 200, body: sse([{ type: "token", content: "I read acme.io: you sell X." }, { type: "choices", choices: [{ label: "Yes" }] }]) };
    });
    const res = await send("m1", "the code is 123456");
    expect(res).toEqual({
      status: "answered",
      reply: "You are in.\n\nI read acme.io: you sell X.",
      choices: { choices: [{ label: "Yes" }] },
      handOff: null,
      continuedOn: null,
      account: { signedIn: true, email: "ann@acme.io" },
    });
    // Two turns on the same message row: the guest's under our line, then the account's in a run of its own org, its trigger hidden.
    expect(runs).toEqual([{ orgId: LINE.orgId, userId: LINE.userId }, ACCOUNT]);
    const calls = (deps.runChat as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({ orgId: LINE.orgId, userId: LINE.userId, runId: "run-1", message: "the code is 123456", channelMessageId: "row-1", visitorId: VISITOR });
    expect(calls[1]).toMatchObject({ ...ACCOUNT, runId: "run-2", sessionId: "s-1", message: WEB_AFTER_SIGN_IN_TRIGGER, channelMessageId: "row-1", visitorId: VISITOR });
    expect(state.rows[0]).toMatchObject({ ...ACCOUNT, signedIn: true, status: "answered", replyText: "You are in.\n\nI read acme.io: you sell X." });
  });

  it("every later message of that visitor runs as THEIR account: the row, the run and the turn carry it", async () => {
    const { state, deps, runs, send } = world({ session: accountSession() });
    await send("m2", "what is next?");
    expect(state.rows[0]).toMatchObject({ ...ACCOUNT, status: "answered", signedIn: false });
    expect(runs).toEqual([ACCOUNT]);
    expect(deps.runChat).toHaveBeenCalledTimes(1);
    expect((deps.runChat as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ ...ACCOUNT, sessionId: "s-1", message: "what is next?" });
  });

  it("a guest stays on our own line: the row and the run are ours", async () => {
    const { state, runs, send } = world();
    await send("m1");
    expect(state.rows[0]).toMatchObject({ orgId: LINE.orgId, userId: LINE.userId });
    expect(state.session).toMatchObject({ orgId: LINE.orgId, userId: LINE.userId, guest: true, webVisitorId: VISITOR });
    expect(runs).toEqual([{ orgId: LINE.orgId, userId: LINE.userId }]);
  });

  it("the answer with their account failing never hides that they are in: the first answer is served, the failure logged", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, deps, send } = world();
    (deps.runChat as ReturnType<typeof vi.fn>).mockImplementation(async (args: { orgId: string }) => {
      if (args.orgId === LINE.orgId) {
        Object.assign(state.session!, { ...ACCOUNT, guest: false, webAccountEmail: "ann@acme.io" });
        return { status: 200, body: sse([{ type: "token", content: "You are in." }]) };
      }
      return { status: 502, body: "upstream" };
    });
    expect(await send("m1")).toMatchObject({ status: "answered", reply: "You are in.", account: { signedIn: true, email: "ann@acme.io" } });
    expect(errors.mock.calls.flat().join(" ")).toContain("signed in, but the answer with their account failed");
    errors.mockRestore();
  });

  it("the cookie alone stops opening an account after 30 idle days: they start as a guest and prove the email again", async () => {
    const now = new Date("2026-11-18T10:00:00Z");
    const idle = (ms: number) => ({ guest: false, updatedAt: new Date(now.getTime() - ms) });
    expect(WEB_ACCOUNT_IDLE_MAX_MS).toBe(30 * 86_400_000);
    expect(isLiveWebSession(idle(WEB_ACCOUNT_IDLE_MAX_MS - 1000), now)).toBe(true);
    expect(isLiveWebSession(idle(WEB_ACCOUNT_IDLE_MAX_MS + 1000), now)).toBe(false);
    // A guest conversation carries no account access: it is found again whenever they come back.
    expect(isLiveWebSession({ guest: true, updatedAt: new Date(now.getTime() - 400 * 86_400_000) }, now)).toBe(true);

    const { state, runs, send } = world({ session: accountSession({ updatedAt: new Date(now.getTime() - WEB_ACCOUNT_IDLE_MAX_MS - 60_000) }) });
    const res = await send("back");
    expect(runs).toEqual([{ orgId: LINE.orgId, userId: LINE.userId }]);
    expect(state.rows[0]).toMatchObject({ orgId: LINE.orgId, userId: LINE.userId });
    expect(res.account).toEqual({ signedIn: false, email: null });
    expect(await readWebConversation(fakeDb({ ...state, session: accountSession({ updatedAt: new Date(now.getTime() - WEB_ACCOUNT_IDLE_MAX_MS - 60_000) }) }), VISITOR, now)).toMatchObject({ messages: [], account: { signedIn: false, email: null } });
  });

  it("who the turn runs as: the account once signed in, our line before (a guest, or nobody yet)", () => {
    expect(webIdentityOf(null, LINE)).toEqual({ orgId: LINE.orgId, userId: LINE.userId, guest: true });
    expect(webIdentityOf({ guest: true, orgId: LINE.orgId, userId: LINE.userId }, LINE).guest).toBe(true);
    expect(webIdentityOf({ guest: false, ...ACCOUNT }, LINE)).toEqual({ ...ACCOUNT, guest: false });
  });

  it("an answer to a signed-in visitor that also leaves on WhatsApp is sent in a run of our line, never of their org", async () => {
    const { deps, send } = world({ session: accountSession({ channelPhone: "+33612345678" }) });
    const res = await send("m1");
    expect(res.handOff).toEqual({ channel: "whatsapp", delivered: true, reason: null });
    expect((deps.createRootRun as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([ACCOUNT, LINE]);
    expect(deps.sendWhatsapp).toHaveBeenCalledWith(expect.objectContaining({ orgId: LINE.orgId, runId: "run-2", phone: "+33612345678" }));
  });
});

describe("a turn belongs to the visitor, not to the request that brought it (DISTRY-ONE-AI-1118)", () => {
  // An onboarding step runs past the browser path's 100 s: the site stops waiting at ~85 s and sends the same messageId again.
  it("the same messageId sent again answers in_progress AT ONCE while the first runs, then the whole stored answer, byte-equal", async () => {
    const { state, deps, send } = world();
    let finish!: (v: { status: number; body: string }) => void;
    (deps.runChat as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const first = send("m1", "set up acme.io");
    await vi.waitFor(() => expect(deps.runChat).toHaveBeenCalledTimes(1));
    // The poll is answered while the turn still runs: it never waits behind it.
    expect(await send("m1", "set up acme.io")).toEqual({ status: "in_progress", reply: null, choices: null, handOff: null, continuedOn: null, account: { signedIn: false, email: null } });
    expect(busyVisitors()).toBe(1);
    Object.assign(state.session!, { channelEmail: "ann@acme.io" });
    finish({ status: 200, body: sse([{ type: "token", content: "Here is your plan." }, { type: "choices", question: "Run it?", choices: [{ label: "Yes", description: "start today" }, { label: "Not now" }] }]) });
    const served = await first;
    expect(served).toEqual({
      status: "answered",
      reply: "Here is your plan.",
      choices: { question: "Run it?", choices: [{ label: "Yes", description: "start today" }, { label: "Not now" }] },
      handOff: { channel: "email", delivered: true, reason: null },
      continuedOn: "email",
      account: { signedIn: false, email: null },
    });
    const again = await send("m1", "set up acme.io");
    // The row read back comes in jsonb's key order: the served bytes are the same all the same.
    expect(Object.keys(state.rows[0].answer as object)).not.toEqual(Object.keys(orderedAnswer(state.rows[0].answer as never)));
    expect(JSON.stringify(again)).toBe(JSON.stringify(served));
    expect(deps.runChat).toHaveBeenCalledTimes(1);
    expect(busyVisitors()).toBe(0);
  });

  it("a turn keeps running when nobody waits for it: the answer is on the row for the next call", async () => {
    const { state, deps, send } = world();
    // The caller's wait is cut: its promise is dropped, nothing aborts the turn (no signal reaches it).
    void send("m1").catch(() => undefined);
    expect(answerWebMessage.length).toBe(2);
    await vi.waitFor(() => expect(state.rows[0]?.status).toBe("answered"));
    expect(deps.runChat).toHaveBeenCalledTimes(1);
    expect(await send("m1")).toMatchObject({ status: "answered", reply: "Hello." });
    expect(deps.runChat).toHaveBeenCalledTimes(1);
  });

  it("a turn a restart cut is said failed on its retry, never in_progress forever", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { state, deps, send } = world();
    await acceptWebMessage(deps, { visitorId: VISITOR, messageId: "m1", text: "hi" });
    Object.assign(state.rows[0], { status: "processing" });
    expect((await send("m1")).status).toBe("in_progress");
    state.now = new Date(state.now.getTime() + WEB_TURN_STALE_MS + 1_000);
    expect(await send("m1")).toMatchObject({ status: "failed", reply: CHANNEL_FAILURE_TEXT });
    expect(state.rows[0]).toMatchObject({ status: "failed" });
    expect(deps.runChat).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("a failed turn is stored like an answered one: its retry reads the same line, nothing runs twice", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, send } = world();
    (deps.runChat as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 500, body: "boom" });
    const served = await send("m1");
    expect(served).toMatchObject({ status: "failed", reply: CHANNEL_FAILURE_TEXT, choices: null });
    expect(JSON.stringify(await send("m1"))).toBe(JSON.stringify(served));
    expect(deps.runChat).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("two visitors never wait behind each other; one visitor's messages run one at a time", async () => {
    const { deps } = world();
    const order: string[] = [];
    (deps.runChat as ReturnType<typeof vi.fn>).mockImplementation(async (args: { message: string }) => {
      order.push(`start ${args.message}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${args.message}`);
      return { status: 200, body: sse([{ type: "token", content: "ok" }]) };
    });
    await Promise.all([
      answerWebMessage(deps, { visitorId: VISITOR, messageId: "a1", text: "a1" }),
      answerWebMessage(deps, { visitorId: VISITOR, messageId: "a2", text: "a2" }),
    ]);
    expect(order).toEqual(["start a1", "end a1", "start a2", "end a2"]);
    void processWebMessage;
  });
});
