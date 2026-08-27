const { chromium } = require("playwright");

async function check(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(e => console.log("goto hata:", e.message));
  await page.waitForTimeout(1500);
  const diag = await page.evaluate(async () => {
    const has = !!document.modelContext;
    let tools = [];
    if (has) {
      try { tools = await document.modelContext.getTools(); } catch (e) { tools = ["hata: " + e.message]; }
    }
    return { has, tools };
  });
  console.log(`\n=== ${url} ===`);
  console.log(JSON.stringify(diag, null, 2));
  await browser.close();
}

(async () => {
  await check("https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/");
  await check("https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/");
})();
