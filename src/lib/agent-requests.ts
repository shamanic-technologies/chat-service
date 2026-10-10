import type { db as Db } from "../db/index.js";
import { getSkill } from "./skills.js";
import {
  StaffRequestValidationError,
  parseContactHumanArgs,
  parseSkillUpgradeArgs,
  parseStaffRequestArgs,
  submitStaffRequest,
  type StaffRequestContext,
  type StaffRequestDeps,
  type StaffRequestResult,
} from "./staff-requests.js";

// ---------------------------------------------------------------------------
// Requests FROM the agent, no friction (owner 2026-10-10). One entry point per
// kind for the model (request_staff, request_skill_upgrade, contact_human) and
// one HTTP route (`POST /orgs/staff-requests`, `kind` in the body) for any
// other agent. All land in `staff_requests` and reach someone who acts:
//   bug / feature   -> GitHub issue in the owning repo + Telegram
//   skill_upgrade   -> GitHub issue (chat-service for a skill, else the repo
//                      whose doc is wrong) with the proposed text + Telegram
//   contact_human   -> Telegram to the owner, now (no issue)
// ---------------------------------------------------------------------------

type Database = typeof Db;

export const AGENT_REQUEST_KINDS = ["bug", "feature", "skill_upgrade", "contact_human"] as const;

/** request_skill_upgrade: refuses a skill slug that does not exist (the model must name a real one). */
export async function fileSkillUpgrade(
  database: Database,
  ctx: StaffRequestContext,
  args: Record<string, unknown>,
  deps?: StaffRequestDeps,
): Promise<StaffRequestResult> {
  const input = parseSkillUpgradeArgs(args);
  if (input.skillSlug) await getSkill(database, input.skillSlug);
  const { skillSlug: _skillSlug, ...request } = input;
  return submitStaffRequest(database, ctx, request, deps);
}

export function fileContactHuman(
  database: Database,
  ctx: StaffRequestContext,
  args: Record<string, unknown>,
  deps?: StaffRequestDeps,
): Promise<StaffRequestResult> {
  const { urgency: _urgency, ...request } = parseContactHumanArgs(args);
  return submitStaffRequest(database, ctx, request, deps);
}

export function fileStaffRequest(
  database: Database,
  ctx: StaffRequestContext,
  args: Record<string, unknown>,
  deps?: StaffRequestDeps,
): Promise<StaffRequestResult> {
  return submitStaffRequest(database, ctx, parseStaffRequestArgs(args), deps);
}

/** The HTTP route: `kind` picks the same path the matching tool takes. */
export function fileAgentRequest(
  database: Database,
  ctx: StaffRequestContext,
  args: Record<string, unknown>,
  deps?: StaffRequestDeps,
): Promise<StaffRequestResult> {
  switch (args.kind) {
    case "bug":
    case "feature":
      return fileStaffRequest(database, ctx, args, deps);
    case "skill_upgrade":
      return fileSkillUpgrade(database, ctx, args, deps);
    case "contact_human":
      return fileContactHuman(database, ctx, args, deps);
    default:
      throw new StaffRequestValidationError(`kind must be one of ${AGENT_REQUEST_KINDS.join(", ")}`);
  }
}
