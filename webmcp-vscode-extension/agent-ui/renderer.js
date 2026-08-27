const apiKeyInput = document.getElementById("api-key");
const modelInput = document.getElementById("model");
const targetUrlInput = document.getElementById("target-url");
const loadBtn = document.getElementById("load-btn");
const mcpStatusDot = document.getElementById("mcp-status-dot");
const mcpStatusText = document.getElementById("mcp-status-text");
const discoverBtn = document.getElementById("discover-btn");
const inferBtn = document.getElementById("infer-btn");
const toolsList = document.getElementById("tools-list");
const geminiGenBtn = document.getElementById("gemini-gen-btn");
const rulesGenBtn = document.getElementById("rules-gen-btn");
const scenariosList = document.getElementById("scenarios-list");
const runBtn = document.getElementById("run-btn");
const resultsList = document.getElementById("results-list");
const resultsSummary = document.getElementById("results-summary");
const webview = document.getElementById("target-view");
const backBtn = document.getElementById("back-btn");
const forwardBtn = document.getElementById("forward-btn");
const reloadBtn = document.getElementById("reload-btn");
const addressInput = document.getElementById("address-input");
const lockIcon = document.getElementById("lock-icon");
const tabTitle = document.getElementById("tab-title");
const tabFavicon = document.getElementById("tab-favicon");
const loadingBar = document.getElementById("loading-bar");

let discoveredTools = [];
let selectedTool = null;
let currentScenarios = [];

function setEnabled(btn, enabled) {
  btn.disabled = !enabled;
  btn.classList.toggle("opacity-40", !enabled);
  btn.classList.toggle("cursor-not-allowed", !enabled);
}

function setStatus(text, color) {
  mcpStatusText.textContent = text;
  mcpStatusDot.style.background = color;
}

(async () => {
  const defaultKey = await window.api.getDefaultApiKey();
  if (defaultKey) apiKeyInput.value = defaultKey;
})();

function navigateTo(rawUrl) {
  const url = rawUrl.trim();
  if (!url) return;
  discoveredTools = [];
  selectedTool = null;
  currentScenarios = [];
  toolsList.innerHTML = '<span class="text-slate-400">Not discovered yet.</span>';
  scenariosList.innerHTML = "";
  resultsList.innerHTML = '<span class="text-slate-400">No tests run yet.</span>';
  resultsSummary.classList.add("hidden");
  setEnabled(discoverBtn, false);
  setEnabled(inferBtn, false);
  setEnabled(geminiGenBtn, false);
  setEnabled(rulesGenBtn, false);
  setEnabled(runBtn, false);
  setStatus("Loading page…", "#f59e0b");
  const finalUrl = url.startsWith("http") || url.startsWith("about:") ? url : "http://" + url;
  targetUrlInput.value = finalUrl;
  addressInput.value = finalUrl;
  webview.src = finalUrl;
}

loadBtn.addEventListener("click", () => navigateTo(targetUrlInput.value));

addressInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") navigateTo(addressInput.value);
});

backBtn.addEventListener("click", () => webview.canGoBack() && webview.goBack());
forwardBtn.addEventListener("click", () => webview.canGoForward() && webview.goForward());
reloadBtn.addEventListener("click", () => webview.reload());

webview.addEventListener("did-start-loading", () => {
  loadingBar.classList.remove("hidden");
});
webview.addEventListener("did-stop-loading", () => {
  loadingBar.classList.add("hidden");
  backBtn.disabled = !webview.canGoBack();
  forwardBtn.disabled = !webview.canGoForward();
});
webview.addEventListener("did-navigate", syncAddressBar);
webview.addEventListener("did-navigate-in-page", syncAddressBar);
webview.addEventListener("page-title-updated", (e) => {
  tabTitle.textContent = e.title || "New Tab";
});

function syncAddressBar(e) {
  const url = e.url || webview.getURL();
  addressInput.value = url;
  targetUrlInput.value = url;
  lockIcon.textContent = url.startsWith("https://") ? "🔒" : "⚠️";
  tabFavicon.textContent = "🌐";
  backBtn.disabled = !webview.canGoBack();
  forwardBtn.disabled = !webview.canGoForward();
}

webview.addEventListener("dom-ready", async () => {
  setStatus("Page loaded, checking document.modelContext…", "#f59e0b");
  const found = await pollForModelContext();
  if (found === "ready") {
    setStatus("document.modelContext found, tools ready", "#22c55e");
    setEnabled(discoverBtn, true);
  } else if (found === "empty") {
    setStatus("modelContext exists but no tools visible yet — try Discover anyway", "#f59e0b");
    setEnabled(discoverBtn, true);
  } else {
    setStatus("document.modelContext not found", "#dc2626");
  }
  // DOM inference is always possible, even without native WebMCP —
  // we polyfill document.modelContext ourselves so that registerTool()
  // has somewhere to register into (see webmcp-demo/index.html for a
  // real implementation of the same mechanism).
  await ensureModelContextExists();
  setEnabled(inferBtn, true);
});

async function ensureModelContextExists() {
  await webview.executeJavaScript(`
    (function() {
      if (document.modelContext) return true;
      const registry = new Map();
      document.modelContext = {
        async registerTool(tool) { registry.set(tool.name, tool); return { unregister: () => registry.delete(tool.name) }; },
        async getTools() { return Array.from(registry.values()).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })); },
        async executeTool(ref, params) {
          const tool = registry.get(ref.name || ref);
          if (!tool) throw new Error("Tool not found: " + (ref.name || ref));
          return await tool.execute(params);
        }
      };
      return true;
    })()
  `);
}

// "document.modelContext" usually exists right after the page opens,
// but the page's own components (post-hydration, etc.) may register
// tools with a slight delay. So we wait not just for the object to
// exist, but for at least 1 tool to actually be registered.
async function pollForModelContext(timeoutMs = 8000) {
  const start = Date.now();
  let sawModelContext = false;
  while (Date.now() - start < timeoutMs) {
    const toolCount = await webview.executeJavaScript(`
      (async () => {
        if (!document.modelContext) return -1;
        try {
          const tools = await document.modelContext.getTools();
          return tools.length;
        } catch (e) { return -1; }
      })()
    `);
    if (toolCount > 0) return "ready";
    if (toolCount === 0) sawModelContext = true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return sawModelContext ? "empty" : "missing";
}

async function fetchToolsWithRetry(maxAttempts = 6, delayMs = 500) {
  // NOTE: document.modelContext.getTools() can, in some implementations,
  // include live object references (e.g. "window": <Window>) that cannot be
  // cloned — Electron's executeJavaScript can't carry that over IPC
  // ("object could not be cloned"). So we only pick out the plain,
  // serializable fields we actually need. inputSchema also gets normalized
  // here, since some sites return it as a JSON string instead of an object.
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await webview.executeJavaScript(`
        (async () => {
          const tools = await document.modelContext.getTools();
          return tools.map(t => {
            let schema = t.inputSchema;
            if (typeof schema === "string") {
              try { schema = JSON.parse(schema); } catch (e) { schema = { type: "object", properties: {} }; }
            }
            if (!schema || typeof schema !== "object") schema = { type: "object", properties: {} };
            return {
              name: t.name,
              description: t.description || "",
              inputSchema: schema
            };
          });
        })()
      `);
      if (result && result.length > 0) return { ok: true, tools: result };
      if (attempt === maxAttempts - 1) return { ok: true, tools: result || [] };
    } catch (e) {
      if (attempt === maxAttempts - 1) return { ok: false, reason: e.message };
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: true, tools: [] };
}

// Automatic tool inference from the DOM — a "fallback" for sites without
// native WebMCP. Reads HTML5's own native validation attributes
// (pattern/required/min/max/maxlength/type=email) to build a JSON Schema,
// and uses the browser's own form.checkValidity() engine for real
// validation. This is NOT as reliable as real WebMCP (it's still DOM-
// dependent) — hence it's labeled separately in the UI.
async function inferToolsFromDOM() {
  const code = `
    (async () => {
      function findLabelFor(el) {
        if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
        const aria = el.getAttribute("aria-label");
        if (aria) return aria;
        const closest = el.closest("label");
        if (closest) return closest.textContent.trim();
        return null;
      }

      function isUsableField(el) {
        return el.tagName === "SELECT" || el.tagName === "TEXTAREA" ||
          (el.tagName === "INPUT" && !["submit", "button", "hidden", "reset", "image"].includes(el.type) && !el.disabled);
      }

      // For a button, walks up from the nearest ancestor to find the FIRST
      // (narrowest) container that holds at least 1 usable field. Needed to
      // also catch div-based SPA "forms" that have no real <form> tag.
      function findContainerFields(btn) {
        let node = btn.parentElement;
        let depth = 0;
        while (node && depth < 10) {
          const fields = Array.from(node.querySelectorAll("input, select, textarea")).filter(isUsableField);
          if (fields.length > 0) return { container: node, fields };
          node = node.parentElement;
          depth++;
        }
        return null;
      }

      function buildSchemaFromFields(fields) {
        const properties = {};
        const required = [];
        fields.forEach((el, idx) => {
          const key = el.name || el.id || ("field_" + idx);
          const prop = {};
          if (el.tagName === "SELECT") {
            prop.type = "string";
            prop.enum = Array.from(el.options).map(o => o.value).filter(v => v !== "");
          } else if (el.type === "checkbox") {
            prop.type = "boolean";
          } else if (el.type === "number" || el.type === "range") {
            prop.type = "number";
            if (el.min !== "") prop.minimum = Number(el.min);
            if (el.max !== "") prop.maximum = Number(el.max);
          } else {
            prop.type = "string";
            if (el.pattern) prop.pattern = el.pattern;
            if (el.minLength && el.minLength > 0) prop.minLength = el.minLength;
            if (el.maxLength && el.maxLength > 0 && el.maxLength < 999999) prop.maxLength = el.maxLength;
            if (el.type === "email" && !prop.pattern) prop.pattern = "^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$";
          }
          prop.description = findLabelFor(el) || el.placeholder || key;
          properties[key] = prop;
          if (el.required) required.push(key);
          el.setAttribute("data-field", key);
        });
        return { type: "object", properties, required };
      }

      function registerCandidate(container, fields, submitBtn, toolName, kindLabel) {
        container.setAttribute("data-tool", toolName);
        const schema = buildSchemaFromFields(fields);
        const label = submitBtn ? (submitBtn.textContent || submitBtn.value || "").trim().slice(0, 40) : "form";
        const description = "Automatically inferred from DOM analysis: " + kindLabel + " (" + label + ")";
        document.modelContext.registerTool({
          name: toolName,
          description,
          inputSchema: schema,
          async execute(params) {
            for (const [key, value] of Object.entries(params || {})) {
              const el = container.querySelector('[data-field="' + key + '"]');
              if (!el) continue;
              if (el.type === "checkbox") el.checked = Boolean(value);
              else el.value = (value === undefined || value === null) ? "" : String(value);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
            // We check each field INDIVIDUALLY instead of form.checkValidity() —
            // because the container might not be a real <form>, but HTML5's
            // checkValidity() works on any form-associated element (even
            // outside a form).
            const invalidEls = fields.filter(el => typeof el.checkValidity === "function" && !el.checkValidity());
            if (invalidEls.length > 0) {
              const messages = invalidEls.map(el => (el.name || el.id || "field") + ": " + el.validationMessage);
              return { content: [{ type: "text", text: "ERROR (native HTML5 validation): " + messages.join("; ") }], isError: true };
            }
            if (submitBtn) submitBtn.click();
            return { content: [{ type: "text", text: "Valid data (passed native HTML5 validation), button clicked" }] };
          }
        });
        return { name: toolName, description, inputSchema: schema };
      }

      const inferred = [];
      let counter = 0;

      // 1) Classic <form> scan
      const forms = Array.from(document.querySelectorAll("form"));
      const handledButtons = new Set();
      forms.forEach((form) => {
        const fields = Array.from(form.querySelectorAll("input, select, textarea")).filter(isUsableField);
        if (fields.length === 0) return;
        counter++;
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]') || form.querySelector("button");
        if (submitBtn) handledButtons.add(submitBtn);
        const toolName = "inferred_form_" + (form.id || form.getAttribute("name") || counter);
        inferred.push(registerCandidate(form, fields, submitBtn, toolName, "form"));
      });

      // 2) Scan for "button + inputs in the nearest container" outside any
      //    <form> (for div-based SPA forms, e.g. React/Vue)
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
      allButtons.forEach((btn) => {
        if (btn.closest("form")) return; // already handled in step 1
        if (handledButtons.has(btn)) return;
        const found = findContainerFields(btn);
        if (!found) return;
        counter++;
        const toolName = "inferred_container_" + counter;
        handledButtons.add(btn);
        inferred.push(registerCandidate(found.container, found.fields, btn, toolName, "field group"));
      });

      return inferred;
    })()
  `;
  return await webview.executeJavaScript(code);
}

inferBtn.addEventListener("click", async () => {
  toolsList.innerHTML = '<span class="text-slate-400">Scanning forms…</span>';
  let inferred = [];
  try {
    inferred = await inferToolsFromDOM();
  } catch (e) {
    toolsList.innerHTML = `<span class="text-red-600 text-xs">Error: ${e.message}</span>`;
    return;
  }
  const tagged = (inferred || []).map((t) => ({ ...t, synthetic: true }));
  discoveredTools = [...discoveredTools.filter((t) => !t.synthetic), ...tagged];
  renderToolsList();
  if (tagged.length === 0) {
    toolsList.innerHTML = '<span class="text-slate-400 text-xs">No suitable &lt;form&gt; found on the page.</span>';
  } else if (!selectedTool) {
    selectTool(tagged[0]);
  }
});

discoverBtn.addEventListener("click", async () => {
  toolsList.innerHTML = '<span class="text-slate-400">Searching (retrying a few times)…</span>';
  const res = await fetchToolsWithRetry();
  if (!res.ok) {
    toolsList.innerHTML = `<span class="text-red-600 text-xs">Error: ${res.reason}</span>`;
    return;
  }
  discoveredTools = res.tools;
  renderToolsList();
  if (discoveredTools.length > 0) {
    selectTool(discoveredTools[0]);
  }
});

function renderToolsList() {
  if (discoveredTools.length === 0) {
    toolsList.innerHTML = '<span class="text-slate-400">No tools found.</span>';
    return;
  }
  toolsList.innerHTML = discoveredTools
    .map(
      (t, i) => `
    <button data-idx="${i}" class="tool-item w-full text-left px-3 py-2 rounded-lg border text-sm ${
        selectedTool && selectedTool.name === t.name
          ? "border-blue-300"
          : "border-slate-100 hover:bg-slate-50"
      }" style="${selectedTool && selectedTool.name === t.name ? "background:#eff6ff;" : ""}">
      <div class="flex items-center gap-1.5">
        <span class="font-medium text-slate-700">${t.name}</span>
        ${t.synthetic ? '<span class="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full" style="background:#fef3c7;color:#92400e;">⚠️ Inferred</span>' : ""}
      </div>
      <div class="text-xs text-slate-400">${t.description || ""}</div>
    </button>`
    )
    .join("");
  document.querySelectorAll(".tool-item").forEach((el) => {
    el.addEventListener("click", () => {
      selectTool(discoveredTools[Number(el.dataset.idx)]);
    });
  });
}

function selectTool(tool) {
  selectedTool = tool;
  renderToolsList();
  setEnabled(geminiGenBtn, true);
  setEnabled(rulesGenBtn, true);
  currentScenarios = [];
  scenariosList.innerHTML = "";
  setEnabled(runBtn, false);
}

geminiGenBtn.addEventListener("click", async () => {
  scenariosList.innerHTML = '<span class="text-slate-400 text-sm">Gemini is generating scenarios…</span>';
  const res = await window.api.generateWithGemini(selectedTool, apiKeyInput.value.trim(), modelInput.value.trim());
  if (!res.ok) {
    scenariosList.innerHTML = `<div class="text-xs text-red-600 mb-2">Gemini failed (${res.reason}) — falling back to the rule-based generator.</div>`;
    const fallback = await window.api.generateWithRules(selectedTool.inputSchema);
    applyScenarios(fallback.scenarios, "rule-based (fallback)");
    return;
  }
  applyScenarios(res.scenarios, "gemini");
});

rulesGenBtn.addEventListener("click", async () => {
  const res = await window.api.generateWithRules(selectedTool.inputSchema);
  applyScenarios(res.scenarios, "rule-based");
});

function applyScenarios(scenarios, source) {
  currentScenarios = scenarios;
  renderScenarios(source);
  setEnabled(runBtn, currentScenarios.length > 0);
}

function renderScenarios(source) {
  scenariosList.innerHTML =
    `<div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Source: ${source} · ${currentScenarios.length} scenarios</div>` +
    currentScenarios
      .map(
        (s) => `
      <div class="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 border border-slate-100">
        <span class="text-sm text-slate-700">${s.name}</span>
        <span class="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full" style="background:${
          s.expectSuccess ? "#eff6ff" : "#fef2f2"
        }; color:${s.expectSuccess ? "#1e40af" : "#dc2626"};">
          ${s.expectSuccess ? "Should pass" : "Should be rejected"}
        </span>
      </div>`
      )
      .join("");
}

runBtn.addEventListener("click", runCurrentScenarios);

// Extracted so the "Simulate" flow (triggered by the VS Code extension,
// replaying a runner.js --json-out report) can drive the exact same
// visual fill-in + executeTool() loop as a manual click of "Run Tests
// via WebMCP", just looped across every tool in the report instead of
// only the one currently selected in the UI.
async function runCurrentScenarios() {
  resultsSummary.classList.add("hidden");
  resultsList.innerHTML = "";
  const results = [];

  for (const scenario of currentScenarios) {
    // 1) Fills the visible form step by step and clicks submit (for visual tracking only)
    // 2) Then gets the authoritative result via document.modelContext.executeTool() (this decides pass/fail)
    const code = `
      (async () => {
        function ensureCursor() {
          let c = document.getElementById("__webmcp_agent_cursor__");
          if (!c) {
            c = document.createElement("div");
            c.id = "__webmcp_agent_cursor__";
            c.style.cssText = "position:fixed;width:22px;height:22px;border-radius:50%;" +
              "background:rgba(30,135,240,0.55);border:2px solid #1e87f0;" +
              "box-shadow:0 2px 10px rgba(30,135,240,0.5);pointer-events:none;" +
              "z-index:2147483647;transition:left .3s ease,top .3s ease,transform .15s ease;" +
              "left:-100px;top:-100px;opacity:0;";
            document.body.appendChild(c);
          }
          return c;
        }
        function moveCursorTo(el) {
          const c = ensureCursor();
          const r = el.getBoundingClientRect();
          c.style.opacity = "1";
          c.style.left = (r.left + r.width / 2 - 11) + "px";
          c.style.top = (r.top + r.height / 2 - 11) + "px";
        }
        function pulseCursor() {
          const c = ensureCursor();
          c.style.transform = "scale(1.7)";
          setTimeout(() => { c.style.transform = "scale(1)"; }, 160);
        }
        function hideCursor() {
          const c = document.getElementById("__webmcp_agent_cursor__");
          if (c) c.style.opacity = "0";
        }

        const form = document.querySelector('[data-tool="${selectedTool.name}"]');
        const inputData = ${JSON.stringify(scenario.input)};
        if (form) {
          // The real pass/fail comes from executeTool() below, not from
          // actually submitting the form — clicking the submit button is
          // only for the visual cursor demo. If the page has no submit
          // handler of its own (or one that doesn't call
          // preventDefault()), the native submission would navigate the
          // whole window away mid-scenario, aborting whatever
          // executeJavaScript() call is in flight and silently cutting
          // the rest of the scenario loop short. Block that unconditionally,
          // regardless of what the target page's own code does.
          form.addEventListener("submit", (e) => e.preventDefault(), { capture: true });
          form.reset();
          form.scrollIntoView({ behavior: "smooth", block: "center" });
          await new Promise(r => setTimeout(r, 350));
          for (const [key, value] of Object.entries(inputData)) {
            const el = form.querySelector('[data-field="' + key + '"]');
            if (!el) continue;
            moveCursorTo(el);
            await new Promise(r => setTimeout(r, 300));
            pulseCursor();
            el.style.outline = "2px solid #1e87f0";
            if (el.type === "checkbox") {
              el.checked = Boolean(value);
            } else {
              el.focus();
              el.value = (value === undefined || value === null) ? "" : String(value);
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            await new Promise(r => setTimeout(r, 220));
            el.style.outline = "";
          }
          const submitBtn = form.querySelector('button[type="submit"]');
          if (submitBtn) {
            moveCursorTo(submitBtn);
            await new Promise(r => setTimeout(r, 300));
            pulseCursor();
            await new Promise(r => setTimeout(r, 150));
            submitBtn.click();
          }
          await new Promise(r => setTimeout(r, 500));
          hideCursor();
        }
        try {
          const res = await document.modelContext.executeTool({ name: ${JSON.stringify(selectedTool.name)} }, inputData);
          return { actualSuccess: !res.isError, text: (res.content && res.content[0] && res.content[0].text) || "" };
        } catch (e) {
          return { actualSuccess: false, text: "Exception: " + e.message };
        }
      })()
    `;
    let outcome;
    try {
      outcome = await webview.executeJavaScript(code);
    } catch (e) {
      outcome = { actualSuccess: false, text: "executeJavaScript error: " + e.message };
    }
    const pass = outcome.actualSuccess === scenario.expectSuccess;
    results.push({ ...scenario, ...outcome, pass });
    renderResults(results);
    await new Promise((r) => setTimeout(r, 300));
  }

  const passCount = results.filter((r) => r.pass).length;
  resultsSummary.classList.remove("hidden");
  resultsSummary.innerHTML = `<span style="color:${passCount === results.length ? "#15803d" : "#dc2626"}">${passCount}/${results.length} scenarios passed</span>`;
  return results;
}

function renderResults(results) {
  resultsList.innerHTML = results
    .map(
      (r) => `
    <div class="px-3 py-2 rounded-lg border border-slate-100">
      <div class="flex items-center justify-between">
        <span class="text-sm text-slate-700">${r.name}</span>
        <span class="text-xs font-semibold px-2 py-0.5 rounded-full border" style="${
          r.pass
            ? "background:#f0fdf4;color:#15803d;border-color:#bbf7d0;"
            : "background:#fef2f2;color:#dc2626;border-color:#fee2e2;"
        }">${r.pass ? "PASS" : "FAIL"}</span>
      </div>
      <div class="text-xs text-slate-400 mt-0.5">${r.text}</div>
    </div>`
    )
    .join("");
}

// Waits for the page's own dom-ready flow (which enables discoverBtn once
// document.modelContext looks ready) to settle, rather than racing it —
// navigateTo() resets all UI state, and discovering before that flow
// finishes would read stale/half-initialized tools.
function waitForPageReady(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (!discoverBtn.disabled || Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve();
      }
    }, 200);
  });
}

// Replays a runner.js --json-out report visually: loads the same URL,
// discovers the page's real (native) WebMCP tools, then for each tool in
// the report that the page actually still exposes, feeds it that run's
// real Gemini-authored scenarios and drives the same cursor-fill +
// executeTool() loop as a manual "Run Tests via WebMCP" click. No new
// Gemini call happens here — this is a replay of a run that already
// happened, not a new one.
async function runSimulationFromReport(report) {
  toolsList.innerHTML = '<span class="text-slate-400">Simulate: discovering tools…</span>';
  const res = await fetchToolsWithRetry();
  if (!res.ok || res.tools.length === 0) {
    toolsList.innerHTML = `<span class="text-red-600 text-xs">Simulate: could not discover any WebMCP tools on the page${res.ok ? "" : " (" + res.reason + ")"}.</span>`;
    return;
  }
  discoveredTools = res.tools;
  renderToolsList();

  const runnable = report.tools.filter((t) => t.scenarios && t.scenarios.length > 0);
  if (runnable.length === 0) {
    toolsList.innerHTML = '<span class="text-slate-400 text-xs">Simulate: the replayed report has no scenarios to run (every tool was SKIPPED).</span>';
    return;
  }

  for (const toolReport of runnable) {
    const tool = discoveredTools.find((t) => t.name === toolReport.name);
    if (!tool) continue; // page no longer exposes this tool — skip rather than fabricate one
    selectTool(tool);
    applyScenarios(
      toolReport.scenarios.map((s) => ({ name: s.name, input: s.input, expectSuccess: s.expectSuccess })),
      "replayed from extension run"
    );
    await runCurrentScenarios();
    await new Promise((r) => setTimeout(r, 700));
  }
}

if (window.api && window.api.onSimulatePreload) {
  window.api.onSimulatePreload(async ({ url, report }) => {
    if (apiKeyInput.value.trim() === "") {
      const defaultKey = await window.api.getDefaultApiKey();
      if (defaultKey) apiKeyInput.value = defaultKey;
    }
    navigateTo(url);
    await waitForPageReady();
    if (report) await runSimulationFromReport(report);
  });
}
