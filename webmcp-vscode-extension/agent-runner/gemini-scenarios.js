// Generates test scenarios from a WebMCP tool schema using Gemini.
// This is the ONLY scenario source runner.js uses — there is no
// rule-based/mock fallback; if Gemini can't produce scenarios, the
// caller skips that tool rather than substituting synthetic data.

async function generateScenariosWithGemini(tool, apiKey, model) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    return { ok: false, reason: "GEMINI_API_KEY is not set" };
  }

  const mdl = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${key}`;

  const prompt = `You are an experienced QA/test engineer. Below is a WebMCP tool's name,
description, and JSON Schema. Based on this schema, generate at least 6 and at most 10
distinct test scenarios: include both valid (happy path) cases and cases that violate the
rules (boundary values, invalid format, missing required field, unusual/edge-case input).

Rules:
- Every key in the "input" field must EXACTLY match a property name in the schema's "properties".
- "expectSuccess": decide, based on the schema's rules, whether this input should be
  accepted (true) or rejected (false).
- Return ONLY a JSON array in the following format, with no other explanation:
  [{"name": "...", "input": {...}, "expectSuccess": true}]

Tool name: ${tool.name}
Description: ${tool.description || ""}
JSON Schema: ${JSON.stringify(tool.inputSchema)}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 }
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
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

  let scenarios;
  try {
    scenarios = JSON.parse(rawText);
  } catch (err) {
    const truncationNote = finishReason === "MAX_TOKENS" ? " (response was truncated — hit maxOutputTokens)" : "";
    return { ok: false, reason: `Gemini response is not valid JSON${truncationNote}: ${rawText.slice(0, 300)}` };
  }

  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return { ok: false, reason: "Gemini returned an empty/invalid scenario list" };
  }

  return { ok: true, scenarios };
}

module.exports = { generateScenariosWithGemini };
