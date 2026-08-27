// WebMCP Codegen Agent
// ---------------------------------------------------------------
// Finds the screen(s) a developer just built (via `git`), extracts the
// real DOM/validation facts for each <form> on that screen (field
// types, labels, placeholders, and any real HTML5 validation
// attributes), and asks Gemini to write the actual WebMCP tool
// (name + JSON Schema + success message) from those facts. Writes the
// missing `document.modelContext.registerTool(...)` entries straight
// into the page's own <script> block (the same TOOLS array convention
// used by webmcp-demo/index.html), and then — since the project is
// already runnable locally — immediately runs the existing headless
// test runner (runner.js), which asks Gemini for that tool's test
// scenarios and executes them, and reports pass/fail.
//
// Gemini is REQUIRED end to end here — there is no heuristic/mock
// fallback for either the WebMCP tool itself or its test scenarios.
// Real HTML5 validation attributes (pattern/required/min/max/etc.),
// when present, are passed to Gemini as ground truth it must not
// contradict; only where a field has no explicit attribute does Gemini
// use its judgement (field name/label/placeholder/type) to propose a
// constraint.
//
// Usage:
//   GEMINI_API_KEY=... node codegen-agent.js [--file <path-to-html>] [--base <git-ref>] [--url <url>] [--dry-run]
//
// With no flags: auto-detects changed/new .html files under webmcp-demo/
// via git (unstaged + staged + untracked, or `--base <ref>` diff),
// generates WebMCP code for any form not yet wired up, then runs
// runner.js against a file:// URL of the target page.

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { chromium } = require("playwright");
const { ensureReachable, parseTestCredentials, matchCredentialTool } = require("./preflight");

// Not assumed to be "two levels up from this script" — this script gets
// bundled and invoked from different locations (the monorepo CLI, and a
// copy shipped inside the VS Code extension, run against whatever
// workspace/repo the user has open). Resolved at runtime instead, from
// wherever the actual target file/cwd lives.
let REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEMO_DIR = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { file: null, base: null, url: null, dryRun: false, jsonOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json-out") args.jsonOut = argv[++i];
  }
  return args;
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd: cwd || REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    return "";
  }
}

function findRepoRoot(startDir) {
  const top = git(["rev-parse", "--show-toplevel"], startDir);
  return top || startDir;
}

// Finds .html files the developer actually touched: unstaged, staged,
// untracked, or (if --base is given) changed since that ref.
function findChangedHtmlFiles(base) {
  const sets = [];
  if (base) {
    sets.push(git(["diff", "--name-only", `${base}...HEAD`]));
  } else {
    sets.push(git(["diff", "--name-only", "HEAD"]));
    sets.push(git(["diff", "--name-only", "--cached"]));
    sets.push(git(["ls-files", "--others", "--exclude-standard"]));
  }
  const files = new Set();
  for (const block of sets) {
    if (!block) continue;
    for (const line of block.split("\n")) {
      const rel = line.trim();
      if (!rel || !rel.endsWith(".html")) continue;
      if (rel.includes("node_modules/")) continue;
      const abs = path.join(REPO_ROOT, rel);
      if (fs.existsSync(abs)) files.add(abs);
    }
  }
  return Array.from(files);
}

// Browser-side, purely factual DOM extraction — no naming, no schema
// building, no camelCasing. Just what's really on the page, so Gemini
// has real ground truth (types, labels, HTML5 validation attributes)
// instead of us pre-digesting it into a possibly-lossy heuristic schema.
function extractFormFieldsInPage() {
  function isUsableField(el) {
    return (
      el.tagName === "SELECT" ||
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && !["submit", "button", "hidden", "reset", "image"].includes(el.type) && !el.disabled)
    );
  }

  function labelTextFor(el) {
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    // project convention: a sibling .lbl element right before the field
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.classList && sib.classList.contains("lbl")) return sib.textContent.trim();
      sib = sib.previousElementSibling;
    }
    const wrapper = el.closest("div");
    if (wrapper) {
      const lbl = wrapper.querySelector(".lbl, label");
      if (lbl) return lbl.textContent.trim();
    }
    return null;
  }

  const forms = Array.from(document.querySelectorAll("form"));
  return forms.map((form, formIdx) => {
    const fields = Array.from(form.querySelectorAll("input, select, textarea")).filter(isUsableField);
    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]') || form.querySelector("button");
    const section = form.closest("section");
    const heading = section ? section.querySelector("h1, h2, h3") : null;

    return {
      formIndex: formIdx,
      hasDataTool: !!form.dataset.tool,
      existingToolName: form.dataset.tool || null,
      submitButtonText: submitBtn ? (submitBtn.textContent || submitBtn.value || "").trim() : null,
      headingText: heading ? heading.textContent.replace(/^\s*\d+\s*[·.\-)]?\s*/, "").trim() : null,
      pageTitle: document.title || null,
      fields: fields.map((el, idx) => {
        const key = el.dataset.field || el.name || el.id || `field_${idx}`;
        return {
          key,
          tag: el.tagName.toLowerCase(),
          inputType: el.type || null,
          dataType: el.dataset.type || null, // project convention override, e.g. data-type="integer"/"boolean"
          label: labelTextFor(el),
          placeholder: el.placeholder || null,
          required: el.required === true,
          pattern: el.pattern || null,
          minLength: el.minLength > 0 ? el.minLength : null,
          maxLength: el.maxLength > 0 && el.maxLength < 999999 ? el.maxLength : null,
          min: el.min !== "" && el.min !== undefined ? el.min : null,
          max: el.max !== "" && el.max !== undefined ? el.max : null,
          options: el.tagName === "SELECT" ? Array.from(el.options).map((o) => o.value).filter((v) => v !== "") : null,
          isCheckbox: el.type === "checkbox",
        };
      }),
    };
  });
}

// LLMs writing regex patterns inside JSON often forget to double a
// backslash (e.g. emit a literal "\s" instead of "\\s"), which is not a
// valid JSON escape and breaks JSON.parse outright. The prompt asks
// Gemini not to do this, but instruction-following isn't reliable, so
// repair it: any backslash not already part of a real JSON escape
// (\" \\ \/ \b \f \n \r \t \uXXXX) gets doubled, then we retry parsing.
const VALID_JSON_ESCAPE_CHARS = '"\\/bfnrtu';

// A regex lookahead can't tell an already-valid "\\" pair from a lone bad
// backslash without tracking what's already been consumed, so this walks
// the string left to right: a backslash followed by a real JSON escape
// char is kept as-is (and both chars are consumed together); anything
// else gets doubled into a valid escape.
function repairJsonBackslashes(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (next !== undefined && VALID_JSON_ESCAPE_CHARS.includes(next)) {
        out += ch + next;
        i++;
      } else {
        out += "\\\\";
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function tryParseJsonLoose(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    try {
      return { ok: true, value: JSON.parse(repairJsonBackslashes(text)) };
    } catch (err2) {
      return { ok: false, error: err.message };
    }
  }
}

// Defense in depth: the prompt tells Gemini which JSON Schema keywords
// the runtime validator actually understands, but LLM instruction-
// following isn't 100% reliable — so strip anything else here too,
// rather than silently shipping a constraint that looks present but is
// never actually checked. Where we can, a dropped keyword is converted
// to an equivalent "pattern" instead of just being discarded.
const ALLOWED_SCHEMA_KEYWORDS = new Set(["type", "pattern", "enum", "minimum", "maxLength", "minLength", "description"]);
const KNOWN_FORMAT_PATTERNS = {
  email: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
};

function sanitizeSchemaProperties(properties) {
  const clean = {};
  for (const [key, rule] of Object.entries(properties || {})) {
    const prop = { ...rule };
    if (!prop.pattern && prop.format && KNOWN_FORMAT_PATTERNS[prop.format]) {
      prop.pattern = KNOWN_FORMAT_PATTERNS[prop.format];
    }
    for (const k of Object.keys(prop)) {
      if (!ALLOWED_SCHEMA_KEYWORDS.has(k)) delete prop[k];
    }
    clean[key] = prop;
  }
  return clean;
}

// Asks Gemini to write the actual WebMCP tool (name, description, JSON
// Schema, success message) from the real field facts above. This is the
// ONLY place a WebMCP tool gets authored in this pipeline — there is no
// heuristic schema-builder to fall back to.
//
// Gemini can also answer "this isn't the real screen to test" (isGate)
// instead of a tool — e.g. the developer's memory notes say this app
// requires login first, and the current DOM looks like exactly that
// login form rather than the actual feature. That happens in apps where
// an auth gate renders in place (same URL, no redirect) rather than
// navigating away, which the URL-based check in preflight.js can't see.
async function generateToolWithGemini(form, apiKey, model, memory) {
  const fieldKeys = form.fields.map((f) => f.key);
  if (fieldKeys.length === 0) {
    return { ok: false, reason: "form has no usable fields" };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const nameInstruction = form.existingToolName
    ? `This form already has a WebMCP tool name assigned by the developer — reuse it EXACTLY, do not rename it: "${form.existingToolName}"`
    : "No existing tool name — invent a clear, verb-first camelCase name for the action (e.g. submitLoginForm, createInvoice, addBeneficiary).";
  const memorySection = memory
    ? `\nDeveloper's notes about this application (use this to judge what you're actually looking at — e.g. it may say the app requires logging in first, name specific screens to ignore, or explain what a field is really for):\n"""\n${memory}\n"""\n`
    : "";

  const prompt = `You are an expert engineer writing a WebMCP tool definition (the document.modelContext.registerTool contract: a name, a description, a JSON Schema input contract, and a success message) for one screen of a real web app.

Below is FACTUAL data extracted directly from a real <form> in the page's live DOM. Any explicit HTML5 validation attribute given below (required/pattern/minLength/maxLength/min/max/options) was written by the developer — treat it as ground truth and NEVER contradict or loosen it. Where a field has no explicit attribute for something, use your judgement from its name/label/placeholder/type to propose a realistic, sensible constraint (e.g. a field that looks like an email should get an email-format regex pattern; a field that looks like a password should get a reasonable minLength; a field whose label mentions "(optional)" must be left out of "required"; a checkbox must be type "boolean" and must never be required).
${memorySection}
First, decide whether this form is actually the screen to test, or a PREREQUISITE GATE (login, consent, tenant picker, etc.) that just happens to be what's currently rendered — some apps show a gate in place, at the same URL, instead of redirecting to a separate page. Judge this from the developer's notes above (if any) and from the fields/labels/heading themselves (e.g. only email+password fields with a heading like "Log in" or "Sign in" is almost always a gate, not the feature under test).

If it IS a gate, return ONLY this JSON object, no other text:
{ "isGate": true, "gateReason": "one short sentence explaining why this looks like a gate, not the target screen" }

Otherwise, return ONLY a JSON object with this exact shape, no other text:
{
  "name": "camelCase tool name",
  "description": "one short sentence describing what this tool does",
  "schema": {
    "type": "object",
    "properties": { "<fieldKey>": { "type": "string|number|integer|boolean", "description": "...", "...other JSON Schema constraints as applicable...": "..." } },
    "required": ["field keys that must be provided"]
  },
  "successMessage": "a template-literal BODY (no surrounding backticks/quotes) using \${d.fieldKey} placeholders, referencing only fields in schema.properties"
}

Page title: ${form.pageTitle || "(none)"}
Screen heading: ${form.headingText || "(none)"}
Submit button text: ${form.submitButtonText || "(none)"}
${nameInstruction}

Fields (JSON, in DOM order):
${JSON.stringify(form.fields, null, 2)}

Strict rules:
- "schema.properties" must have EXACTLY one entry per field key given above — ${JSON.stringify(fieldKeys)} — no more, no fewer, no renamed or invented keys.
- "type" must be one of: string, number, integer, boolean.
- The runtime validator that will check this schema ONLY understands these keywords: type, pattern,
  enum, minimum, maxLength, minLength, description. It does NOT understand "format", "maximum",
  "exclusiveMinimum/Maximum", "minItems", or any other JSON Schema keyword — those would be silently
  ignored, so NEVER use them. For anything format-like (email, phone, ID number, etc.), always use
  "pattern" with a real ECMAScript-compatible regex string instead — e.g. for an email field use
  something like "pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", never "format": "email".
- A select field must get "enum" with exactly its given option values (as numbers if the field's dataType is "integer", otherwise as strings).
- A checkbox field must have "type": "boolean" and must NOT appear in "required".
- Never put a field in "required" if its label mentions "(optional)".
- Your entire response must be one valid JSON document. Inside any string value — especially a regex
  in "pattern" — every backslash must be doubled so the JSON itself parses: write "^[^\\\\s@]+@..."
  (which decodes to the regex \\s), never a lone "\\s" or "\\d" in the raw JSON text.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 },
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, reason: "Gemini API request failed: " + err.message };
  }

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, reason: `Gemini API returned an error (${res.status}): ${text.slice(0, 300)}` };
  }

  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    return { ok: false, reason: `Gemini response had no expected content (finishReason: ${finishReason || "unknown"})` };
  }

  const parseResult = tryParseJsonLoose(rawText);
  if (!parseResult.ok) {
    const truncationNote = finishReason === "MAX_TOKENS" ? " (response was truncated — hit maxOutputTokens)" : "";
    return { ok: false, reason: `Gemini response is not valid JSON${truncationNote}: ${rawText.slice(0, 300)}` };
  }
  const parsed = parseResult.value;

  if (parsed && parsed.isGate === true) {
    return { ok: true, isGate: true, reason: parsed.gateReason || "Gemini judged this to be a prerequisite gate, not the target screen." };
  }

  if (!parsed || !parsed.name || !parsed.schema || !parsed.schema.properties) {
    return { ok: false, reason: "Gemini response is missing name/schema/properties" };
  }

  const expected = new Set(fieldKeys);
  const gotKeys = Object.keys(parsed.schema.properties);
  const missing = fieldKeys.filter((k) => !gotKeys.includes(k));
  const extra = gotKeys.filter((k) => !expected.has(k));
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      reason: `Gemini's schema fields don't match the real form fields (missing: [${missing.join(", ")}], invented: [${extra.join(", ")}])`,
    };
  }

  parsed.schema.type = "object";
  parsed.schema.required = Array.isArray(parsed.schema.required) ? parsed.schema.required.filter((k) => expected.has(k)) : [];
  parsed.schema.properties = sanitizeSchemaProperties(parsed.schema.properties);
  if (typeof parsed.successMessage === "string") {
    // Strip backticks so it can't break out of the template literal it gets spliced into.
    parsed.successMessage = parsed.successMessage.replace(/`/g, "'");
  }

  return { ok: true, tool: parsed };
}

function schemaToSourceLiteral(schema, indent) {
  // Pretty-print as a JS object literal (not JSON) so it matches the
  // existing hand-written style in index.html, keeping property
  // descriptions readable instead of collapsed onto one line.
  const pad = " ".repeat(indent);
  const pad2 = " ".repeat(indent + 2);
  const propLines = Object.entries(schema.properties).map(([key, rule]) => {
    const parts = Object.entries(rule).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return `${pad2}${key}: { ${parts.join(", ")} }`;
  });
  const requiredLiteral = JSON.stringify(schema.required);
  return (
    `{\n${pad}type: "object",\n${pad}properties: {\n${propLines.join(",\n")}\n${pad}},\n` +
    `${pad}required: ${requiredLiteral}\n${" ".repeat(indent - 2)}}`
  );
}

function generateToolEntrySource(tool) {
  const schemaLiteral = schemaToSourceLiteral(tool.schema, 6);
  const successMessageBody = tool.successMessageTemplate || `${tool.toolName} completed successfully.`;
  return (
    `  // >>> agent-generated by codegen-agent.js (Gemini-authored) — review before merging <<<\n` +
    `  {\n` +
    `    name: "${tool.toolName}",\n` +
    `    description: ${JSON.stringify(tool.description)},\n` +
    `    schema: ${schemaLiteral},\n` +
    `    successMessage: (d) => \`${successMessageBody}\`\n` +
    `  }`
  );
}

// The closing `];` may sit at column 0 (webmcp-demo/index.html's
// top-level convention) or be indented (our own standalone-block
// convention, nested inside an IIFE) — tolerate either so a second
// codegen run against an already-patched file finds and extends the
// same array instead of creating a duplicate.
const TOOLS_ARRAY_RE = /const\s+TOOLS\s*=\s*\[([\s\S]*?)\n([ \t]*)\];/;

function existingToolNames(source) {
  const match = source.match(TOOLS_ARRAY_RE);
  if (!match) return { names: new Set(), hasArray: false };
  const names = new Set();
  const nameRe = /name:\s*"([^"]+)"/g;
  let m;
  while ((m = nameRe.exec(match[1]))) names.add(m[1]);
  return { names, hasArray: true };
}

function insertToolsIntoSource(source, newToolEntries) {
  const arrayMatch = source.match(TOOLS_ARRAY_RE);
  if (!arrayMatch) {
    throw new Error("Could not find `const TOOLS = [ ... ];` array in this file — cannot auto-insert generated tools.");
  }
  const [fullMatch, arrayBody, closingIndent] = arrayMatch;
  const before = fullMatch.slice(0, fullMatch.length - 1 - closingIndent.length - 2); // strip trailing "\n" + indent + "];"
  const insertion = newToolEntries.map((t) => generateToolEntrySource(t)).join(",\n");
  const patchedBlock = `${before},\n${insertion}\n${closingIndent}];`;
  return source.replace(fullMatch, patchedBlock);
}

// For a page with NO existing WebMCP wiring at all (no TOOLS array, no
// polyfill) — i.e. any arbitrary HTML page, not just ones already
// following webmcp-demo's convention. Builds one self-contained
// <script> block: a minimal document.modelContext polyfill (skipped if
// native support already exists), the same schema validator used
// throughout this project, a TOOLS array, and the registration loop.
// It's wrapped in its own IIFE so it can't collide with anything already
// on the page, and because it uses the exact `const TOOLS = [...]`
// shape, a later codegen run against this same file will find and
// extend THIS array via insertToolsIntoSource() instead of creating a
// second competing block.
function buildStandaloneScriptBlock(tools) {
  const toolEntries = tools.map((t) => generateToolEntrySource(t)).join(",\n");
  return `
<!-- >>> WebMCP tools auto-generated by codegen-agent.js (Gemini-authored) — review before merging <<< -->
<script>
(function () {
  if (!document.modelContext) {
    const registry = new Map();
    document.modelContext = {
      async registerTool(tool) { registry.set(tool.name, tool); return { unregister: () => registry.delete(tool.name) }; },
      async getTools() { return Array.from(registry.values()).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })); },
      async executeTool(toolRef, params) {
        const tool = registry.get(toolRef.name || toolRef);
        if (!tool) throw new Error("Tool not found: " + (toolRef.name || toolRef));
        return await tool.execute(params);
      }
    };
  }

  function validateAgainstSchema(schema, data) {
    const errors = [];
    for (const key of schema.required || []) {
      if (data[key] === undefined || data[key] === null || data[key] === "") errors.push(\`\${key} is required\`);
    }
    for (const [key, rule] of Object.entries(schema.properties)) {
      const val = data[key];
      if (val === undefined || val === null || val === "") continue;
      if (rule.type === "string" && typeof val !== "string") errors.push(\`\${key} must be text\`);
      if ((rule.type === "number" || rule.type === "integer") && (typeof val !== "number" || Number.isNaN(val))) errors.push(\`\${key} must be a number\`);
      if (rule.type === "integer" && typeof val === "number" && !Number.isInteger(val)) errors.push(\`\${key} must be an integer\`);
      if (rule.type === "boolean" && typeof val !== "boolean") errors.push(\`\${key} must be a boolean\`);
      if (rule.pattern && typeof val === "string" && !(new RegExp(rule.pattern).test(val))) errors.push(\`\${key} does not match the required format (\${rule.pattern})\`);
      if (rule.enum && !rule.enum.includes(val)) errors.push(\`\${key} must be one of: \${rule.enum.join(", ")}\`);
      if (rule.minimum !== undefined && typeof val === "number" && val < rule.minimum) errors.push(\`\${key} must be at least \${rule.minimum}\`);
      if (rule.maxLength !== undefined && typeof val === "string" && val.length > rule.maxLength) errors.push(\`\${key} must be at most \${rule.maxLength} characters\`);
      if (rule.minLength !== undefined && typeof val === "string" && val.length < rule.minLength) errors.push(\`\${key} must be at least \${rule.minLength} characters\`);
    }
    return errors;
  }

  function makeHandler(schema, successMessage) {
    return function (data) {
      const errors = validateAgainstSchema(schema, data);
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, message: successMessage(data) };
    };
  }

  const TOOLS = [
${toolEntries}
  ];

  TOOLS.forEach((t) => {
    const handler = makeHandler(t.schema, t.successMessage);
    document.modelContext.registerTool({
      name: t.name,
      description: t.description,
      inputSchema: t.schema,
      async execute(params) {
        const result = handler(params);
        if (!result.ok) return { content: [{ type: "text", text: "ERROR: " + result.errors.join("; ") }], isError: true };
        return { content: [{ type: "text", text: result.message }] };
      }
    });
  });

  // Prevent a real click on the submit button (by a human, or by a test
  // agent's visual cursor demo) from navigating the page away via the
  // browser's default form submission — the WebMCP contract is
  // executeTool() above, not the native submit. Without this, an
  // in-flight test run driving the visible form can get cut off mid-loop
  // by an unexpected full-page navigation.
  document.querySelectorAll("form[data-tool]").forEach((form) => {
    form.addEventListener("submit", (e) => e.preventDefault());
  });
})();
</script>
`;
}

function insertStandaloneBlock(source, tools) {
  const block = buildStandaloneScriptBlock(tools);
  if (/<\/body>/i.test(source)) return source.replace(/<\/body>/i, `${block}\n</body>`);
  return source + block;
}

// ---------------------------------------------------------------------
// Attribute patching
// ---------------------------------------------------------------------
// Deliberately regex/text-based rather than parsing the whole document
// into a DOM tree and re-serializing it: a full parse+reprint would
// reformat everything else in the developer's file (quote style,
// whitespace, attribute order) just to add a couple of attributes,
// producing a noisy diff. The trade-off is the usual one for text-based
// HTML patching — it assumes reasonably well-formed markup (no literal
// ">" inside an attribute value, no nested <form> — both true for every
// real page this has been run against) — which is an accepted limitation
// here, not an oversight.

// Finds each top-level <form>...</form> block in document order. Forms
// don't nest in valid HTML, so a sequential non-greedy match correctly
// enumerates them in the same order Playwright's querySelectorAll('form')
// (used by extractFormFieldsInPage) sees them in the browser.
function findFormBlocks(source) {
  const re = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(source))) blocks.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return blocks;
}

const FIELD_TAG_RE = /<(input|select|textarea)\b([^>]*)>/gi;

// Mirrors isUsableField() in extractFormFieldsInPage() so the Nth tag
// matched here is the same field as the Nth entry in a tool's field list.
function isUsableFieldTag(tag, attrs) {
  if (tag === "input") {
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([a-zA-Z]+)/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : "text";
    if (["submit", "button", "hidden", "reset", "image"].includes(type)) return false;
  }
  if (/\bdisabled\b/i.test(attrs)) return false;
  return true;
}

// Appends an attribute onto a tag's attribute string, correctly handling
// a self-closing "/>" input so the slash doesn't end up stranded mid-tag.
function appendAttribute(tag, attrs, attrString) {
  const selfClosing = /\/\s*$/.test(attrs);
  const cleanAttrs = attrs.replace(/\/\s*$/, "").replace(/\s+$/, "");
  return `<${tag}${cleanAttrs} ${attrString}${selfClosing ? " /" : ""}>`;
}

// Tags every usable field inside the given form (in DOM order) with
// data-field="<key>" — the same key Gemini's schema uses for it —
// whenever the field doesn't already have one. Without this, nothing
// downstream that looks the field up by its schema key can find the
// actual <input>/<select>/<textarea> element: not the project's own
// `.app-form` submit handler, and not webmcp-agent-ui's test-run cursor,
// which fills each field via `form.querySelector('[data-field="key"]')`
// before calling executeTool() — if that selector never matches, the
// cursor silently skips every field and jumps straight to the submit
// button, even though executeTool() itself (which validates params
// directly, not by reading the DOM) still works and the test still
// passes. This was exactly that bug: only the <form> got data-tool,
// never the individual fields.
function ensureFieldDataAttributes(source, formIndex, fieldKeysInOrder) {
  const block = findFormBlocks(source)[formIndex];
  if (!block) return source;

  let idx = 0;
  const patchedBlock = block.text.replace(FIELD_TAG_RE, (full, tag, attrs) => {
    const lowerTag = tag.toLowerCase();
    if (!isUsableFieldTag(lowerTag, attrs)) return full;
    const key = fieldKeysInOrder[idx];
    idx++;
    if (key === undefined || /\bdata-field\s*=/i.test(attrs)) return full;
    return appendAttribute(lowerTag, attrs, `data-field="${key}"`);
  });

  return source.slice(0, block.start) + patchedBlock + source.slice(block.end);
}

// Adds data-tool / class="app-form" to a <form> that doesn't have them
// yet, so the page's own generic TOOLS.forEach()/`.app-form` handlers
// pick the new screen up exactly like the other screens.
function ensureFormDataTool(source, formIndex, toolName) {
  const block = findFormBlocks(source)[formIndex];
  if (!block) return source;

  const patchedBlock = block.text.replace(/^<form\b([^>]*)>/i, (full, attrs) => {
    let patched = attrs;
    if (!/\bdata-tool\s*=/i.test(patched)) patched += ` data-tool="${toolName}"`;
    if (!/class\s*=\s*"[^"]*\bapp-form\b/i.test(patched)) {
      if (/class\s*=/i.test(patched)) patched = patched.replace(/class\s*=\s*"([^"]*)"/i, `class="$1 app-form"`);
      else patched += ` class="app-form"`;
    }
    return `<form${patched}>`;
  });

  return source.slice(0, block.start) + patchedBlock + source.slice(block.end);
}

// Handles the case where Gemini judged the CURRENT screen itself (not a
// redirect target — see ensureReachable in preflight.js for that case)
// to be a gate rendered in place, e.g. an SPA that shows its login form
// at the same URL instead of navigating to /login. Reloads the same URL
// fresh, finds an existing tool matching the configured credentials, and
// calls it — same "discover and call a real tool" mechanism as the
// URL-redirect case, just without a URL change to key off of.
async function tryUnlockGate(targetUrl, credentials, log) {
  if (!credentials) return { ok: false, reason: "no test credentials configured (set them via the ⚙ settings panel)" };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(targetUrl, { waitUntil: "load" });

  const hasMcp = await page.evaluate(() => !!document.modelContext);
  if (!hasMcp) {
    await browser.close();
    return { ok: false, reason: "no document.modelContext on this page to call a tool through" };
  }

  const tools = await page.evaluate(async () => {
    const list = await document.modelContext.getTools();
    return list.map((t) => {
      let schema = t.inputSchema;
      if (typeof schema === "string") {
        try {
          schema = JSON.parse(schema);
        } catch {
          schema = { properties: {} };
        }
      }
      return { name: t.name, inputSchema: schema || { properties: {} } };
    });
  });

  const match = matchCredentialTool(tools, credentials);
  if (!match) {
    await browser.close();
    return { ok: false, reason: `found ${tools.length} tool(s) (${tools.map((t) => t.name).join(", ") || "none"}) but none matched the configured credentials` };
  }

  log(`   Calling existing tool "${match.tool.name}" with the configured test credentials...`);
  const result = await page.evaluate(
    async ({ name, input }) => {
      try {
        const res = await document.modelContext.executeTool({ name }, input);
        return { ok: !res.isError, text: (res.content && res.content[0] && res.content[0].text) || "" };
      } catch (err) {
        return { ok: false, text: err.message };
      }
    },
    { name: match.tool.name, input: match.input }
  );
  await browser.close();
  if (!result.ok) return { ok: false, reason: `"${match.tool.name}" failed: ${result.text}` };
  log(`   "${match.tool.name}" succeeded ("${result.text}").`);
  return { ok: true };
}

async function generateForFile(filePath, dryRun, apiKey, model, memory, gateRetriesLeft = 1) {
  console.log(`\n>> Analyzing screen: ${path.relative(REPO_ROOT, filePath)}`);
  console.log(">> PHASE: discover");
  const source = fs.readFileSync(filePath, "utf-8");
  const { names: existingNames, hasArray } = existingToolNames(source);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const targetUrl = "file://" + path.resolve(filePath);
  const credentials = parseTestCredentials(process.env.WEBMCP_TEST_CREDENTIALS);
  const reach = await ensureReachable(page, targetUrl, credentials, (line) => console.log(line));
  if (!reach.ok) {
    console.log(`   ERROR: could not reach this screen to analyze it: ${reach.reason}`);
    await browser.close();
    return { filePath, wroteAny: false };
  }
  const forms = await page.evaluate(extractFormFieldsInPage);
  await browser.close();

  if (forms.length === 0) {
    console.log("   No <form> elements found on this screen — nothing to generate.");
    return { filePath, wroteAny: false };
  }

  const candidates = forms.filter((f) => !(f.existingToolName && existingNames.has(f.existingToolName)));
  if (candidates.length === 0) {
    console.log(`   All ${forms.length} form(s) already have WebMCP tool code (${[...existingNames].join(", ")}). Nothing to generate.`);
    return { filePath, wroteAny: false };
  }

  console.log(`   Found ${candidates.length} screen(s) without WebMCP code yet — asking Gemini to write the WebMCP tool(s)...`);
  console.log(">> PHASE: gemini-tool");

  const usedNames = new Set(existingNames);
  const newTools = [];
  for (const form of candidates) {
    const result = await generateToolWithGemini(form, apiKey, model, memory);

    if (result.ok && result.isGate) {
      console.log(`   Gemini judged form #${form.formIndex + 1} to be a prerequisite gate, not the target screen: ${result.reason}`);
      if (gateRetriesLeft <= 0) {
        console.log("   Already retried once after a gate — not trying again, to avoid looping.");
        continue;
      }
      const unlocked = await tryUnlockGate(targetUrl, credentials, (line) => console.log(line));
      if (!unlocked.ok) {
        console.log(`   Could not get past the gate automatically: ${unlocked.reason}`);
        console.log("   Configure test credentials (⚙ settings panel) — and app notes describing this flow, if useful — so the agent can get past it on its own.");
        continue;
      }
      console.log("   Got past the gate — re-analyzing the screen...");
      return await generateForFile(filePath, dryRun, apiKey, model, memory, gateRetriesLeft - 1);
    }

    if (!result.ok) {
      console.log(`   SKIPPED form #${form.formIndex + 1} — Gemini tool generation failed: ${result.reason}`);
      continue;
    }
    let { name, description, schema, successMessage } = result.tool;
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name}${n}`)) n++;
      console.log(`   NOTE: Gemini's name "${name}" collides with an existing tool — using "${name}${n}" instead.`);
      name = `${name}${n}`;
    }
    usedNames.add(name);
    newTools.push({
      formIndex: form.formIndex,
      hasDataTool: form.hasDataTool,
      // Captured independently of schema.properties' key order: JSON
      // object key order from an LLM response isn't a guarantee, and
      // field-tag patching below must line up with the real DOM order.
      fieldKeysInOrder: form.fields.map((f) => f.key),
      toolName: name,
      description,
      schema,
      successMessageTemplate: successMessage || null,
    });
    console.log(`   ✓ "${name}" (${Object.keys(schema.properties).length} field(s), form #${form.formIndex + 1}) — written by Gemini`);
  }

  if (newTools.length === 0) {
    console.log("   No tools could be generated (all skipped) — nothing written.");
    return { filePath, wroteAny: false };
  }

  if (dryRun) {
    console.log("\n--- dry run: generated tool code (not written) ---\n");
    for (const t of newTools) console.log(generateToolEntrySource(t) + "\n");
    return { filePath, wroteAny: false };
  }

  console.log(">> PHASE: write");
  let patched;
  if (hasArray) {
    patched = insertToolsIntoSource(source, newTools);
  } else {
    console.log("   No existing WebMCP wiring found on this page — adding a self-contained <script> block");
    console.log("   (polyfill + schema validator + TOOLS array) right before </body>.");
    patched = insertStandaloneBlock(source, newTools);
  }
  for (const t of newTools) {
    // Always tag fields (even when the form already had data-tool set by
    // the developer) — a pre-existing data-tool doesn't imply the
    // individual fields already carry data-field too.
    patched = ensureFieldDataAttributes(patched, t.formIndex, t.fieldKeysInOrder);
    if (!t.hasDataTool) patched = ensureFormDataTool(patched, t.formIndex, t.toolName);
  }
  fs.writeFileSync(filePath, patched, "utf-8");
  console.log(`   Wrote ${newTools.length} tool(s) into ${path.relative(REPO_ROOT, filePath)}.`);

  return { filePath, wroteAny: true };
}

function runTestsAgainst(url, jsonOut) {
  console.log(`\n>> Running WebMCP test agent against: ${url}\n`);
  const runnerArgs = [path.join(__dirname, "runner.js"), url];
  if (jsonOut) runnerArgs.push("--json-out", jsonOut);
  const result = spawnSync("node", runnerArgs, {
    cwd: __dirname,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (!apiKey) {
    console.error("ERROR: GEMINI_API_KEY is required. WebMCP tools and their test scenarios are");
    console.error("always written by Gemini — there is no heuristic/mock fallback anywhere in this");
    console.error("pipeline. Set GEMINI_API_KEY and retry.");
    process.exit(1);
  }

  let targets;
  if (args.file) {
    const abs = path.resolve(args.file);
    REPO_ROOT = findRepoRoot(path.dirname(abs));
    targets = [abs];
  } else {
    REPO_ROOT = findRepoRoot(process.cwd());
    targets = findChangedHtmlFiles(args.base);
    if (targets.length === 0) {
      const fallback = path.join(DEMO_DIR, "index.html");
      console.log(">> No changed .html files detected via git — falling back to webmcp-demo/index.html.");
      targets = [fallback];
    } else {
      console.log(`>> Detected ${targets.length} changed screen(s) via git: ${targets.map((f) => path.relative(REPO_ROOT, f)).join(", ")}`);
    }
  }

  const memory = process.env.WEBMCP_APP_MEMORY || null;

  let anyWritten = false;
  for (const file of targets) {
    const res = await generateForFile(file, args.dryRun, apiKey, model, memory);
    anyWritten = anyWritten || res.wroteAny;
  }

  if (args.dryRun) {
    console.log("\n>> Dry run complete — skipping test execution.");
    return;
  }

  console.log(">> PHASE: test");
  const url = args.url || "file://" + path.resolve(targets[0]);
  const exitCode = runTestsAgainst(url, args.jsonOut);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("codegen-agent failed:", err);
  process.exit(1);
});
