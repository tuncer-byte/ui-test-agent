// Gemini AI ile WebMCP tool şemasından test senaryosu üretimi.
// apiKey/model çağıran taraftan (renderer'daki input) parametre olarak gelir.

async function generateScenariosWithGemini(tool, apiKey, model) {
  if (!apiKey) {
    return { ok: false, reason: "API key girilmedi" };
  }
  const useModel = model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${apiKey}`;

  const prompt = `Sen deneyimli bir QA/test mühendisisin. Aşağıda bir WebMCP tool'unun adı,
açıklaması ve JSON Schema'sı verildi. Bu şemaya dayanarak en az 6, en fazla 10 farklı
test senaryosu üret: hem geçerli (happy path) hem de kuralları ihlal eden (sınır değer,
hatalı format, eksik zorunlu alan, olağandışı/edge-case girdi) senaryolar olsun.

Kurallar:
- "input" alanındaki her key, şemadaki "properties" isimleriyle BİREBİR aynı olmalı.
- "expectSuccess": şemadaki kurallara göre bu girdi kabul edilmeli mi (true) yoksa
  reddedilmeli mi (false) olduğunu sen karar ver.
- Sadece aşağıdaki formatta bir JSON dizisi döndür, başka hiçbir açıklama ekleme:
  [{"name": "...", "input": {...}, "expectSuccess": true}]

Tool adı: ${tool.name}
Açıklama: ${tool.description || ""}
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
    return { ok: false, reason: "Gemini API isteği başarısız: " + err.message };
  }

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, reason: `Gemini API hata döndürdü (${res.status}): ${text.slice(0, 300)}` };
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    return { ok: false, reason: "Gemini yanıtında beklenen içerik yok" };
  }

  let scenarios;
  try {
    scenarios = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, reason: "Gemini yanıtı geçerli JSON değil: " + rawText.slice(0, 300) };
  }

  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return { ok: false, reason: "Gemini boş/geçersiz senaryo listesi döndürdü" };
  }

  return { ok: true, scenarios };
}

module.exports = { generateScenariosWithGemini };
