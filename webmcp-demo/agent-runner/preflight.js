// Gets an already-open Playwright `page` past any prerequisite screen
// (login, consent, tenant picker, etc.) using a WebMCP tool that ALREADY
// exists there — the developer wires that tool up themselves, the same
// way every other screen gets one (by hand, or via this project's own
// codegen agent). We only discover and call it; there's no scripted
// selector automation and no saved browser session here — if the app
// exposes its unlock step as a real WebMCP tool, the agent drives itself
// through it exactly the way it drives the screen actually under test.

async function waitForModelContext(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(() => !!document.modelContext).catch(() => false)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

function urlsMatch(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
  } catch {
    return a === b;
  }
}

function parseTestCredentials(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Picks the first tool whose schema properties can all be filled from the
// configured credentials, using simple name-based matching (email/user vs
// password) plus an exact-key fallback for anything else. Deliberately
// not Gemini-driven: these are real secrets, not data to reason about —
// keeping the match a plain, auditable heuristic instead.
function matchCredentialTool(tools, credentials) {
  const creds = credentials || {};
  if (Object.keys(creds).length === 0) return null;

  for (const tool of tools) {
    const props = Object.keys(tool.inputSchema?.properties || {});
    if (props.length === 0) continue;
    const required = tool.inputSchema?.required || props;

    const input = {};
    let matched = true;
    for (const prop of props) {
      const lower = prop.toLowerCase();
      let value;
      if (/pass/.test(lower)) value = creds.password;
      else if (/email/.test(lower)) value = creds.email ?? creds.username;
      else if (/user|login|account/.test(lower)) value = creds.username ?? creds.email;
      else value = creds[prop];

      if (value !== undefined) input[prop] = value;
      else if (required.includes(prop)) {
        matched = false;
        break;
      }
    }
    if (matched && Object.keys(input).length > 0) return { tool, input };
  }
  return null;
}

// Navigates to targetUrl. If that lands somewhere else (a redirect to a
// gate like /login), tries to find and call a matching tool on whatever
// page it landed on, then retries targetUrl. Returns { ok: true } once
// targetUrl is actually reached, or { ok: false, reason } explaining why
// not — never fabricates a way past a gate it can't actually open.
async function ensureReachable(page, targetUrl, credentials, log) {
  await page.goto(targetUrl, { waitUntil: "load" });
  await page.waitForTimeout(300); // let client-side (SPA router) redirects settle
  if (urlsMatch(page.url(), targetUrl)) return { ok: true };

  const landedUrl = page.url();
  log(`   Redirected to ${landedUrl} instead of reaching ${targetUrl} — checking for an existing WebMCP tool to get past it...`);

  if (!credentials) {
    return {
      ok: false,
      reason: `Landed on ${landedUrl} instead of ${targetUrl}, and no test credentials are configured (set them via the ⚙ settings panel) to try getting past it.`,
    };
  }
  if (!(await waitForModelContext(page, 4000))) {
    return { ok: false, reason: `No document.modelContext found on the page it landed on (${landedUrl}) either — nothing to call there.` };
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
    return {
      ok: false,
      reason: `Found ${tools.length} tool(s) on ${landedUrl} (${tools.map((t) => t.name).join(", ") || "none"}) but none matched the configured test credentials.`,
    };
  }

  log(`   Calling existing tool "${match.tool.name}" on ${landedUrl} with the configured test credentials...`);
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
  if (!result.ok) {
    return { ok: false, reason: `"${match.tool.name}" failed: ${result.text}` };
  }
  log(`   "${match.tool.name}" succeeded ("${result.text}") — retrying ${targetUrl}...`);

  await page.waitForTimeout(500);
  await page.goto(targetUrl, { waitUntil: "load" });
  await page.waitForTimeout(300);
  if (!urlsMatch(page.url(), targetUrl)) {
    return { ok: false, reason: `Still redirected to ${page.url()} after using "${match.tool.name}".` };
  }
  return { ok: true };
}

module.exports = { ensureReachable, matchCredentialTool, parseTestCredentials, urlsMatch };
