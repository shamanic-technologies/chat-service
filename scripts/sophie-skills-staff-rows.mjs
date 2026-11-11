// SOPHIE-REFONTE-1102: the skill rows a person edited are never touched by the
// boot seed, so the job-skill rewrite reaches them through the skills route,
// as a staff edit (never SQL). Run INSIDE the chat-service container after the
// release is live:
//   node scripts/sophie-skills-staff-rows.mjs            (dry run: prints the plan)
//   node scripts/sophie-skills-staff-rows.mjs --apply
// - budget-and-billing: the seed's "Their money" job skill (SOPHIE-BRIEF-EQUALS-DASHBOARD-1103: no
//   "never mention" rule; a payment notice the dashboard shows is said in its words).
// - legs, triggers: under `staff`, the seed's text (SOPHIE-TURN-LOST-1103: no removed pipes or plays).
// - SOPHIE-CORE-1111: budget-and-billing on today's prepaid offer (refill, monthly limit), no canned replies.
// - SOPHIE-TRUTH-1105: any row a chat-service script wrote takes the seed's text (person facts from
//   their own record, money with its scope, framework v10 only); a person's edit is listed, never overwritten.
import { SEED_SKILLS } from "../dist/lib/skill-seed.js";

const base = `http://localhost:${process.env.PORT ?? 8080}`;
const headers = { "content-type": "application/json", "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" };
const editedBy = "chat-service SOPHIE-CORE-1111";
const apply = process.argv.includes("--apply");

async function read(slug) {
  const res = await fetch(`${base}/internal/skills/${slug}`, { headers });
  if (!res.ok) throw new Error(`GET ${slug} answered ${res.status}: ${await res.text()}`);
  return res.json();
}

async function write(slug, body) {
  if (!apply) return console.log(`[dry run] PUT ${slug}`, JSON.stringify({ ...body, content: `${body.content.length} chars` }));
  const res = await fetch(`${base}/internal/skills/${slug}`, { method: "PUT", headers, body: JSON.stringify({ ...body, editedBy }) });
  if (!res.ok) throw new Error(`PUT ${slug} answered ${res.status}: ${await res.text()}`);
  const out = await res.json();
  console.log(`PUT ${slug}: parent ${out.skill.parentSlug}, version ${out.skill.version}`);
}

// SOPHIE-TRUTH-1105: every seed skill whose row a chat-service script wrote (never a person) takes
// the seed's text; a row a person edited is printed for review and left alone.
for (const seed of SEED_SKILLS) {
  let row;
  try {
    row = await read(seed.slug);
  } catch (err) {
    console.log(`${seed.slug}: ${err.message}`);
    continue;
  }
  const by = row.updatedBy ?? "";
  if (by === "seed") continue; // the boot seed refreshes it
  if (row.content === seed.content && row.parentSlug === seed.parentSlug) { console.log(`${seed.slug}: already the seed's text`); continue; }
  if (!by.startsWith("chat-service")) { console.log(`${seed.slug}: edited by ${by}, left alone (review it)`); continue; }
  await write(seed.slug, { content: seed.content, title: seed.title, description: seed.description, parentSlug: seed.parentSlug });
}
