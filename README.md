# ui-test-agent (ToolProof)

Tests web apps through their own WebMCP tools instead of brittle UI selectors.

An autonomous UI test agent that discovers a page's native WebMCP tools (`document.modelContext`) —
or infers them from HTML forms when a site has no native WebMCP support — generates test scenarios
with Gemini (with a deterministic rule-based fallback), runs them through real `executeTool()` calls
inside a live embedded browser, and reports pass/fail against the tool's own JSON Schema contract.

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

Built for the **OpenAI WebMCP Hackathon**.
