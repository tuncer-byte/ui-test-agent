const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getDefaultApiKey: () => ipcRenderer.invoke("get-default-api-key"),
  generateWithGemini: (tool, apiKey, model) => ipcRenderer.invoke("gemini-generate", { tool, apiKey, model }),
  generateWithRules: (schema) => ipcRenderer.invoke("rules-generate", { schema })
});
