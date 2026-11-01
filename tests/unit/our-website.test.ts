import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_REGISTRY } from "../../src/lib/anthropic.js";
import { PART_CHARS, clearOurWebsiteCache, htmlToPage, ourSitePath, readOurWebsite } from "../../src/lib/our-website.js";
import { aboutYouBlock, withOurWebsite } from "../../src/lib/person-facing.js";

// CHAT-TRUTH-1101: the Copilot reads our public site (index, then the pages it
// picks) instead of guessing what we charge, what our terms or privacy say.
const TERMS_HTML = `<!doctype html><html><head><style>.x{}</style></head><body><nav>Menu Pricing Login</nav>
<main><h1>Terms of Service</h1><p>Last updated: October 30, 2026</p>
<h2>4. Pricing, Credit, and Payment</h2><p>We set each catalogue price at the vendor&#x27;s list price for that tool, with no markup added.</p>
<p>Costs that come with running your account, such as chat with our AI agent, are billed the same way.</p>
<script>window.x=1</script></main><footer>Footer links</footer></body></html>`;

function site(pages: Record<string, { status?: number; type: string; body: string }>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const p = pages[new URL(url).pathname];
    if (!p) return new Response("not found", { status: 404 });
    const r = new Response(p.body, { status: p.status ?? 200, headers: { "content-type": p.type } });
    Object.defineProperty(r, "url", { value: url });
    return r;
  });
  return { calls, deps: { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 } };
}

describe("read_our_website", () => {
  beforeEach(() => clearOurWebsiteCache());

  it("no page reads the site index (llms.txt)", async () => {
    const { calls, deps } = site({ "/llms.txt": { type: "text/plain", body: "# distribute.you\n> Revenue made easy.\n- Terms: https://distribute.you/terms" } });
    const out = await readOurWebsite({}, deps);
    expect(calls).toEqual(["https://distribute.you/llms.txt"]);
    expect(out).toMatchObject({ url: "https://distribute.you/llms.txt", part: 1, parts: 1 });
    expect(out.text).toContain("Revenue made easy.");
  });

  it("reads /terms on demand: the main text, no menu, footer or script", async () => {
    const { deps } = site({ "/terms": { type: "text/html; charset=utf-8", body: TERMS_HTML } });
    const out = await readOurWebsite({ page: "/terms" }, deps);
    expect(out.text).toContain("## 4. Pricing, Credit, and Payment");
    expect(out.text).toContain("vendor's list price for that tool, with no markup added");
    expect(out.text).toContain("chat with our AI agent, are billed the same way");
    for (const gone of ["Menu", "Footer", "window.x", ".x{}"]) expect(out.text).not.toContain(gone);
  });

  it("reads /privacy on demand", async () => {
    const { calls, deps } = site({ "/privacy": { type: "text/html", body: "<main><h1>Privacy Policy</h1><p>We do not sell it.</p></main>" } });
    const out = await readOurWebsite({ page: "privacy" }, deps);
    expect(calls).toEqual(["https://distribute.you/privacy"]);
    expect(out.text).toContain("We do not sell it.");
  });

  it("a long page comes in parts of ~2k tokens, with an outline pointing at each heading", async () => {
    const long = `<main><h2>A</h2><p>${"a".repeat(PART_CHARS)}</p><h2>B</h2><p>${"b".repeat(100)}</p></main>`;
    const { deps } = site({ "/terms": { type: "text/html", body: long } });
    const one = await readOurWebsite({ page: "/terms" }, deps);
    expect(one.parts).toBe(2);
    expect(one.text.length).toBeLessThanOrEqual(PART_CHARS);
    expect(one.outline).toEqual([{ heading: "A", part: 1 }, { heading: "B", part: 2 }]);
    const two = await readOurWebsite({ page: "/terms", part: 2 }, deps);
    expect(two.text).toContain("## B");
    await expect(readOurWebsite({ page: "/terms", part: 3 }, deps)).rejects.toThrow("has 2 parts");
  });

  it("only ever fetches distribute.you", async () => {
    expect(ourSitePath("https://distribute.you/terms")).toBe("/terms");
    expect(ourSitePath("/catalog/")).toBe("/catalog");
    for (const elsewhere of ["https://evil.example/terms", "http://distribute.you/terms", "https://distribute.you.evil.example/x", "//evil.example/x"]) {
      expect(() => ourSitePath(elsewhere)).toThrow();
    }
  });

  it("a redirect off our site is refused", async () => {
    const fetchImpl = vi.fn(async () => {
      const r = new Response("<main>x</main>", { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(r, "url", { value: "https://evil.example/x" });
      return r;
    });
    await expect(readOurWebsite({ page: "/go" }, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 })).rejects.toThrow("redirected off our site");
  });

  it("a page that does not exist says so and points at the index", async () => {
    const { deps } = site({});
    await expect(readOurWebsite({ page: "/nope" }, deps)).rejects.toThrow("Read the index");
  });

  it("the tool carries the strategy (read the site first, answer from it), never policy text", () => {
    const d = TOOL_REGISTRY.read_our_website.description ?? "";
    expect(d).toContain("read the site FIRST");
    expect(d).not.toMatch(/markup|margin of|\$\d/i);
  });

  it("htmlToPage keeps headings as lines", () => {
    expect(htmlToPage("<main><h2>X &amp; Y</h2><p>z</p></main>").text).toBe("## X & Y\n\nz");
  });
});

describe("a chat that speaks for us", () => {
  it("gets the site reader once, only when it speaks for us", () => {
    expect(withOurWebsite(["read_skill"], true)).toEqual(["read_skill", "read_our_website"]);
    expect(withOurWebsite(["read_skill", "read_our_website"], true)).toEqual(["read_skill", "read_our_website"]);
    expect(withOurWebsite(["answer_person"], false)).toEqual(["answer_person"]);
  });

  it("knows the model it runs on by its public name", () => {
    expect(aboutYouBlock("Claude Sonnet 5.5")).toContain("running on Claude Sonnet 5.5");
  });
});
