const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { startStaticServer } = require("./static-server");

const SECRET_KEY = "webmcpAgent.geminiApiKey";
const CREDENTIALS_SECRET_KEY = "webmcpAgent.testCredentials";
const MEMORY_STATE_KEY = "webmcpAgent.appMemory";
const VIEW_ID = "webmcpAgent.panel";

/** @type {Map<string, { relPath: string, status: "changed"|"generating"|"generated"|"error", phase?: string, summary?: object, results?: object[] }>} */
const trackedFiles = new Map();

// Pulls live, structured progress out of codegen-agent.js/runner.js's
// plain stdout — no protocol change needed on their end, just
// recognizable text they already print for humans reading the terminal.
// Requires one complete line at a time (see the line-buffering in
// runNodeScript) since markers/tables could otherwise be torn across
// chunk boundaries.
function createRunParser() {
  const results = [];
  let current = null;
  const state = { phase: undefined, summary: undefined };

  function parseLine(line) {
    let changed = false;

    const phaseMatch = line.match(/>> PHASE: (\S+)/);
    if (phaseMatch) {
      state.phase = phaseMatch[1];
      changed = true;
    }

    const totalMatch = line.match(/>> TOTAL: (\d+)\/(\d+) scenarios passed(?:, (\d+) tool\(s\) SKIPPED)?/);
    if (totalMatch) {
      state.summary = { passed: Number(totalMatch[1]), total: Number(totalMatch[2]), skipped: Number(totalMatch[3] || 0) };
      changed = true;
    }
    if (/No <form> elements found on this screen/.test(line)) {
      state.summary = { note: "No <form> found on this screen" };
      changed = true;
    }
    const allWiredMatch = line.match(/All (\d+) form\(s\) already have WebMCP tool code/);
    if (allWiredMatch) {
      state.summary = { note: `Already wired (${allWiredMatch[1]} tool(s))` };
      changed = true;
    }

    const toolMatch = line.match(/^=== TOOL: (.+?) ===\s*$/);
    if (toolMatch) {
      current = { toolName: toolMatch[1], description: "", scenarios: [], skippedReason: null };
      results.push(current);
      return true;
    }

    if (current) {
      const skipMatch = line.match(/^\s*SKIPPED\s*[—-]\s*(.+?)\s*$/);
      if (skipMatch) {
        current.skippedReason = skipMatch[1].trim();
        return true;
      }
      const scenarioMatch = line.match(/^\s*\[(PASS|FAIL)\]\s+(.+?)\s*\|\s*expected=(.+?)\s*\|\s*actual="(.*)"\s*$/);
      if (scenarioMatch) {
        current.scenarios.push({
          pass: scenarioMatch[1] === "PASS",
          name: scenarioMatch[2].trim(),
          expected: scenarioMatch[3].trim(),
          actual: scenarioMatch[4],
        });
        return true;
      }
      if (!current.description && current.scenarios.length === 0 && /^ {4}\S/.test(line) && !/^\s*\(Gemini generated/.test(line)) {
        current.description = line.trim();
        changed = true;
      }
    }

    return changed;
  }

  return { parseLine, state, results };
}

// Deterministic per-file temp path for the runner.js --json-out report,
// so a later run for the same file overwrites rather than accumulating.
function reportPathFor(fsPath) {
  const hash = crypto.createHash("sha1").update(fsPath).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `webmcp-agent-report-${hash}.json`);
}

const MAX_HISTORY_RUNS = 20;

function historyPathFor(fsPath) {
  const hash = crypto.createHash("sha1").update(fsPath).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `webmcp-agent-history-${hash}.json`);
}

// Every completed run (pass, fail, or partial) gets appended here, newest
// first — this is what makes the report a real history ("geçmiş testler")
// instead of just the latest run overwriting the last one.
function appendReportToHistory(fsPath, reportPath) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
  } catch {
    return;
  }
  const historyPath = historyPathFor(fsPath);
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }
  history.unshift(report);
  if (history.length > MAX_HISTORY_RUNS) history = history.slice(0, MAX_HISTORY_RUNS);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
}

function escapeMarkdownCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// Renders one run's report (URL, summary, per-tool scenario tables with
// the exact request sent and the resulting status) as a Markdown section.
function renderReportSection(report) {
  const lines = [];
  lines.push(`- **URL tested:** ${report.url}`);

  const totalScenarios = report.tools.reduce((sum, t) => sum + (t.scenarios ? t.scenarios.length : 0), 0);
  const totalPassed = report.tools.reduce((sum, t) => sum + (t.scenarios ? t.scenarios.filter((s) => s.pass).length : 0), 0);
  const skippedTools = report.tools.filter((t) => t.skippedReason).length;
  lines.push(
    `- **Summary:** ${totalPassed}/${totalScenarios} scenarios passed` + (skippedTools ? `, ${skippedTools} tool(s) SKIPPED` : "")
  );
  lines.push("");

  for (const tool of report.tools) {
    lines.push(`### Tool: \`${tool.name}\``);
    if (tool.description) lines.push(`_${escapeMarkdownCell(tool.description)}_`);
    lines.push("");

    if (tool.skippedReason) {
      lines.push(`> **SKIPPED** — ${escapeMarkdownCell(tool.skippedReason)}`);
      lines.push("");
      continue;
    }
    if (!tool.scenarios || tool.scenarios.length === 0) {
      lines.push("_No scenarios ran for this tool._");
      lines.push("");
      continue;
    }

    lines.push("| Scenario | Expected | Request (input) | Result |");
    lines.push("|---|---|---|---|");
    for (const sc of tool.scenarios) {
      const status = sc.pass ? "✅ PASS" : "❌ FAIL";
      const expected = sc.expectSuccess ? "success" : "should be rejected";
      const requestJson = "`" + escapeMarkdownCell(JSON.stringify(sc.input)) + "`";
      const actual = escapeMarkdownCell(sc.actualText || "");
      lines.push(`| ${escapeMarkdownCell(sc.name)} | ${expected} | ${requestJson} | ${status} — "${actual}" |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Turns the full run HISTORY (every runner.js --json-out report captured
// so far for this screen, newest first) into one Markdown document — a
// persistent record of how testing went across development iterations,
// not just a snapshot of the latest run.
function buildMarkdownHistoryReport(history, relPath) {
  const lines = [`# WebMCP Test Report — ${relPath}`, ""];
  history.forEach((report, i) => {
    lines.push(`## Run ${i === 0 ? "(latest) " : ""}— ${report.generatedAt}`);
    lines.push("");
    lines.push(renderReportSection(report));
    if (i < history.length - 1) lines.push("---", "");
  });
  return lines.join("\n");
}

let statusBarItem;
let viewProvider;
let bundledAgentRunnerDir = null;
let agentRunnerDirCache = null;
let codiconsDir = null;

function activate(context) {
  bundledAgentRunnerDir = path.join(context.extensionPath, "agent-runner");
  codiconsDir = path.join(context.extensionPath, "node_modules", "@vscode", "codicons", "dist");

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "workbench.view.extension.webmcpAgent";
  context.subscriptions.push(statusBarItem);

  viewProvider = new WebmcpViewProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider));

  const config = vscode.workspace.getConfiguration("webmcpAgent");
  const watcher = vscode.workspace.createFileSystemWatcher(config.get("watchGlob") || "**/*.html");
  const onFsEvent = (uri) => markChanged(uri);
  context.subscriptions.push(watcher.onDidChange(onFsEvent));
  context.subscriptions.push(watcher.onDidCreate(onFsEvent));
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand("webmcpAgent.setGeminiApiKey", async () => {
      const value = await vscode.window.showInputBox({
        prompt: "Gemini API key (stored securely in VS Code Secret Storage)",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      if (value.trim() === "") {
        await context.secrets.delete(SECRET_KEY);
        vscode.window.showInformationMessage("WebMCP Agent: Gemini API key cleared.");
      } else {
        await context.secrets.store(SECRET_KEY, value.trim());
        vscode.window.showInformationMessage("WebMCP Agent: Gemini API key saved.");
      }
      viewProvider.postInitState();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("webmcpAgent.refresh", () => {
      viewProvider.postFileList();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("webmcpAgent.toggleSettings", () => {
      viewProvider.post({ type: "toggleSettings" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("webmcpAgent.generateForFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".html")) {
        vscode.window.showWarningMessage("WebMCP Agent: open an .html screen first.");
        return;
      }
      const fsPath = editor.document.fileName;
      markChanged(vscode.Uri.file(fsPath));
      await vscode.commands.executeCommand("workbench.view.extension.webmcpAgent");
      viewProvider.runGenerate(fsPath);
    })
  );

  updateStatusBar();
}

function isExcluded(fsPath) {
  const config = vscode.workspace.getConfiguration("webmcpAgent");
  const exclude = config.get("excludeGlob") || "**/node_modules/**";
  // cheap glob check good enough for the default node_modules case
  const pattern = exclude.replace(/\*\*/g, "").replace(/\*/g, "");
  return pattern && fsPath.includes(pattern.replace(/\//g, path.sep));
}

function markChanged(uri) {
  if (isExcluded(uri.fsPath)) return;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const relPath = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
  const existing = trackedFiles.get(uri.fsPath);
  if (existing && existing.status === "generating") return;
  trackedFiles.set(uri.fsPath, { relPath, status: "changed" });
  updateStatusBar();
  if (viewProvider) viewProvider.postFileList();
}

function updateStatusBar() {
  const changedCount = Array.from(trackedFiles.values()).filter((f) => f.status === "changed").length;
  if (changedCount === 0) {
    statusBarItem.text = "$(check) WebMCP: up to date";
  } else {
    statusBarItem.text = `$(circle-filled) WebMCP: ${changedCount} screen${changedCount === 1 ? "" : "s"} changed`;
  }
  statusBarItem.show();
}

function hasCodegenAgent(dir) {
  return !!dir && fs.existsSync(path.join(dir, "codegen-agent.js"));
}

async function resolveAgentRunnerDir() {
  // 1) explicit user override
  const config = vscode.workspace.getConfiguration("webmcpAgent");
  const configured = config.get("agentRunnerPath");
  if (configured) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const abs = path.isAbsolute(configured) ? configured : path.join(folder ? folder.uri.fsPath : "", configured);
    if (hasCodegenAgent(abs)) return abs;
  }
  // 2) the copy bundled with this extension — works in any workspace,
  //    with no dependency on the target project containing these scripts.
  if (hasCodegenAgent(bundledAgentRunnerDir)) return bundledAgentRunnerDir;
  // 3) last-resort fallback for dev/monorepo setups
  if (hasCodegenAgent(agentRunnerDirCache)) return agentRunnerDirCache;
  const found = await vscode.workspace.findFiles("**/codegen-agent.js", "**/node_modules/**", 5);
  if (found.length > 0) {
    agentRunnerDirCache = path.dirname(found[0].fsPath);
    return agentRunnerDirCache;
  }
  return null;
}

let agentUiDirCache = null;
let agentUiInstallInProgress = false;

const AGENT_UI_SOURCE_FILES = [
  "main.js",
  "preload.js",
  "renderer.js",
  "index.html",
  "gemini-scenarios.js",
  "scenario-utils.js",
  "package.json",
  "package-lock.json",
];

function hasAgentUiSource(dir) {
  return !!dir && fs.existsSync(path.join(dir, "main.js")) && fs.existsSync(path.join(dir, "package.json"));
}

function hasElectronInstalled(dir) {
  return !!dir && fs.existsSync(path.join(dir, "node_modules", "electron"));
}

function copyAgentUiSourceFiles(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of AGENT_UI_SOURCE_FILES) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDir, f));
  }
}

function resolveElectronBinary(agentUiDir) {
  try {
    const electronPath = require(path.join(agentUiDir, "node_modules", "electron"));
    return typeof electronPath === "string" ? electronPath : null;
  } catch {
    return null;
  }
}

// webmcp-agent-ui is a full Electron app — once its dependencies are
// installed, `node_modules/electron` alone is ~100-200MB (it downloads a
// full Chromium+Electron runtime), far too large to ship pre-built inside
// this extension's .vsix the way agent-runner's small deps could be. So
// only the app's own small SOURCE files are bundled (see agent-ui/ next
// to this file); the real dependencies are installed on demand, once,
// into a location that survives across workspaces and extension updates
// (globalStorage) — after that first `npm install`, "Simulate" works in
// ANY workspace with no further setup, same end result as agent-runner's
// bundling, just deferred to first use instead of baked into the package.
//
// If the current workspace already has webmcp-agent-ui/ checked out with
// electron installed (e.g. this monorepo itself), that's reused directly
// instead, to avoid a redundant multi-hundred-MB download.
async function resolveOrPrepareAgentUiDir(context, onLine) {
  const config = vscode.workspace.getConfiguration("webmcpAgent");
  const configured = config.get("agentUiPath");

  let dir;
  if (configured) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    dir = path.isAbsolute(configured) ? configured : path.join(folder ? folder.uri.fsPath : "", configured);
    if (!hasAgentUiSource(dir)) {
      onLine(`ERROR: webmcpAgent.agentUiPath (${dir}) doesn't look like webmcp-agent-ui (no main.js/package.json there).\n`);
      return null;
    }
  } else if (hasAgentUiSource(agentUiDirCache)) {
    dir = agentUiDirCache;
  } else {
    const found = await vscode.workspace.findFiles("**/webmcp-agent-ui/main.js", "**/node_modules/**", 3);
    if (found.length > 0) {
      dir = path.dirname(found[0].fsPath);
    } else {
      dir = path.join(context.globalStorageUri.fsPath, "agent-ui");
      copyAgentUiSourceFiles(path.join(context.extensionPath, "agent-ui"), dir);
    }
    agentUiDirCache = dir;
  }

  if (hasElectronInstalled(dir)) return dir;

  if (agentUiInstallInProgress) {
    onLine("A Simulate setup (npm install) is already running in the background — wait for it to finish, then try again.\n");
    return null;
  }

  onLine(`\nSimulate: setting up webmcp-agent-ui in ${dir}\n`);
  onLine("(one-time — downloads Electron, a few minutes on a typical connection)...\n");
  agentUiInstallInProgress = true;
  const code = await npmInstall(dir, onLine);
  agentUiInstallInProgress = false;

  if (code !== 0 || !hasElectronInstalled(dir)) {
    onLine(`ERROR: \`npm install\` in ${dir} failed (exit ${code}). Try running it manually there.\n`);
    return null;
  }
  onLine("Simulate setup complete.\n");
  return dir;
}

class WebmcpViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
        vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "@vscode", "codicons", "dist"),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.postInitState();
          this.postFileList();
          break;
        case "saveApiKey":
          if (msg.apiKey && msg.apiKey.trim()) {
            await this.context.secrets.store(SECRET_KEY, msg.apiKey.trim());
          }
          if (msg.model && msg.model.trim()) {
            await vscode.workspace
              .getConfiguration("webmcpAgent")
              .update("geminiModel", msg.model.trim(), vscode.ConfigurationTarget.Global);
          }
          this.postInitState();
          this.post({ type: "log", line: "Gemini settings saved.\n" });
          break;
        case "clearApiKey":
          await this.context.secrets.delete(SECRET_KEY);
          this.postInitState();
          this.post({ type: "log", line: "Gemini API key cleared.\n" });
          break;
        case "saveCredentials": {
          const raw = (msg.credentials || "").trim();
          if (!raw) {
            await this.context.secrets.delete(CREDENTIALS_SECRET_KEY);
          } else {
            try {
              JSON.parse(raw); // validate before storing
              await this.context.secrets.store(CREDENTIALS_SECRET_KEY, raw);
            } catch {
              this.post({ type: "log", line: "ERROR: test credentials must be valid JSON, e.g. {\"email\":\"...\",\"password\":\"...\"} — not saved.\n" });
              break;
            }
          }
          this.postInitState();
          this.post({ type: "log", line: "Test credentials saved.\n" });
          break;
        }
        case "clearCredentials":
          await this.context.secrets.delete(CREDENTIALS_SECRET_KEY);
          this.postInitState();
          this.post({ type: "log", line: "Test credentials cleared.\n" });
          break;
        case "saveMemory":
          await this.context.workspaceState.update(MEMORY_STATE_KEY, (msg.memory || "").trim() || undefined);
          this.postInitState();
          this.post({ type: "log", line: "App notes saved.\n" });
          break;
        case "clearMemory":
          await this.context.workspaceState.update(MEMORY_STATE_KEY, undefined);
          this.postInitState();
          this.post({ type: "log", line: "App notes cleared.\n" });
          break;
        case "generate":
          this.runGenerate(msg.fsPath);
          break;
        case "generateAll":
          this.runGenerateAll();
          break;
        case "runTestsOnly":
          this.runTestsOnly(msg.fsPath);
          break;
        case "simulate":
          this.runSimulate(msg.fsPath);
          break;
        case "viewReport":
          this.runViewReport(msg.fsPath);
          break;
        case "dismiss":
          trackedFiles.delete(msg.fsPath);
          updateStatusBar();
          this.postFileList();
          break;
        case "openFile":
          vscode.window.showTextDocument(vscode.Uri.file(msg.fsPath));
          break;
      }
    });
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  postFileList() {
    const files = Array.from(trackedFiles.entries()).map(([fsPath, info]) => ({ fsPath, ...info }));
    this.post({ type: "files", files });
  }

  async postInitState() {
    const hasKey = !!(await this.context.secrets.get(SECRET_KEY));
    const hasCredentials = !!(await this.context.secrets.get(CREDENTIALS_SECRET_KEY));
    const model = vscode.workspace.getConfiguration("webmcpAgent").get("geminiModel");
    // Unlike the key/credentials (secrets, write-only in the UI), app
    // notes aren't sensitive — send the value back so it's editable
    // in place instead of "clear and retype from scratch" every time.
    const memory = this.context.workspaceState.get(MEMORY_STATE_KEY, "");
    this.post({ type: "init", hasKey, hasCredentials, model, memory });
  }

  async runGenerateAll() {
    const files = Array.from(trackedFiles.keys());
    for (const fsPath of files) {
      await this.runGenerate(fsPath);
    }
  }

  async runGenerate(fsPath) {
    const entry = trackedFiles.get(fsPath) || { relPath: fsPath };
    trackedFiles.set(fsPath, { ...entry, status: "generating", action: "generate" });
    this.postFileList();

    const agentRunnerDir = await resolveAgentRunnerDir();
    if (!agentRunnerDir) {
      this.post({
        type: "log",
        line:
          "ERROR: could not find codegen-agent.js. The extension's bundled agent-runner/ is missing " +
          "node_modules — reinstall the extension, or run `npm install` inside its agent-runner/ folder " +
          "if you're running from source. You can also point webmcpAgent.agentRunnerPath at a different copy.\n",
      });
      trackedFiles.set(fsPath, { ...entry, status: "error" });
      this.postFileList();
      return;
    }

    const apiKey = await this.context.secrets.get(SECRET_KEY);
    const model = vscode.workspace.getConfiguration("webmcpAgent").get("geminiModel");
    if (!apiKey) {
      this.post({
        type: "log",
        line: "ERROR: a Gemini API key is required — test scenarios are always Gemini-generated, never mocked. Save one above first.\n",
      });
      trackedFiles.set(fsPath, { ...entry, status: "error" });
      this.postFileList();
      return;
    }

    const credentials = await this.context.secrets.get(CREDENTIALS_SECRET_KEY);
    const memory = this.context.workspaceState.get(MEMORY_STATE_KEY, "");

    this.post({ type: "log", line: `\n=== Generating WebMCP code for ${entry.relPath} ===\n` });
    const parser = createRunParser();
    const reportPath = reportPathFor(fsPath);
    let latest = { ...entry, status: "generating", results: [], action: "generate" };
    const code = await runNodeScript(
      agentRunnerDir,
      ["codegen-agent.js", "--file", fsPath, "--json-out", reportPath],
      apiKey,
      model,
      (line) => {
        this.post({ type: "log", line });
        if (parser.parseLine(line)) {
          latest = { ...latest, phase: parser.state.phase, summary: parser.state.summary, results: [...parser.results] };
          trackedFiles.set(fsPath, latest);
          this.postFileList();
        }
      },
      {
        ...(credentials ? { WEBMCP_TEST_CREDENTIALS: credentials } : {}),
        ...(memory ? { WEBMCP_APP_MEMORY: memory } : {}),
      }
    );

    const reportExists = fs.existsSync(reportPath);
    if (reportExists) appendReportToHistory(fsPath, reportPath);
    latest = { ...latest, status: code === 0 ? "generated" : "error", phase: undefined, reportPath: reportExists ? reportPath : latest.reportPath };
    trackedFiles.set(fsPath, latest);
    updateStatusBar();
    this.postFileList();
  }

  async runTestsOnly(fsPath) {
    const agentRunnerDir = await resolveAgentRunnerDir();
    if (!agentRunnerDir) {
      this.post({
        type: "log",
        line:
          "ERROR: could not find runner.js. The extension's bundled agent-runner/ is missing node_modules " +
          "— reinstall the extension, or run `npm install` inside its agent-runner/ folder if you're " +
          "running from source. You can also point webmcpAgent.agentRunnerPath at a different copy.\n",
      });
      return;
    }
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    const model = vscode.workspace.getConfiguration("webmcpAgent").get("geminiModel");
    if (!apiKey) {
      this.post({
        type: "log",
        line: "ERROR: a Gemini API key is required to run tests — scenarios are always Gemini-generated, never mocked. Save one above first.\n",
      });
      return;
    }

    const credentials = await this.context.secrets.get(CREDENTIALS_SECRET_KEY);
    const entry = trackedFiles.get(fsPath) || { relPath: fsPath };
    const parser = createRunParser();
    let latest = { ...entry, status: "generating", phase: "test", results: [], action: "testOnly" };
    trackedFiles.set(fsPath, latest);
    this.postFileList();

    const url = "file://" + fsPath;
    const reportPath = reportPathFor(fsPath);
    this.post({ type: "log", line: `\n=== Running tests only against ${url} ===\n` });
    const code = await runNodeScript(
      agentRunnerDir,
      ["runner.js", url, "--json-out", reportPath],
      apiKey,
      model,
      (line) => {
        this.post({ type: "log", line });
        if (parser.parseLine(line)) {
          latest = { ...latest, phase: parser.state.phase || "test", summary: parser.state.summary, results: [...parser.results] };
          trackedFiles.set(fsPath, latest);
          this.postFileList();
        }
      },
      credentials ? { WEBMCP_TEST_CREDENTIALS: credentials } : undefined
    );

    const reportExists = fs.existsSync(reportPath);
    if (reportExists) appendReportToHistory(fsPath, reportPath);
    latest = { ...latest, status: code === 0 ? "generated" : "error", phase: undefined, reportPath: reportExists ? reportPath : latest.reportPath };
    trackedFiles.set(fsPath, latest);
    this.postFileList();
  }

  async runSimulate(fsPath) {
    const entry = trackedFiles.get(fsPath);
    if (!entry || !entry.reportPath || !fs.existsSync(entry.reportPath)) {
      this.post({
        type: "log",
        line:
          "ERROR: nothing to simulate yet — run \"Generate WebMCP code\" or \"Run tests only\" first. " +
          "Simulate replays that run's real Gemini-authored scenarios visually; it never creates new ones.\n",
      });
      return;
    }

    this.post({ type: "log", line: `\n=== Simulating ${entry.relPath} in webmcp-agent-ui ===\n` });
    const agentUiDir = await resolveOrPrepareAgentUiDir(this.context, (line) => this.post({ type: "log", line }));
    if (!agentUiDir) return; // resolveOrPrepareAgentUiDir already logged why

    const electronBin = resolveElectronBinary(agentUiDir);
    if (!electronBin) {
      this.post({ type: "log", line: `ERROR: found webmcp-agent-ui at ${agentUiDir}, but its electron dependency isn't installed correctly. Try deleting its node_modules/ and re-running Simulate.\n` });
      return;
    }

    let server;
    try {
      server = await startStaticServer(path.dirname(fsPath));
    } catch (err) {
      this.post({ type: "log", line: `ERROR: could not start local server: ${err.message}\n` });
      return;
    }
    const url = `${server.baseUrl}/${encodeURIComponent(path.basename(fsPath))}`;
    this.post({ type: "log", line: `Serving ${path.dirname(fsPath)} at ${server.baseUrl} — opening ${url}\n` });

    // A binary npm downloaded (rather than one the user double-clicked or
    // installed via a signed installer) is typically still quarantined on
    // macOS — Gatekeeper can then block a background spawn() of it with
    // NO error surfaced to us at all, which is exactly what silently
    // "does nothing" looks like from here. Clearing it is a no-op if the
    // attribute isn't present, so this is safe to run unconditionally.
    if (process.platform === "darwin") {
      const appBundle = path.join(agentUiDir, "node_modules", "electron", "dist", "Electron.app");
      try {
        execFileSync("xattr", ["-cr", appBundle]);
      } catch (err) {
        this.post({ type: "log", line: `(note: could not clear quarantine attributes on ${appBundle}: ${err.message})\n` });
      }
    }

    this.post({ type: "log", line: `Launching webmcp-agent-ui (${electronBin})...\n` });
    // The extension host is itself an Electron process running with
    // ELECTRON_RUN_AS_NODE=1 (that's how it gets a plain Node.js runtime
    // out of an Electron binary) — spawn() inherits process.env by
    // default, so without stripping this, the child Electron we're
    // launching ALSO comes up in "run as node" mode instead of as a real
    // GUI app: require("electron") then returns just a path string, not
    // the real API, so `app` is undefined and `app.whenReady()` throws
    // immediately (exit code 1, no window, easy to mistake for a
    // Gatekeeper/quarantine block instead of this).
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [agentUiDir, `--preload=${entry.reportPath}`, `--url=${url}`], {
      cwd: agentUiDir,
      detached: true,
      env: childEnv,
      // Piped (not "ignore") so a startup crash's real stderr reaches the
      // panel instead of vanishing — that's the whole reason "exited
      // immediately" was a dead end without a cause the first time.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBuffer = "";
    const handleOutputChunk = (chunk) => {
      outputBuffer += chunk.toString();
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop();
      for (const line of lines) this.post({ type: "log", line: line + "\n" });
    };
    child.stdout.on("data", handleOutputChunk);
    child.stderr.on("data", handleOutputChunk);
    child.on("spawn", () => this.post({ type: "log", line: `webmcp-agent-ui launched (pid ${child.pid}).\n` }));
    child.on("error", (err) => this.post({ type: "log", line: `ERROR: failed to launch webmcp-agent-ui: ${err.message}\n` }));
    child.unref();
    child.on("exit", (code, signal) => {
      if (outputBuffer) this.post({ type: "log", line: outputBuffer });
      server.close();
      if (code !== 0 && code !== null) {
        this.post({ type: "log", line: `webmcp-agent-ui exited immediately (code ${code}${signal ? ", signal " + signal : ""}) — see its output above for the actual cause.\n` });
      }
    });
    // Electron apps don't reliably fire a Node-visible "exit" for the GUI
    // window closing (only for the whole process tree), so also cap the
    // server's lifetime as a safety net against an orphaned listener.
    setTimeout(() => server.close(), 30 * 60 * 1000).unref();
  }

  async runViewReport(fsPath) {
    const entry = trackedFiles.get(fsPath);
    if (!entry || !entry.reportPath || !fs.existsSync(entry.reportPath)) {
      this.post({ type: "log", line: "ERROR: nothing to view yet — run \"Generate WebMCP code\" or \"Run tests only\" first.\n" });
      return;
    }

    const historyPath = historyPathFor(fsPath);
    let history;
    try {
      history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
      if (!Array.isArray(history) || history.length === 0) throw new Error("empty history");
    } catch {
      // Fall back to just the latest report if history is missing for
      // some reason (e.g. an older run before history tracking existed).
      try {
        history = [JSON.parse(fs.readFileSync(entry.reportPath, "utf-8"))];
      } catch (err) {
        this.post({ type: "log", line: `ERROR: could not read the run report: ${err.message}\n` });
        return;
      }
    }

    const markdown = buildMarkdownHistoryReport(history, entry.relPath);
    const base = path.basename(fsPath, path.extname(fsPath));
    const mdPath = path.join(path.dirname(fsPath), `${base}.webmcp-report.md`);
    fs.writeFileSync(mdPath, markdown, "utf-8");

    const mdUri = vscode.Uri.file(mdPath);
    await vscode.commands.executeCommand("markdown.showPreviewToSide", mdUri);
    this.post({ type: "log", line: `Test report (${history.length} run${history.length === 1 ? "" : "s"} of history) at ${mdPath}\n` });
  }

  getHtml(webview) {
    const nonce = String(Date.now());
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${codiconUri}" rel="stylesheet" />
<link href="${styleUri}" rel="stylesheet" />
</head>
<body>
  <div id="keyBanner" class="banner banner-warn hidden">
    <i class="codicon codicon-warning banner-icon"></i>
    <span>Gemini API key required — the WebMCP tool <em>and</em> its test scenarios are always written by Gemini, with no mock/heuristic fallback. Click <i class="codicon codicon-gear"></i> above to set one.</span>
  </div>

  <section class="block">
    <div class="row spread">
      <h3><i class="codicon codicon-sparkle"></i> Gemini</h3>
      <span id="keyStatus" class="pill"></span>
    </div>
    <div id="settingsBody" class="hidden">
      <label for="apiKey">API key <span class="hint">(stored in VS Code Secret Storage)</span></label>
      <div class="input-with-action">
        <input id="apiKey" type="password" placeholder="Paste Gemini API key…" />
        <button id="toggleKeyVisibility" class="icon-btn" title="Show/hide key" type="button"><i class="codicon codicon-eye"></i></button>
      </div>
      <label for="model">Model</label>
      <input id="model" type="text" placeholder="gemini-2.5-flash" />
      <div class="row">
        <button id="saveKey"><i class="codicon codicon-save"></i> Save</button>
        <button id="clearKey" class="secondary"><i class="codicon codicon-trash"></i> Clear</button>
      </div>

      <div class="row spread" style="margin-top: 14px;">
        <label for="credentials" style="margin-top: 0;">Test credentials <span class="hint">(optional — to get past a login/consent screen)</span></label>
        <span id="credentialsStatus" class="pill"></span>
      </div>
      <textarea id="credentials" rows="3" placeholder='{"email": "test@example.com", "password": "..."}'></textarea>
      <div class="hint" style="display: block; margin-top: 2px;">
        Used only when the target screen redirects elsewhere (e.g. to a login page that already has its own WebMCP tool) — the agent calls that existing tool with these values instead of fabricating a way past it.
      </div>
      <div class="row">
        <button id="saveCredentials"><i class="codicon codicon-save"></i> Save</button>
        <button id="clearCredentials" class="secondary"><i class="codicon codicon-trash"></i> Clear</button>
      </div>

      <div class="row spread" style="margin-top: 14px;">
        <label for="memory" style="margin-top: 0;">App notes <span class="hint">(optional — context for Gemini about this app)</span></label>
        <span id="memoryStatus" class="pill"></span>
      </div>
      <textarea id="memory" rows="4" placeholder="e.g. This app requires login first — the login screen is a gate, not a feature to test. The 'ref' field on the invoice screen is an internal order number, not a customer-facing ID."></textarea>
      <div class="hint" style="display: block; margin-top: 2px;">
        Read by Gemini while writing a WebMCP tool for a screen — e.g. so it can tell a login/consent
        gate apart from the actual feature under test, even when the gate renders in place instead of
        redirecting to its own URL.
      </div>
      <div class="row">
        <button id="saveMemory"><i class="codicon codicon-save"></i> Save</button>
        <button id="clearMemory" class="secondary"><i class="codicon codicon-trash"></i> Clear</button>
      </div>
    </div>
  </section>

  <section class="block">
    <div class="row spread">
      <h3><i class="codicon codicon-file-code"></i> Changed screens</h3>
      <button id="generateAll" class="secondary small" disabled><i class="codicon codicon-run-all"></i> Generate all</button>
    </div>
    <div id="fileList" class="muted empty-state">No changes tracked yet — save an .html screen with a &lt;form&gt; to get started.</div>
  </section>

  <section class="block">
    <div class="row spread">
      <h3><i class="codicon codicon-output"></i> Raw output</h3>
      <button id="clearLog" class="secondary small"><i class="codicon codicon-clear-all"></i> Clear</button>
    </div>
    <pre id="log" class="empty">Nothing run yet.</pre>
  </section>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Buffers stdout/stderr and calls onLine once per complete line (with its
// trailing \n) instead of once per raw chunk. Chunk boundaries don't
// align with line boundaries, so structured markers like ">> PHASE: x"
// or a "[PASS] ... | actual=..." row could otherwise be torn in half —
// this makes the log parser's per-line regexes reliable.
function spawnLineBuffered(command, args, options, onLine) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let buffer = "";
    const handleChunk = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) onLine(line + "\n");
    };
    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);
    child.on("error", (err) => {
      onLine(`Failed to start process: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => {
      if (buffer) onLine(buffer);
      resolve(code);
    });
  });
}

function runNodeScript(cwd, args, apiKey, model, onLine, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  if (apiKey) env.GEMINI_API_KEY = apiKey;
  if (model) env.GEMINI_MODEL = model;
  return spawnLineBuffered("node", args, { cwd, env }, onLine);
}

function npmInstall(dir, onLine) {
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnLineBuffered(npmBin, ["install"], { cwd: dir }, onLine);
}

function deactivate() {}

module.exports = { activate, deactivate };
