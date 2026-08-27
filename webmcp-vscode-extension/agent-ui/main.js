// NOTE: this is a bundled copy so "Simulate" can offer webmcp-agent-ui
// without requiring it to already be checked out in the workspace.
// Source of truth is webmcp-agent-ui/ at the repo root — keep both in
// sync. Unlike agent-runner, this copy ships without node_modules
// (Electron alone is ~100-200MB) — the extension installs it into a
// managed location on first "Simulate" use (see extension.js).
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { generateScenariosWithGemini } = require("./gemini-scenarios");
const { generateScenariosFromSchema } = require("./scenario-utils");

function readDefaultApiKey() {
  // For convenience, if a key was already written to agent-runner/.env, read and suggest it.
  try {
    const envPath = path.join(__dirname, "..", "webmcp-demo", "agent-runner", ".env");
    const content = fs.readFileSync(envPath, "utf-8");
    const match = content.match(/^GEMINI_API_KEY=(.*)$/m);
    return match ? match[1].trim() : "";
  } catch (err) {
    return "";
  }
}

// The VS Code extension's "Simulate" button launches this app with
// --preload=<path to a runner.js --json-out report> and --url=<page to
// load>, so the visual run replays the exact Gemini-authored tool +
// scenarios that run already produced, instead of asking Gemini again.
function parseLaunchArgs() {
  const args = { preload: null, url: null };
  for (const arg of process.argv) {
    if (arg.startsWith("--preload=")) args.preload = arg.slice("--preload=".length);
    else if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length);
  }
  return args;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile("index.html");

  const launchArgs = parseLaunchArgs();
  if (launchArgs.preload || launchArgs.url) {
    win.webContents.once("did-finish-load", () => {
      let report = null;
      if (launchArgs.preload) {
        try {
          report = JSON.parse(fs.readFileSync(launchArgs.preload, "utf-8"));
        } catch (err) {
          console.error("Failed to read --preload report:", err.message);
        }
      }
      const url = launchArgs.url || (report && report.url) || null;
      if (url) win.webContents.send("webmcp:simulate-preload", { url, report });
    });
  }
}

app.whenReady().then(() => {
  ipcMain.handle("get-default-api-key", () => readDefaultApiKey());

  ipcMain.handle("gemini-generate", async (event, { tool, apiKey, model }) => {
    return await generateScenariosWithGemini(tool, apiKey, model);
  });

  ipcMain.handle("rules-generate", async (event, { schema }) => {
    return { ok: true, scenarios: generateScenariosFromSchema(schema) };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
