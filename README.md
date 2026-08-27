# UITester (ToolProof)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Tests web apps through their own WebMCP tools instead of brittle UI selectors.

**Live demo:** https://tuncer-byte.github.io/ui-test-agent/

An autonomous UI test agent that discovers a page's native WebMCP tools (`document.modelContext`) —
or infers them from HTML forms when a site has no native WebMCP support — generates test scenarios,
runs them through real `executeTool()` calls inside a live embedded browser, and reports pass/fail
against the tool's own JSON Schema contract. The interactive Electron app (`webmcp-agent-ui/`) lets
you explicitly pick Gemini-generated or rule-based scenarios per run; the headless CLI (`runner.js`,
used by the codegen agent and the VS Code extension) always uses Gemini for scenarios — there's no
silent mock/rule-based substitution there, so a tool is reported SKIPPED rather than tested with
made-up data if Gemini fails.

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
- `webmcp-demo/agent-runner/codegen-agent.js` — a codegen agent: finds the screen(s) a developer just
  built (via `git diff`/untracked files), extracts the real DOM/validation facts for each `<form>`
  (field types, labels, placeholders, real HTML5 attributes like `pattern`/`required`/`min`/`max`), and
  has **Gemini write the actual WebMCP tool** (name, JSON Schema, success message) from those facts —
  real attributes are passed as ground truth Gemini must not contradict; only where a field has no
  explicit attribute does Gemini use judgement (name/label/placeholder/type) to propose one. Writes the
  result straight into the page's own `TOOLS` array (or, on a page with no existing WebMCP wiring at
  all, adds one self-contained `<script>` block with a polyfill + validator + `TOOLS` array before
  `</body>` — works on any plain HTML page, not just ones already following this project's convention),
  then immediately runs `runner.js`, which asks Gemini for that tool's test scenarios and executes
  them — closing the loop from "new screen" to "tested WebMCP tool" with no manual wiring step. Gemini
  (env `GEMINI_API_KEY`) is **required** end to end here: there is no heuristic/mock fallback for either
  the WebMCP tool itself or its test scenarios, so a form Gemini fails to handle is reported SKIPPED,
  never filled in with synthetic data.
- `webmcp-vscode-extension/` — VS Code extension UI over the codegen agent: tracks edited `.html`
  screens in a sidebar panel, lets you paste/store a Gemini API key (VS Code Secret Storage), and
  runs "Generate WebMCP code" / "Run tests only" per screen with live output streamed into the panel.

## Run

```bash
cd webmcp-agent-ui
npm install
npm start
```

## Codegen agent

Works against any plain HTML page with a `<form>` (real input fields, ideally with HTML5 validation
attributes like `pattern`/`min`/`minlength`/`required` for a tighter inferred schema) — not just
`webmcp-demo/index.html`. After building/editing a screen, run:

```bash
cd webmcp-demo/agent-runner
npm install
export GEMINI_API_KEY=...    # required — Gemini writes the WebMCP tool AND its test scenarios
npm run codegen              # auto-detects the changed screen via git, writes WebMCP code, runs tests
npm run codegen -- --dry-run # preview the generated code without writing it (still calls Gemini)
```

Flags: `--file <path>` to target a specific HTML file, `--base <git-ref>` to diff against a ref instead
of the working tree, `--url <url>` to run tests against a live URL instead of the file directly.
Without `GEMINI_API_KEY`, the whole command refuses to run — nothing here falls back to a
heuristic/mock schema or scenarios.

## License

MIT — see [LICENSE](./LICENSE).

Built for the **OpenAI WebMCP Hackathon**.
