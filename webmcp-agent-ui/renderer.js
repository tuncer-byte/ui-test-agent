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
  toolsList.innerHTML = '<span class="text-slate-400">Henüz keşfedilmedi.</span>';
  scenariosList.innerHTML = "";
  resultsList.innerHTML = '<span class="text-slate-400">Henüz test çalıştırılmadı.</span>';
  resultsSummary.classList.add("hidden");
  setEnabled(discoverBtn, false);
  setEnabled(inferBtn, false);
  setEnabled(geminiGenBtn, false);
  setEnabled(rulesGenBtn, false);
  setEnabled(runBtn, false);
  setStatus("Sayfa yükleniyor…", "#f59e0b");
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
  tabTitle.textContent = e.title || "Yeni Sekme";
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
  setStatus("Sayfa yüklendi, document.modelContext kontrol ediliyor…", "#f59e0b");
  const found = await pollForModelContext();
  if (found === "ready") {
    setStatus("document.modelContext bulundu, tool'lar hazır", "#22c55e");
    setEnabled(discoverBtn, true);
  } else if (found === "empty") {
    setStatus("modelContext var ama tool henüz görünmüyor — yine de Keşfet'i dene", "#f59e0b");
    setEnabled(discoverBtn, true);
  } else {
    setStatus("document.modelContext bulunamadı", "#dc2626");
  }
  // DOM-çıkarım her durumda mümkün — sitenin WebMCP'si olmasa bile
  // document.modelContext nesnesini biz kendimiz polyfill ile kuruyoruz
  // (bkz. webmcp-demo/index.html'deki gibi bir mekanizma yoksa bile
  // registerTool çağrısı için document.modelContext'in var olması gerekir).
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
          if (!tool) throw new Error("Tool bulunamadı: " + (ref.name || ref));
          return await tool.execute(params);
        }
      };
      return true;
    })()
  `);
}

// "document.modelContext" nesnesi genelde sayfa açılır açılmaz var olur,
// ama sayfanın kendi bileşenleri (hydration sonrası vb.) tool'ları biraz
// gecikmeli kayıt edebilir. Bu yüzden sadece nesnenin varlığını değil,
// gerçekten en az 1 tool kayıtlı olup olmadığını bekliyoruz.
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
  // NOT: document.modelContext.getTools() bazı implementasyonlarda ("window": <Window>)
  // gibi klonlanamayan canlı obje referansları içerebiliyor — Electron'un
  // executeJavaScript'i bunu IPC üzerinden taşıyamaz ("object could not be cloned").
  // Bu yüzden sadece ihtiyacımız olan, düz/serileştirilebilir alanları seçip
  // döndürüyoruz. inputSchema bazı sitelerde obje yerine JSON string olarak
  // geldiği için de burada normalize ediyoruz.
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

// DOM'dan otomatik tool çıkarımı — native WebMCP olmayan siteler için "fallback".
// HTML5'in kendi native validasyon attribute'larını (pattern/required/min/max/
// maxlength/type=email) okuyup bir JSON Schema üretir, ve gerçek doğrulama için
// tarayıcının kendi form.checkValidity() motorunu kullanır. Bu, gerçek WebMCP
// kadar güvenilir DEĞİLDİR (hâlâ DOM'a bağımlı) — bu yüzden UI'da ayrı etiketleniyor.
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

      // Bir buton için, en yakın atadan başlayarak içinde en az 1 kullanılabilir
      // alan bulunan İLK (en dar) container'ı bulur. Gerçek <form> etiketi
      // olmayan, div tabanlı SPA formlarını da yakalamak için gerekli.
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
        const description = "DOM analizinden otomatik çıkarılmış " + kindLabel + " (" + label + ")";
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
            // form.checkValidity() yerine her alanı TEK TEK kontrol ediyoruz —
            // çünkü container gerçek bir <form> olmayabilir, ama HTML5
            // checkValidity() her form-ilişkili elemanda (form dışında bile) çalışır.
            const invalidEls = fields.filter(el => typeof el.checkValidity === "function" && !el.checkValidity());
            if (invalidEls.length > 0) {
              const messages = invalidEls.map(el => (el.name || el.id || "alan") + ": " + el.validationMessage);
              return { content: [{ type: "text", text: "HATA (native HTML5 validation): " + messages.join("; ") }], isError: true };
            }
            if (submitBtn) submitBtn.click();
            return { content: [{ type: "text", text: "Geçerli veri (native HTML5 doğrulamasından geçti), buton tıklandı" }] };
          }
        });
        return { name: toolName, description, inputSchema: schema };
      }

      const inferred = [];
      let counter = 0;

      // 1) Klasik <form> taraması
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

      // 2) <form> içinde olmayan, "buton + en yakın container'daki inputlar" taraması
      //    (React/Vue gibi div-tabanlı SPA formları için)
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
      allButtons.forEach((btn) => {
        if (btn.closest("form")) return; // zaten adım 1'de ele alındı
        if (handledButtons.has(btn)) return;
        const found = findContainerFields(btn);
        if (!found) return;
        counter++;
        const toolName = "inferred_container_" + counter;
        handledButtons.add(btn);
        inferred.push(registerCandidate(found.container, found.fields, btn, toolName, "alan grubu"));
      });

      return inferred;
    })()
  `;
  return await webview.executeJavaScript(code);
}

inferBtn.addEventListener("click", async () => {
  toolsList.innerHTML = '<span class="text-slate-400">Formlar taranıyor…</span>';
  let inferred = [];
  try {
    inferred = await inferToolsFromDOM();
  } catch (e) {
    toolsList.innerHTML = `<span class="text-red-600 text-xs">Hata: ${e.message}</span>`;
    return;
  }
  const tagged = (inferred || []).map((t) => ({ ...t, synthetic: true }));
  discoveredTools = [...discoveredTools.filter((t) => !t.synthetic), ...tagged];
  renderToolsList();
  if (tagged.length === 0) {
    toolsList.innerHTML = '<span class="text-slate-400 text-xs">Sayfada uygun bir &lt;form&gt; bulunamadı.</span>';
  } else if (!selectedTool) {
    selectTool(tagged[0]);
  }
});

discoverBtn.addEventListener("click", async () => {
  toolsList.innerHTML = '<span class="text-slate-400">Aranıyor (birkaç kez deneniyor)…</span>';
  const res = await fetchToolsWithRetry();
  if (!res.ok) {
    toolsList.innerHTML = `<span class="text-red-600 text-xs">Hata: ${res.reason}</span>`;
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
    toolsList.innerHTML = '<span class="text-slate-400">Tool bulunamadı.</span>';
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
        ${t.synthetic ? '<span class="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full" style="background:#fef3c7;color:#92400e;">⚠️ Çıkarılmış</span>' : ""}
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
  scenariosList.innerHTML = '<span class="text-slate-400 text-sm">Gemini senaryo üretiyor…</span>';
  const res = await window.api.generateWithGemini(selectedTool, apiKeyInput.value.trim(), modelInput.value.trim());
  if (!res.ok) {
    scenariosList.innerHTML = `<div class="text-xs text-red-600 mb-2">Gemini başarısız oldu (${res.reason}) — kural-tabanlı üreticiye düşülüyor.</div>`;
    const fallback = await window.api.generateWithRules(selectedTool.inputSchema);
    applyScenarios(fallback.scenarios, "kural-tabanlı (yedek)");
    return;
  }
  applyScenarios(res.scenarios, "gemini");
});

rulesGenBtn.addEventListener("click", async () => {
  const res = await window.api.generateWithRules(selectedTool.inputSchema);
  applyScenarios(res.scenarios, "kural-tabanlı");
});

function applyScenarios(scenarios, source) {
  currentScenarios = scenarios;
  renderScenarios(source);
  setEnabled(runBtn, currentScenarios.length > 0);
}

function renderScenarios(source) {
  scenariosList.innerHTML =
    `<div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Kaynak: ${source} · ${currentScenarios.length} senaryo</div>` +
    currentScenarios
      .map(
        (s) => `
      <div class="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 border border-slate-100">
        <span class="text-sm text-slate-700">${s.name}</span>
        <span class="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full" style="background:${
          s.expectSuccess ? "#eff6ff" : "#fef2f2"
        }; color:${s.expectSuccess ? "#1e40af" : "#dc2626"};">
          ${s.expectSuccess ? "Başarılı" : "Reddedilmeli"}
        </span>
      </div>`
      )
      .join("");
}

runBtn.addEventListener("click", async () => {
  resultsSummary.classList.add("hidden");
  resultsList.innerHTML = "";
  const results = [];

  for (const scenario of currentScenarios) {
    // 1) Görünen formu adım adım doldurup submit'e basar (sadece görsel takip için)
    // 2) Ardından document.modelContext.executeTool() ile resmi sonucu alır (pass/fail bu belirler)
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
      outcome = { actualSuccess: false, text: "executeJavaScript hata: " + e.message };
    }
    const pass = outcome.actualSuccess === scenario.expectSuccess;
    results.push({ ...scenario, ...outcome, pass });
    renderResults(results);
    await new Promise((r) => setTimeout(r, 300));
  }

  const passCount = results.filter((r) => r.pass).length;
  resultsSummary.classList.remove("hidden");
  resultsSummary.innerHTML = `<span style="color:${passCount === results.length ? "#15803d" : "#dc2626"}">${passCount}/${results.length} senaryo geçti</span>`;
});

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
