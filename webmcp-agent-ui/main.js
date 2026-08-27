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
