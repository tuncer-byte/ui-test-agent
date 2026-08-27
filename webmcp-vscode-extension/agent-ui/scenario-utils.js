// Rule-based fallback scenario generator (kicks in if there's no Gemini key or it errors).
// Pure JS so it can run in both the main process (Node) and the renderer.

function genericValidValue(key, rule) {
  if (rule.examples && rule.examples.length) return rule.examples[0];
  if (rule.default !== undefined) return rule.default;
  if (rule.enum && rule.enum.length) return rule.enum[0];
  if (rule.pattern) {
    try {
      const RandExp = require("randexp");
      return new RandExp(rule.pattern).gen();
    } catch (e) { /* no randexp available, fall through to the generic value below */ }
  }
  if (rule.type === "number" || rule.type === "integer") {
    const min = rule.minimum !== undefined ? rule.minimum : 0;
    return min + 1;
  }
  if (rule.type === "boolean") return true;
  let v = `sample-${key}`;
  if (rule.minLength && v.length < rule.minLength) v = v.padEnd(rule.minLength, "x");
  if (rule.maxLength && v.length > rule.maxLength) v = v.slice(0, rule.maxLength);
  return v;
}

function buildValidSample(schema) {
  const sample = {};
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    sample[key] = genericValidValue(key, rule);
  }
  return sample;
}

function generateScenariosFromSchema(schema) {
  const scenarios = [];
  const base = buildValidSample(schema);
  scenarios.push({ name: "Happy Path - valid data", input: { ...base }, expectSuccess: true });

  for (const [key, rule] of Object.entries(schema.properties || {})) {
    if (rule.pattern) {
      scenarios.push({ name: `${key} - format violation (pattern)`, input: { ...base, [key]: "@@INVALID@@" }, expectSuccess: false });
    }
    if (rule.enum && rule.enum.length) {
      const invalidEnumValue = typeof rule.enum[0] === "number" ? -999999 : "INVALID_VALUE";
      scenarios.push({ name: `${key} - value outside enum`, input: { ...base, [key]: invalidEnumValue }, expectSuccess: false });
    }
    if (rule.minimum !== undefined) {
      scenarios.push({ name: `${key} - boundary violation (minimum ${rule.minimum})`, input: { ...base, [key]: rule.minimum - 1 }, expectSuccess: false });
    }
    if (rule.maxLength !== undefined) {
      scenarios.push({ name: `${key} - length violation (maxLength ${rule.maxLength})`, input: { ...base, [key]: "x".repeat(rule.maxLength + 20) }, expectSuccess: false });
    }
    if (rule.minLength) {
      scenarios.push({ name: `${key} - minLength violation`, input: { ...base, [key]: "" }, expectSuccess: false });
    }
    if (rule.type === "integer") {
      scenarios.push({ name: `${key} - non-integer value`, input: { ...base, [key]: (typeof base[key] === "number" ? base[key] : 1) + 0.5 }, expectSuccess: false });
    }
  }
  for (const key of schema.required || []) {
    const clone = { ...base };
    delete clone[key];
    scenarios.push({ name: `${key} - missing required field`, input: clone, expectSuccess: false });
  }
  return scenarios;
}

module.exports = { generateScenariosFromSchema };
