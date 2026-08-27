// Generates test scenarios from a WebMCP tool schema using Gemini.
// If GEMINI_API_KEY isn't set in .env, or the call fails, the caller
// (runner.js) falls back to the rule-based generator.

async function generateScenariosWithGemini(tool) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "GEMINI_API_KEY is not set (add it to .env)" };
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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
    generationConfig: { responseMimeType: "application/json" }
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
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    return { ok: false, reason: "Gemini response had no expected content" };
  }

  let scenarios;
  try {
    scenarios = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, reason: "Gemini response is not valid JSON: " + rawText.slice(0, 300) };
  }

  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return { ok: false, reason: "Gemini returned an empty/invalid scenario list" };
  }

  return { ok: true, scenarios };
}

module.exports = { generateScenariosWithGemini };
