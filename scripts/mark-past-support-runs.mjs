// One-off backfill (COST-SUPPORT-1024): marks chat-service's PAST support runs
// through runs-service's owner door (`POST /v1/platform-runs/support-marks/{preview,apply}`),
// so their spend is reported apart per support function, never on an outcome.
// New runs are marked at creation (src/lib/support-marks.ts); this covers
// everything since 2026-02-02. Idempotent: an already marked run writes nothing.
//
// Run inside the chat-service container (it holds RUNS_SERVICE_URL/_API_KEY):
//   node scripts/mark-past-support-runs.mjs preview [runIdsFile.json]
//   node scripts/mark-past-support-runs.mjs apply   [runIdsFile.json]
// runIdsFile = [{ kind, reason, runIds: [...] }]: runs no selection can name
// (e.g. dashboard chats, picked by their parent run), resolved read-only.

const MODE = process.argv[2];
const RUN_IDS_FILE = process.argv[3];
if (MODE !== "preview" && MODE !== "apply") throw new Error("usage: preview|apply [runIdsFile.json]");

const URL_BASE = process.env.RUNS_SERVICE_URL;
const KEY = process.env.RUNS_SERVICE_API_KEY;
if (!URL_BASE || !KEY) throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY are required");

const MARKED_BY = "chat-service COST-SUPPORT-1024 backfill";
const START = "2026-02-02T00:00:00Z";

// Monthly windows keep each apply under runs-service's per-apply cap.
function monthWindows(fromIso, toIso) {
  const out = [];
  let d = new Date(fromIso);
  const end = new Date(toIso);
  while (d < end) {
    const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    out.push([d.toISOString(), (next < end ? next : end).toISOString()]);
    d = next;
  }
  return out;
}

const SELECTIONS = [
  {
    kind: "platform_llm",
    reason: "chat-service platform LLM / judgment / image / transcription call made for no caller run",
    taskNames: ["platform-complete", "platform-judgments", "generate-image", "transcribe-media"],
    topLevelOnly: true,
  },
  {
    kind: "copilot",
    reason: "chat-service Copilot: WhatsApp Copilot turns (root run covers its chat turn) and Copilot nudges",
    taskNames: ["copilot-whatsapp", "copilot-nudge"],
  },
];

async function post(step, body) {
  const res = await fetch(`${URL_BASE}/v1/platform-runs/support-marks/${step}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "x-service-name": "chat-service" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`support-marks/${step} ${res.status}: ${text}`);
  return JSON.parse(text);
}

const totals = {};
function add(kind, r) {
  const t = (totals[kind] ??= { matched: 0, toMark: 0, already: 0, declaresOutcomes: 0, onOutcomeNow: 0, grossCents: 0, marked: 0 });
  t.matched += r.matchedRunCount ?? 0;
  t.toMark += r.toMarkCount ?? 0;
  t.already += r.alreadyMarkedCount ?? 0;
  t.declaresOutcomes += r.declaresOutcomesCount ?? 0;
  t.onOutcomeNow += r.onOutcomeNowCount ?? 0;
  t.grossCents += Number(r.spend?.grossCents ?? 0);
  t.marked += r.markedCount ?? 0;
}

const now = new Date().toISOString();
for (const sel of SELECTIONS) {
  for (const [startedAfter, startedBefore] of monthWindows(START, now)) {
    const body = {
      kind: sel.kind,
      reason: sel.reason,
      markedBy: MARKED_BY,
      taskNames: sel.taskNames,
      startedAfter,
      startedBefore,
      ...(sel.topLevelOnly ? { topLevelOnly: true } : {}),
    };
    const preview = await post("preview", body);
    if (preview.tooMany) throw new Error(`${sel.kind} ${startedAfter}: too many runs for one apply, narrow the window`);
    add(sel.kind, preview);
    if (MODE === "apply" && preview.toMarkCount > 0) add(sel.kind, { markedCount: (await post("apply", body)).markedCount });
  }
}

if (RUN_IDS_FILE) {
  const { readFileSync } = await import("node:fs");
  for (const group of JSON.parse(readFileSync(RUN_IDS_FILE, "utf8"))) {
    for (let i = 0; i < group.runIds.length; i += 5000) {
      const body = { kind: group.kind, reason: group.reason, markedBy: MARKED_BY, runIds: group.runIds.slice(i, i + 5000) };
      add(group.kind, await post("preview", body));
      if (MODE === "apply") add(group.kind, { markedCount: (await post("apply", body)).markedCount });
    }
  }
}

for (const [kind, t] of Object.entries(totals)) {
  console.log(
    `[chat-service] ${MODE} ${kind}: matched=${t.matched} toMark=${t.toMark} alreadyMarked=${t.already} declaresOutcomes=${t.declaresOutcomes} onOutcomeNow=${t.onOutcomeNow} spend=$${(t.grossCents / 100).toFixed(2)}${MODE === "apply" ? ` marked=${t.marked}` : ""}`,
  );
}
