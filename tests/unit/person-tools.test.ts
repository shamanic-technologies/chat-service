import { describe, it, expect } from "vitest";
import { sessionToolNamesFor, GUEST_CONFIG_TOOLS } from "../../src/agent/person-tools.js";
import { SOPHIE_TOOLS } from "../../src/agent/sophie.js";
import { withAccountSetup } from "../../src/lib/account-setup.js";
import { leadTurnToolNames } from "../../src/lib/lead-turn.js";
import { withOurWebsite } from "../../src/lib/person-facing.js";
import { CLIENT_UI_TOOL_NAMES } from "../../src/lib/ui-tools.js";
import { skillIndexBlockFrom } from "../../src/lib/skills.js";
import { SEED_SKILLS } from "../../src/lib/skill-seed.js";
import * as skills from "../../src/lib/skills.js";

const CONFIG = withAccountSetup([...SOPHIE_TOOLS]);

// DISTRY-ONE-AI-1118 (owner 2026-11-18: « d'avoir mis une AI différente sur le widget que sur le reste
// de l'infra n'est pas ce que je veux. Je veux une unique AI quel que soit le canal »). Prod 2026-11-18
// 07:53: the website gave a visitor 2 tools, WhatsApp gave a guest 2 others.
describe("the tools of a turn are keyed on who the person is, never on the channel (DISTRY-ONE-AI-1118)", () => {
  it("a guest gets the same list on WhatsApp and on our website; the website adds its one delivery tool", () => {
    const whatsapp = sessionToolNamesFor({ configTools: CONFIG, guest: true, canSignIn: true, website: false });
    const website = sessionToolNamesFor({ configTools: CONFIG, guest: true, canSignIn: true, website: true });
    // Their plan (DISTRY-ONE-AI-1118 B): the API tools an account uses, run on the conversation's unclaimed org.
    expect(whatsapp).toEqual(["read_skill", "present_choices", "find_operation", "describe_operation", "run_operation", "start_sign_in", "complete_sign_in"]);
    expect(website).toEqual([...whatsapp, "continue_on_channel"]);
  });

  it("a guest turn holds no tool that reads or acts on an account (their plan's calls go through the server's allowlist)", () => {
    const guest = withOurWebsite(sessionToolNamesFor({ configTools: CONFIG, guest: true, canSignIn: true, website: true }), true);
    for (const banned of ["request_staff", "contact_human", "create_followup", "list_followups", "report_not_good", "open_page", "create_brand_from_url", "create_prepaid_checkout"]) {
      expect(guest, banned).not.toContain(banned);
    }
    expect(guest).toContain("read_our_website");
    expect(GUEST_CONFIG_TOOLS).toEqual(["read_skill", "present_choices"]);
  });

  it("an account gets the config's tools on every channel, plus sign-in where the session can change hands", () => {
    const dashboard = sessionToolNamesFor({ configTools: CONFIG, guest: false, canSignIn: false, website: false });
    const whatsapp = sessionToolNamesFor({ configTools: CONFIG, guest: false, canSignIn: true, website: false });
    const website = sessionToolNamesFor({ configTools: CONFIG, guest: false, canSignIn: true, website: true });
    expect(dashboard).toEqual(CONFIG);
    expect(whatsapp).toEqual([...CONFIG, "start_sign_in", "complete_sign_in"]);
    expect(website).toEqual(whatsapp);
  });

  it("a guest lead turn on our brand reads the skills; it signs in only where a number ties the session", () => {
    const withNumber = leadTurnToolNames(sessionToolNamesFor({ configTools: CONFIG, guest: true, canSignIn: true, website: false }), CLIENT_UI_TOOL_NAMES);
    const byEmail = leadTurnToolNames(sessionToolNamesFor({ configTools: CONFIG, guest: true, canSignIn: false, website: false }), CLIENT_UI_TOOL_NAMES);
    expect(withNumber).toEqual(["read_skill", "find_operation", "describe_operation", "run_operation", "start_sign_in", "complete_sign_in", "reach_person_elsewhere", "answer_person"]);
    expect(byEmail).toEqual(["read_skill", "reach_person_elsewhere", "answer_person"]);
  });

  it("a config that reads no skill gives a guest nothing of its own", () => {
    expect(sessionToolNamesFor({ configTools: ["list_workflows", "open_page"], guest: true, canSignIn: false, website: false })).toEqual([]);
  });
});

describe("a guest reads the same skills as an account (DISTRY-ONE-AI-1118)", () => {
  it("there is one skill block: the index with the voice and every client job, no guest-only text", () => {
    expect(Object.keys(skills)).not.toContain("buildGuestSkillsBlock");
    expect(Object.keys(skills)).not.toContain("guestSkillsBlockFrom");
    const block = skillIndexBlockFrom(SEED_SKILLS);
    expect(block).toContain("# How we talk to a person");
    expect(block).toContain("- `our-offer`:");
    expect(block).toContain("- `new-account`:");
  });
});
