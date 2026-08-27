# UITester (UITester)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Tests web apps through their own WebMCP tools instead of brittle UI selectors.

**Live demo:** https://tuncer-byte.github.io/ui-test-agent/

An autonomous UI test agent that discovers a page's native WebMCP tools (`document.modelContext`) —
or infers them from HTML forms when a site has no native WebMCP support — generates test scenarios
with Gemini (with a deterministic rule-based fallback), runs them through real `executeTool()` calls
inside a live embedded browser, and reports pass/fail against the tool's own JSON Schema contract.

## Why WebMCP

Selector-based UI testing breaks every time a page is redesigned, because it has to *guess* intent
from CSS classes and DOM structure. WebMCP changes that: a page exposes its own capabilities as
named tools with a real JSON Schema contract (`registerTool` / `getTools` / `executeTool`) — no
guessing required.

That contract is what makes agent-to-page collaboration possible: an agent doesn't need to know
what a "Send Transfer" button looks like, only that a `submitTransfer` tool exists and what shape
of input it accepts. For a human, this means the same web app can now be driven by an AI assistant
without the site owner building a separate API. For a test agent specifically, it means QA can
verify a page's actual behavioral contract — required fields, formats, boundaries — instead of
its rendered pixels, which is both more reliable and closer to what a QA engineer actually cares
about.

## Structure

- `webmcp-agent-ui/` — Electron app: the agent shell (discover → generate scenarios → run → report).
- `webmcp-demo/` — demo target page with a native `document.modelContext.registerTool` implementation,
  plus `agent-runner/`, a headless Playwright-based runner for the same flow.

## Run

```bash
cd webmcp-agent-ui
npm install
npm start
```

## License

MIT — see [LICENSE](./LICENSE).

Built for the **OpenAI WebMCP Hackathon**.
