# HN Post Draft

## Title:

**Show HN: AXON – Tool protocol for AI agents with out-of-context result storage**

---

## Body:

Hey HN,

We've been building AI agents that automate Chrome and hit a wall with MCP (Model Context Protocol). The problem: MCP dumps every tool result directly into the model's context window. For simple tools (read a file, run a query), this is fine. For browser automation, it's fatal.

A single Wikipedia screenshot is ~92K tokens of base64. Three screenshots and you've blown past the 200K context window. The model loses all the data it collected and can't answer the user's question.

So we built AXON (Agent eXchange Over Network), a protocol designed for the agent era:

**1. Out-of-Context Result Store (OCRS)** — Tool results are stored externally in a content-addressed store. The model gets a compact summary + reference handle (~23 tokens instead of ~92K for a screenshot). When it needs detail, it does a targeted drill-down.

**2. 3-Tier Lazy Discovery** — Instead of dumping all tool schemas upfront (~4,918 tokens for 14 Chrome tools), AXON uses compact manifests (~401 tokens) with on-demand schema fetching. This eliminates a real class of bugs where the model "forgets" tool parameters in long sessions.

**3. Capability-Based Security** — Unforgeable tokens with scope globs, TTL expiry, and attenuation. MCP has no tool-level auth at all.

We ran a real benchmark — 26 tool calls against live public websites (example.com, Wikipedia, httpbin.org) using actual Puppeteer in headless Chrome:

- Context: 266,660 tokens (MCP) → 720 tokens (AXON) — 99.7% reduction, 370x smaller
- Wire size: 1.02 MB (MCP) → 4.0 KB (AXON) — 99.6% reduction
- MCP overflows the 200K context window at 146.8% capacity. AXON uses 0.6%.
- Security: 8/8 capability checks vs 0/8

The biggest wins are screenshots — a Wikipedia page screenshot is 91,800 MCP tokens reduced to 23 AXON tokens. Even text extraction on Wikipedia (14,288 tokens) compresses to 55 tokens.

The SDK is TypeScript, the Chrome server has 14 tools, and there's an MCP-compatible stdio wrapper so you can use it with Claude Desktop or Cursor today with zero migration.

GitHub: https://github.com/hchihoub/axon-protocol
npm: `npm install @axon-protocol/sdk`

Limitations we're upfront about: the "research quality" comparison in the blog is simulated (we measure real bytes but quality scoring is theoretical). OCRS adds complexity. read_page falls back to error summaries on some sites. The project is early (v0.1.0). We'd love feedback from anyone building agent tooling.

---

## Tips for posting:

1. Post around 9-10 AM ET on a weekday (Tue-Thu best)
2. Don't self-upvote or ask friends to upvote
3. Reply to every comment within the first 2 hours
4. Be honest about tradeoffs in the comments — HN respects that
5. If someone asks "why not just fix MCP?" — acknowledge it's a valid approach and explain why protocol-level changes were needed
6. Link to the benchmark script so people can reproduce: servers/chrome/benchmark-real.ts
