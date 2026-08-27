const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleLogs = [];
  page.on('console', msg => consoleLogs.push(msg.text()));

  await page.goto("https://salespeak.ai/", { waitUntil: "networkidle", timeout: 30000 }).catch(e => console.log("goto hata:", e.message));
  await page.waitForTimeout(3000);

  const diag = await page.evaluate(() => {
    const result = {};
    result.hasDocumentModelContext = !!document.modelContext;
    result.hasWindowModelContext = !!window.modelContext;
    result.hasWindowMcp = !!window.mcp;
    result.hasNavigatorModelContext = !!(navigator).modelContext;
    result.iframeCount = document.querySelectorAll('iframe').length;
    result.iframeSrcs = Array.from(document.querySelectorAll('iframe')).map(f => f.src).slice(0, 10);
    // sayfa kaynağında "modelContext" veya "webmcp" geçen script var mı
    const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src).filter(Boolean);
    result.scriptSrcs = scripts.slice(0, 20);
    result.bodyHtmlSnippetHasModelContext = document.documentElement.outerHTML.includes('modelContext');
    result.bodyHtmlSnippetHasWebMCP = document.documentElement.outerHTML.toLowerCase().includes('webmcp');
    result.metaTags = Array.from(document.querySelectorAll('meta')).map(m => ({name: m.name, content: m.content})).filter(m => m.name);
    return result;
  });

  console.log(JSON.stringify(diag, null, 2));
  console.log("\n--- Console logs (ilk 20) ---");
  console.log(consoleLogs.slice(0, 20).join("\n"));

  await browser.close();
}
main();
