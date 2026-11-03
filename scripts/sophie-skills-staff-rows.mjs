// SOPHIE-REFONTE-1102: the skill rows a person edited are never touched by the
// boot seed, so the job-skill rewrite reaches them through the skills route,
// as a staff edit (never SQL). Run INSIDE the chat-service container after the
// release is live:
//   node scripts/sophie-skills-staff-rows.mjs            (dry run: prints the plan)
//   node scripts/sophie-skills-staff-rows.mjs --apply
// - budget-and-billing: the seed's "Their money" job skill (SOPHIE-BRIEF-EQUALS-DASHBOARD-1103: no
//   "never mention" rule; a payment notice the dashboard shows is said in its words).
// - legs, triggers: under `staff`, the seed's text (SOPHIE-TURN-LOST-1103: no removed pipes or plays).
import { SEED_SKILLS } from "../dist/lib/skill-seed.js";

const base = `http://localhost:${process.env.PORT ?? 8080}`;
const headers = { "content-type": "application/json", "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" };
const editedBy = "chat-service SOPHIE-REFONTE-1102";
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

const money = SEED_SKILLS.find((s) => s.slug === "budget-and-billing");
await write("budget-and-billing", { content: money.content, title: money.title, description: money.description, parentSlug: "index" });
for (const slug of ["legs", "triggers"]) {
  const seed = SEED_SKILLS.find((s) => s.slug === slug);
  const row = await read(slug);
  if (row.parentSlug === "staff" && row.content === seed.content) { console.log(`${slug}: already the seed's text`); continue; }
  await write(slug, { content: seed.content, title: seed.title, description: seed.description, parentSlug: "staff" });
}
