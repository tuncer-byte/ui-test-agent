// Genel amaçlı WebMCP Test Agent Runner
// Kullanım: node runner.js <URL>
// Herhangi bir canlı sitedeki document.modelContext tool'larını
// keşfeder, şemadan senaryo üretir, çalıştırır ve sonucu raporlar.

const { chromium } = require("playwright");
const RandExp = require("randexp");

function genericValidValue(key, rule) {
  if (rule.examples && rule.examples.length) return rule.examples[0];
  if (rule.default !== undefined) return rule.default;
  if (rule.enum && rule.enum.length) return rule.enum[0];
  if (rule.pattern) {
    try { return new RandExp(rule.pattern).gen(); } catch (e) { /* düş */ }
  }
  if (rule.type === "number" || rule.type === "integer") {
    const min = rule.minimum !== undefined ? rule.minimum : 0;
    return min + 1;
  }
  if (rule.type === "boolean") return true;
  let v = `ornek-${key}`;
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
  scenarios.push({ name: "Happy Path - geçerli veri", input: { ...base }, expectSuccess: true });

  for (const [key, rule] of Object.entries(schema.properties || {})) {
    if (rule.pattern) {
      scenarios.push({ name: `${key} - format ihlali (pattern)`, input: { ...base, [key]: "@@GECERSIZ@@" }, expectSuccess: false });
    }
    if (rule.minimum !== undefined) {
      scenarios.push({ name: `${key} - sınır ihlali (minimum ${rule.minimum})`, input: { ...base, [key]: rule.minimum - 1 }, expectSuccess: false });
    }
    if (rule.maxLength !== undefined) {
      scenarios.push({ name: `${key} - uzunluk ihlali (maxLength ${rule.maxLength})`, input: { ...base, [key]: "x".repeat(rule.maxLength + 20) }, expectSuccess: false });
    }
    if (rule.minLength) {
      scenarios.push({ name: `${key} - minLength ihlali`, input: { ...base, [key]: "" }, expectSuccess: false });
    }
  }
  for (const key of schema.required || []) {
    const clone = { ...base };
    delete clone[key];
    scenarios.push({ name: `${key} - zorunlu alan eksik`, input: clone, expectSuccess: false });
  }
  return scenarios;
}

async function waitForModelContext(page, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exists = await page.evaluate(() => !!document.modelContext);
    if (exists) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Kullanım: node runner.js <URL>");
    process.exit(1);
  }

  console.log(`\n>> Hedef: ${url}`);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });

  const hasMcp = await waitForModelContext(page);
  if (!hasMcp) {
    console.error("HATA: Bu sayfada document.modelContext bulunamadı (WebMCP tool'u kayıtlı değil).");
    await browser.close();
    process.exit(1);
  }

  const tools = await page.evaluate(async () => {
    const list = await document.modelContext.getTools();
    return list;
  });

  console.log(`>> ${tools.length} tool bulundu: ${tools.map(t => t.name).join(", ")}\n`);

  let totalPass = 0, totalCount = 0;

  for (const tool of tools) {
    console.log(`=== TOOL: ${tool.name} ===`);
    console.log(`    ${tool.description || ""}`);
    const scenarios = generateScenariosFromSchema(tool.inputSchema || { properties: {} });

    for (const scenario of scenarios) {
      totalCount++;
      const result = await page.evaluate(
        async ({ toolName, input }) => {
          try {
            const res = await document.modelContext.executeTool({ name: toolName }, input);
            return { actualSuccess: !res.isError, text: res.content?.[0]?.text || "" };
          } catch (err) {
            return { actualSuccess: false, text: "Exception: " + err.message };
          }
        },
        { toolName: tool.name, input: scenario.input }
      );

      const pass = result.actualSuccess === scenario.expectSuccess;
      if (pass) totalPass++;
      console.log(
        `  [${pass ? "PASS" : "FAIL"}] ${scenario.name.padEnd(42)} | beklenen=${scenario.expectSuccess ? "başarılı" : "reddedilmeli"} | gerçekleşen="${result.text}"`
      );
    }
    console.log("");
  }

  console.log(`>> TOPLAM: ${totalPass}/${totalCount} senaryo geçti`);
  await browser.close();
}

main();
