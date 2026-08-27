(function () {
  const vscode = acquireVsCodeApi();

  const keyBanner = document.getElementById("keyBanner");
  const settingsBody = document.getElementById("settingsBody");
  const apiKeyInput = document.getElementById("apiKey");
  const toggleKeyBtn = document.getElementById("toggleKeyVisibility");
  const modelInput = document.getElementById("model");
  const saveKeyBtn = document.getElementById("saveKey");
  const clearKeyBtn = document.getElementById("clearKey");
  const keyStatus = document.getElementById("keyStatus");
  const credentialsInput = document.getElementById("credentials");
  const credentialsStatus = document.getElementById("credentialsStatus");
  const saveCredentialsBtn = document.getElementById("saveCredentials");
  const clearCredentialsBtn = document.getElementById("clearCredentials");
  const fileList = document.getElementById("fileList");
  const generateAllBtn = document.getElementById("generateAll");
  const clearLogBtn = document.getElementById("clearLog");
  const log = document.getElementById("log");

  let hasKey = false;
  let hasCredentials = false;
  let lastFiles = [];
  const expanded = new Set(); // fsPaths whose results panel is open

  toggleKeyBtn.addEventListener("click", () => {
    const showing = apiKeyInput.type === "text";
    apiKeyInput.type = showing ? "password" : "text";
    toggleKeyBtn.innerHTML = `<i class="codicon codicon-${showing ? "eye" : "eye-closed"}"></i>`;
  });

  saveKeyBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "saveApiKey", apiKey: apiKeyInput.value, model: modelInput.value });
    apiKeyInput.value = "";
    apiKeyInput.type = "password";
    toggleKeyBtn.innerHTML = '<i class="codicon codicon-eye"></i>';
  });

  clearKeyBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "clearApiKey" });
  });

  saveCredentialsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "saveCredentials", credentials: credentialsInput.value });
    credentialsInput.value = "";
  });

  clearCredentialsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "clearCredentials" });
    credentialsInput.value = "";
  });

  generateAllBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "generateAll" });
  });

  clearLogBtn.addEventListener("click", () => {
    log.textContent = "";
    log.classList.add("empty");
    log.textContent = "Nothing run yet.";
  });

  function updateKeyUI() {
    keyBanner.classList.toggle("hidden", hasKey);
    keyStatus.innerHTML = hasKey ? '<i class="codicon codicon-check"></i> saved' : "not set";
    keyStatus.className = "pill " + (hasKey ? "pill-ok" : "pill-warn");
    generateAllBtn.disabled = !hasKey || lastFiles.length === 0;
    credentialsStatus.innerHTML = hasCredentials ? '<i class="codicon codicon-check"></i> saved' : "not set";
    credentialsStatus.className = "pill " + (hasCredentials ? "pill-ok" : "pill-neutral");
  }

  const SPINNER = '<i class="codicon codicon-loading codicon-modifier-spin"></i>';

  const GENERATE_STEPS = [
    { key: "discover", label: "Reading the form" },
    { key: "gemini-tool", label: "Gemini writing the WebMCP tool" },
    { key: "write", label: "Writing code" },
    { key: "test", label: "Gemini writing & running tests" },
  ];
  const TEST_ONLY_STEPS = [{ key: "test", label: "Gemini writing & running tests" }];

  function stepsFor(f) {
    return f.action === "testOnly" ? TEST_ONLY_STEPS : GENERATE_STEPS;
  }

  const PHASE_LABELS = Object.fromEntries(GENERATE_STEPS.map((s) => [s.key, s.label + "…"]));

  function statusBadge(f) {
    if (f.status === "generating") {
      return { html: `${SPINNER} ${PHASE_LABELS[f.phase] || "Working…"}`, cls: "pill-busy" };
    }
    const s = f.summary;
    const icon = (name) => `<i class="codicon codicon-${name}"></i>`;
    if (f.status === "error" && !s) return { html: `${icon("error")} error`, cls: "pill-error" };
    if (!s) return { html: f.status === "generated" ? `${icon("check")} done` : "", cls: "pill-ok" };
    if (s.note) return { html: s.note, cls: "pill-neutral" };
    const skipped = s.skipped || 0;
    if (skipped > 0) return { html: `${icon("warning")} ${s.passed}/${s.total} passed, ${skipped} SKIPPED`, cls: "pill-warn" };
    if (s.total === 0) return { html: `${icon("warning")} no scenarios ran`, cls: "pill-warn" };
    if (s.passed === s.total) return { html: `${icon("check")} ${s.passed}/${s.total} passed`, cls: "pill-ok" };
    return { html: `${icon("error")} ${s.passed}/${s.total} passed`, cls: "pill-error" };
  }

  // A visible checklist of every step in the current run, not just a
  // single rotating label — steps before the current phase are done,
  // the current one spins, the rest sit pending. Only shown while a run
  // is actually in progress; once finished the summary pill above (plus
  // the expandable per-scenario results) carries the outcome instead.
  function renderStepList(f) {
    if (f.status !== "generating") return "";
    const steps = stepsFor(f);
    const currentIdx = steps.findIndex((s) => s.key === f.phase);
    const rows = steps
      .map((s, i) => {
        let iconHtml, cls;
        if (currentIdx === -1) {
          iconHtml = i === 0 ? SPINNER : '<i class="codicon codicon-circle-large"></i>';
          cls = i === 0 ? "step-active" : "step-pending";
        } else if (i < currentIdx) {
          iconHtml = '<i class="codicon codicon-check"></i>';
          cls = "step-done";
        } else if (i === currentIdx) {
          iconHtml = SPINNER;
          cls = "step-active";
        } else {
          iconHtml = '<i class="codicon codicon-circle-large"></i>';
          cls = "step-pending";
        }
        return `<div class="step-row ${cls}">${iconHtml}<span>${escapeHtml(s.label)}</span></div>`;
      })
      .join("");
    return `<div class="step-list">${rows}</div>`;
  }

  function renderResultsPanel(f) {
    if (!f.results || f.results.length === 0) return "";
    const toolsHtml = f.results
      .map((tool) => {
        const scenarioRows = tool.scenarios
          .map((sc) => {
            const icon = sc.pass ? "pass" : "error";
            const cls = sc.pass ? "scenario-pass" : "scenario-fail";
            const actualTitle = escapeHtml(`expected: ${sc.expected}\nactual: ${sc.actual}`);
            return `<div class="scenario-row ${cls}" title="${actualTitle}">
              <i class="codicon codicon-${icon}"></i>
              <span class="scenario-name">${escapeHtml(sc.name)}</span>
            </div>`;
          })
          .join("");
        const skippedHtml = tool.skippedReason
          ? `<div class="scenario-row scenario-skip" title="${escapeHtml(tool.skippedReason)}">
              <i class="codicon codicon-circle-slash"></i>
              <span class="scenario-name">SKIPPED — ${escapeHtml(tool.skippedReason)}</span>
            </div>`
          : "";
        return `<div class="tool-result">
          <div class="tool-result-header">
            <i class="codicon codicon-symbol-method"></i>
            <span class="tool-name">${escapeHtml(tool.toolName)}</span>
          </div>
          ${tool.description ? `<div class="tool-description">${escapeHtml(tool.description)}</div>` : ""}
          ${scenarioRows}${skippedHtml}
        </div>`;
      })
      .join("");
    return `<div class="results-panel">${toolsHtml}</div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderFiles(files) {
    lastFiles = files || [];
    updateKeyUI();
    if (lastFiles.length === 0) {
      fileList.className = "muted empty-state";
      fileList.textContent = "No changes tracked yet — save an .html screen with a <form> to get started.";
      return;
    }
    fileList.className = "";
    fileList.innerHTML = "";
    lastFiles.forEach((f) => {
      const row = document.createElement("div");
      row.className = "file-row";

      const info = document.createElement("div");
      info.className = "file-info";
      const badge = statusBadge(f);
      const hasResults = f.results && f.results.length > 0;
      const isOpen = expanded.has(f.fsPath);
      info.innerHTML =
        (hasResults
          ? `<button class="expand-toggle" title="Toggle test results"><i class="codicon codicon-chevron-${isOpen ? "down" : "right"}"></i></button>`
          : `<span class="expand-toggle-spacer"></span>`) +
        `<span class="file-path" title="Open file">${escapeHtml(f.relPath)}</span>` +
        `<span class="pill ${badge.cls}">${badge.html}</span>`;
      info.querySelector(".file-path").addEventListener("click", () => vscode.postMessage({ type: "openFile", fsPath: f.fsPath }));
      const toggleBtn = info.querySelector(".expand-toggle");
      if (toggleBtn) {
        toggleBtn.addEventListener("click", () => {
          if (expanded.has(f.fsPath)) expanded.delete(f.fsPath);
          else expanded.add(f.fsPath);
          renderFiles(lastFiles);
        });
      }

      const actions = document.createElement("div");
      actions.className = "row";
      const busy = f.status === "generating";
      const disabledTitle = !hasKey ? "Save a Gemini API key first" : "";

      const genBtn = document.createElement("button");
      genBtn.innerHTML = '<i class="codicon codicon-sparkle"></i> Generate WebMCP code';
      genBtn.disabled = busy || !hasKey;
      genBtn.title = disabledTitle;
      genBtn.addEventListener("click", () => {
        expanded.add(f.fsPath);
        vscode.postMessage({ type: "generate", fsPath: f.fsPath });
      });

      const testBtn = document.createElement("button");
      testBtn.className = "secondary";
      testBtn.innerHTML = '<i class="codicon codicon-beaker"></i> Run tests only';
      testBtn.disabled = busy || !hasKey;
      testBtn.title = disabledTitle;
      testBtn.addEventListener("click", () => {
        expanded.add(f.fsPath);
        vscode.postMessage({ type: "runTestsOnly", fsPath: f.fsPath });
      });

      const simulateBtn = document.createElement("button");
      simulateBtn.className = "secondary";
      simulateBtn.innerHTML = '<i class="codicon codicon-window"></i> Simulate';
      simulateBtn.disabled = busy || !f.reportPath;
      simulateBtn.title = f.reportPath ? "Open webmcp-agent-ui and replay this run's scenarios visually" : "Run Generate or Run tests first";
      simulateBtn.addEventListener("click", () => vscode.postMessage({ type: "simulate", fsPath: f.fsPath }));

      const viewReportBtn = document.createElement("button");
      viewReportBtn.className = "secondary icon-btn";
      viewReportBtn.innerHTML = '<i class="codicon codicon-preview"></i>';
      viewReportBtn.disabled = busy || !f.reportPath;
      viewReportBtn.title = f.reportPath ? "View test report (full history, opens as a Markdown preview)" : "Run Generate or Run tests first";
      viewReportBtn.addEventListener("click", () => vscode.postMessage({ type: "viewReport", fsPath: f.fsPath }));

      const dismissBtn = document.createElement("button");
      dismissBtn.className = "secondary icon-btn";
      dismissBtn.innerHTML = '<i class="codicon codicon-close"></i>';
      dismissBtn.title = "Dismiss";
      dismissBtn.disabled = busy;
      dismissBtn.addEventListener("click", () => vscode.postMessage({ type: "dismiss", fsPath: f.fsPath }));

      actions.appendChild(genBtn);
      actions.appendChild(testBtn);
      actions.appendChild(simulateBtn);
      actions.appendChild(viewReportBtn);
      actions.appendChild(dismissBtn);

      row.appendChild(info);
      const stepsHtml = renderStepList(f);
      if (stepsHtml) {
        const steps = document.createElement("div");
        steps.innerHTML = stepsHtml;
        row.appendChild(steps);
      }
      row.appendChild(actions);
      if (hasResults && isOpen) {
        const results = document.createElement("div");
        results.innerHTML = renderResultsPanel(f);
        row.appendChild(results);
      }
      fileList.appendChild(row);
    });
  }

  function classifyLine(line) {
    if (/\[PASS\]/.test(line)) return "log-pass";
    if (/\[FAIL\]/.test(line)) return "log-fail";
    if (/SKIPPED|NOTE:/.test(line)) return "log-warn";
    if (/^ERROR|Exception:/.test(line.trim())) return "log-error";
    if (/^(>>|===)/.test(line.trim())) return "log-heading";
    return "";
  }

  function appendLog(chunk) {
    if (log.classList.contains("empty")) {
      log.textContent = "";
      log.classList.remove("empty");
    }
    const lines = chunk.split("\n");
    lines.forEach((line, i) => {
      if (line === "" && i === lines.length - 1) return;
      const cls = classifyLine(line);
      const span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = line + "\n";
      log.appendChild(span);
    });
    log.scrollTop = log.scrollHeight;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "init":
        modelInput.value = msg.model || "";
        hasKey = !!msg.hasKey;
        hasCredentials = !!msg.hasCredentials;
        updateKeyUI();
        // First run (no key yet): open the settings panel automatically
        // so there's something to click besides the title-bar gear icon.
        if (!hasKey) settingsBody.classList.remove("hidden");
        break;
      case "files":
        renderFiles(msg.files);
        break;
      case "log":
        appendLog(msg.line);
        break;
      case "toggleSettings":
        settingsBody.classList.toggle("hidden");
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
