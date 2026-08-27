# WebMCP Agent (VS Code extension)

Tracks the screens you're editing and, on demand, has **Gemini write** real
`document.modelContext.registerTool(...)` WebMCP code for them, then has
Gemini write and run test scenarios against the page — all without leaving
the editor, and in **any** workspace (it doesn't need to be this ToolProof
repo).

It's a thin UI layer over `codegen-agent.js` (codegen) and `runner.js` (test
execution), bundled inside `agent-runner/` in this extension — it doesn't
reimplement that logic, it drives its own copy of it. That copy works
against any plain HTML page with a `<form>`: if the page already has a
`TOOLS` array (this project's own convention), it extends it; if the page
has no WebMCP wiring at all, it adds one self-contained `<script>` block
(polyfill + validator + `TOOLS` array) right before `</body>`.

## How it works

1. **Tracking** — a file watcher on `**/*.html` (configurable) flags any
   screen you save as "changed" in the sidebar. Nothing runs automatically;
   you act on it when ready.
2. **Gemini writes the tool** — click "Generate WebMCP code": the extension
   extracts the real DOM/validation facts for each `<form>` (field types,
   labels, placeholders, real HTML5 attributes like
   `pattern`/`required`/`min`/`max`) and sends them to Gemini, which writes
   the actual tool — name, JSON Schema, success message. Real attributes are
   passed as ground truth Gemini must not contradict; only where a field has
   no explicit attribute does Gemini use judgement (name/label/placeholder)
   to propose one.
3. **Gemini writes and runs the tests** — right after writing the code, the
   bundled `runner.js` loads the page, asks Gemini for that tool's test
   scenarios, executes them via real `executeTool()` calls, and reports
   pass/fail — streamed live into the panel with colorized PASS/FAIL/SKIPPED
   lines.
4. **Run tests only** — re-runs just the Gemini-scenario test step against a
   screen without touching its code (useful after you hand-edit a generated
   tool).
5. **Simulate** — opens `webmcp-agent-ui` (the Electron demo shell in this
   repo) and replays the *exact* scenarios from the last Generate/Run-tests
   run for that screen, visually: it starts a tiny local static server for
   the file's directory (so the page loads over a real `http://` URL, the
   way these screens are normally served, instead of `file://`), launches
   the app with `--preload=<run report>.json --url=<served URL>`, which
   auto-loads the page, auto-discovers the tool, and drives the same
   cursor-fill-in + `executeTool()` loop as a manual click of "Run Tests via
   WebMCP" — one call to Gemini during Generate/Run-tests, zero more calls
   to watch it play out visually. Needs a prior Generate/Run-tests for that
   screen (there's a report to replay). Works in any workspace: only
   webmcp-agent-ui's small *source* files are bundled (Electron itself is
   ~100-200MB, too large for the `.vsix`) — the first "Simulate" click
   copies them into this extension's persistent storage and runs
   `npm install` there once; every workspace after that reuses it. If a
   copy with Electron already installed is found in the current workspace
   (e.g. this monorepo), that's reused instead, skipping the download.
6. **Getting past a login/consent screen** — real apps often gate the
   screen under test behind a prior step. If navigating to the target
   redirects elsewhere instead, the agent looks for a WebMCP tool that
   *already exists* on wherever it landed (the developer wires that up
   the same way any other screen gets one — e.g. add WebMCP to the login
   screen too) and calls it with the test credentials configured in
   settings (⚙ → Test credentials), then retries the original target. No
   scripted login automation and no saved browser sessions — it's the
   same "discover and call a real tool" mechanism used everywhere else in
   this pipeline, just aimed at the screen that's in the way first.
7. **When a gate doesn't redirect** — some apps (SPAs especially) render
   their login/consent screen in place, at the same URL, instead of
   navigating away — the URL-based check above can't see that. So Gemini
   is also asked, while writing a tool for whatever form it's looking at,
   to judge whether that form is actually the feature under test or a
   gate that just happens to be on screen right now — using the form's
   own fields/labels/heading, and your **App notes** (⚙ → App notes: free
   text about the app, e.g. "this app requires login first, the login
   screen isn't a feature to test"). If Gemini says it's a gate, the agent
   uses the same existing-tool-plus-credentials mechanism to get past it,
   then re-analyzes the screen — once, not in an unbounded loop.
8. **No mock, ever** — there is no heuristic/rule-based fallback anywhere in
   this pipeline, for either the tool's schema or its test scenarios (or
   the credentials used to get past a gate — without them configured, a
   gated screen fails with a clear reason instead of guessing a way past
   it). Without a Gemini key, "Generate" and "Run tests only" refuse to
   start; if Gemini fails mid-run for a specific form/tool, that one is
   reported SKIPPED, never silently filled in with synthetic data.

## UI at a glance

- The Gemini API key/model fields live behind the **⚙ gear icon** in the
  view's title bar (auto-opened the first time, before a key is saved) —
  the main panel stays focused on your screens instead of a settings form.
- While a run is in progress, each tracked screen shows a live **step
  checklist** (Reading the form → Gemini writing the tool → Writing code →
  Gemini writing & running tests, or just the last step for "Run tests
  only") — done steps get a checkmark, the current one spins, the rest sit
  pending — not just a single rotating label.
- Once done, a pass/fail summary badge appears (e.g. "✓ 9/9 passed" or
  "⚠ 6/8 passed, 1 SKIPPED"), and a **preview icon** opens the full test
  report as a rendered Markdown preview (VS Code's built-in `markdown.showPreviewToSide`)
  — not a file you have to download and open yourself. It's a running
  *history* of every Generate/Run-tests call for that screen (newest run
  first, up to the last 20), each with the URL tested and, per scenario,
  the exact request sent and the expected vs. actual outcome — so you can
  see how testing went as the screen evolved, not just the latest pass.
  The underlying `.webmcp-report.md` file sits next to the tested screen,
  so it's real and shareable/diffable, not just an in-editor view.
- The Output log colorizes `[PASS]`/`[FAIL]`/`SKIPPED`/`ERROR` lines and has
  a one-click Clear button.
- The API key field has a show/hide toggle; a small pill next to "Gemini"
  shows saved/not-set at a glance.

## Requirements

- No project setup needed for codegen/testing — `agent-runner/` (with its
  own `playwright` dependency) ships inside this extension, so it works in
  any workspace out of the box. `webmcpAgent.agentRunnerPath` is only for
  advanced use: point it at a different `codegen-agent.js`/`runner.js`
  folder if you want to override the bundled copy.
- A Gemini API key, saved in the panel, before running "Generate" or "Run
  tests only" — both require it, with no fallback.
- For **Simulate** specifically: nothing you need to set up — the first
  click installs webmcp-agent-ui's dependencies (mainly Electron) into this
  extension's own storage, a one-time step (a couple minutes, or instant if
  npm already has Electron cached from another project). `webmcpAgent.agentUiPath`
  is only for pointing at a specific existing copy instead.

## Try it in the Extension Development Host

Open **this folder** (`webmcp-vscode-extension/`) directly in VS Code, run
`npm install` once (pulls in the bundled `agent-runner/`'s own
`playwright`), then press `F5`. A new VS Code window launches with the
extension active — open any workspace, edit/save an `.html` screen with a
`<form>`, and use the WebMCP Agent icon in the Activity Bar.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `webmcpAgent.watchGlob` | `**/*.html` | Which files count as "screens" to track |
| `webmcpAgent.excludeGlob` | `**/node_modules/**` | Paths to ignore |
| `webmcpAgent.agentRunnerPath` | *(bundled copy)* | Override: folder containing a different `codegen-agent.js`/`runner.js` |
| `webmcpAgent.geminiModel` | `gemini-2.5-flash` | Model used to write the WebMCP tool and its test scenarios |
| `webmcpAgent.agentUiPath` | *(auto-detect/managed)* | Override: a specific `webmcp-agent-ui/` copy for "Simulate" to use instead of the auto-managed one |

## Packaging

```bash
npm install            # once, to populate the bundled agent-runner/'s dependencies
npm install -g @vscode/vsce
vsce package            # bundles node_modules + agent-runner/ into the .vsix
```
