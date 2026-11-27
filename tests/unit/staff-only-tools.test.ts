import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  STAFF_ONLY_TOOLS,
  hasStaffOnlyTool,
  lookupRequester,
  toolsForRequester,
} from "../../src/lib/staff-only-tools.js";

const CONFIG_TOOLS = ["list_workflows", "get_prompt_template", "update_prompt_template", "read_skill"];

describe("staff-only Copilot tools", () => {
  it("covers the shared prompt-template tools", () => {
    expect([...STAFF_ONLY_TOOLS].sort()).toEqual([
      "create_play",
      "create_strategy",
      "create_tactic",
      "get_prompt_template",
      "update_prompt_template",
    ]);
    expect(hasStaffOnlyTool(CONFIG_TOOLS)).toBe(true);
    expect(hasStaffOnlyTool(["list_workflows"])).toBe(false);
  });

  it.each([
    ["cfe148ed-e3d8-40a2-8920-f8c040a81934", "kevin.lourd@gmail.com"],
    ["7b417d70-29b5-471b-a8e1-20e75225c0af", "kevin@distribute.you"],
  ])("the real staff user %s keeps the prompt tools", async (userId, email) => {
    const requester = await lookupRequester(userId, async () => email);
    expect(requester).toEqual({ email, isStaff: true });
    expect(toolsForRequester(CONFIG_TOOLS, requester)).toEqual(CONFIG_TOOLS);
  });

  it.each([
    "kevin.lourd@gmail.com",
    "kevin@distribute.you",
    "anyone@distribute.you",
  ])("a customer user storing %s is not staff: no prompt tools, catalogue not staff (SEC-STAFF-EMAIL-1120)", async (email) => {
    // Prod 2026-11-20: a customer key created this user row carrying the owner's address.
    const requester = await lookupRequester("a4651533-7acc-4c6e-be22-3a9b0e037568", async () => email);
    expect(requester.isStaff).toBe(false);
    expect(toolsForRequester(CONFIG_TOOLS, requester)).toEqual(["list_workflows", "read_skill"]);
  });

  it("fleet-wide catalogue creates: staff keeps them, a customer never sees them, reads stay (COPILOT-CATALOGUE-GATE-1127)", async () => {
    const tools = ["find_tactics", "find_strategies", "find_plays", "create_tactic", "create_strategy", "create_play", "create_sales_funnel", "create_sales_path"];
    expect(hasStaffOnlyTool(tools)).toBe(true);
    const staff = await lookupRequester("cfe148ed-e3d8-40a2-8920-f8c040a81934", async () => "kevin.lourd@gmail.com");
    expect(toolsForRequester(tools, staff)).toEqual(tools);
    const client = await lookupRequester("3afacd9a-fe2f-4413-b51f-217f30920830", async () => "founder@acme.com");
    expect(toolsForRequester(tools, client)).toEqual(["find_tactics", "find_strategies", "find_plays", "create_sales_funnel", "create_sales_path"]);
  });

  it("a customer never sees the prompt tools", async () => {
    const requester = await lookupRequester("u-client", async () => "founder@acme.com");
    expect(requester.isStaff).toBe(false);
    expect(toolsForRequester(CONFIG_TOOLS, requester)).toEqual(["list_workflows", "read_skill"]);
  });

  it("an unknown user or a failed lookup is a customer (fail closed)", async () => {
    const unknown = await lookupRequester("u-ghost", async () => null);
    expect(toolsForRequester(CONFIG_TOOLS, unknown)).toEqual(["list_workflows", "read_skill"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await lookupRequester("u-x", async () => {
      throw new Error("client-service 503");
    });
    expect(failed).toEqual({ email: null, isStaff: false });
    expect(toolsForRequester(CONFIG_TOOLS, failed)).toEqual(["list_workflows", "read_skill"]);
    spy.mockRestore();
  });
});

describe("/chat wiring (source guard)", () => {
  const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

  it("filters the config's tools by requester before the tool set and guard are built", () => {
    const filterAt = src.indexOf("toolsForRequester(configToolNames, await getRequester())");
    const setAt = src.indexOf("const allowedToolSet = new Set(allowedToolNames)");
    expect(filterAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(filterAt);
  });

  it("drops Distry's principal tools unless staff talk for themselves, before the tool set is built (DISTRY-PRINCIPAL-1119)", () => {
    const gateAt = src.indexOf("withoutPrincipalToolsUnlessAllowed(");
    const setAt = src.indexOf("const allowedToolSet = new Set(allowedToolNames)");
    expect(gateAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(gateAt);
    // Every principal dispatch re-checks the gate.
    expect(src.match(/if \(!principalAllowed\) throw new Error/g)?.length).toBe(2);
  });

  it("every staff grant reads the one requester lookup (catalogue, principal tools, prompt tools)", () => {
    expect(src).toContain("isStaff: () => getRequester().then((r) => r.isStaff)");
    expect(src).toContain("requesterIsStaff: (await getRequester()).isStaff");
    expect(src).not.toContain("isStaffEmail");
  });

  it("both prompt tools forward the staff email", () => {
    const getAt = src.indexOf('if (call.name === "get_prompt_template")');
    const updAt = src.indexOf('if (call.name === "update_prompt_template")');
    const end = src.indexOf("// API Registry progressive disclosure tools", updAt);
    expect(src.slice(getAt, updAt)).toContain("staffEmail: await staffEmailOrThrow()");
    expect(src.slice(updAt, end)).toContain("staffEmail: await staffEmailOrThrow()");
  });
});
