# Proje Fikri: Azure DevOps Entegre, Otonom UI Test Agent'ı

> AI Native SDLC Challenge — Ana Kategori: **04 · Test** (Analysis + Development'a dokunan uçtan-uca otomasyon)

---

## 1. Tek Cümlelik Özet

Azure Repos'ta bir PR açıldığında **otomatik olarak** tetiklenen; Azure Boards'taki ilgili work item'ı (PBI/Task) ve PR'daki kod değişikliğini **Azure DevOps MCP Server** üzerinden okuyan; koddan davranış/kuralı çıkarıp kabul kriterleriyle çapraz kontrol eden; ilgili ekranı otomatik test eden; sonucu **doğrudan Azure DevOps'a** (PR check/yorum veya otomatik Bug work item olarak) yazan bir **otomasyon zinciri**.

> **Önemli tasarım ilkesi:** Bu bir chatbot/asistan değil — insanın soru sorup cevap aldığı bir arayüz yok. Agent, bir **CI/CD adımı gibi sessizce çalışıp** sonucu var olan sisteme (Board + Repo) otomatik yazıyor.

---

## 2. Problem

Ekip, işlerini **Azure Boards** (PBI, Task, Bug) ve **Azure Repos/Git** üzerinden yönetiyor. Yeni bir geliştirme PR olarak açıldığında:
- Tester, PR'ı ve ilgili PBI'ı **elle** okuyup hangi ekranın etkilendiğini, hangi kuralların test edilmesi gerektiğini kendisi çıkarıyor
- Kodun gerçekte yaptığı ile PBI'daki **kabul kriterleri** arasında sessiz sapmalar olabiliyor, bunu fark etmek tamamen tester'ın dikkatine bağlı
- Bulunan hata, elle bir Bug work item'ı olarak Azure Boards'a girilip PR'a referans veriliyor — bu manuel köprü kurma işi zaman alıyor

## 3. Neden Bu Kapsam Seçildi (Bilinçli Daraltma)

| Daraltma | Gerekçe |
|---|---|
| Tüm uygulama → **tek bir demo ekran + tek bir örnek PBI/PR akışı** | Solo ekip için 2 haftada uçtan uca çalışan bir demo şart |
| Chatbot/sohbet arayüzü → **event-driven otomasyon (pipeline adımı)** | Şart 3'ü ("sadece soru-cevap yeterli değil") en güçlü şekilde karşılıyor; insan hiçbir noktada agent'a soru sormuyor |
| Sıfırdan Azure DevOps API entegrasyonu → **resmi Azure DevOps MCP Server** (microsoft/azure-devops-mcp) | Work item, PR, pipeline erişimi hazır ve standart; entegrasyon süresi test mantığına ayrılabiliyor |
| Regresyon testi → **fonksiyonel UI testi + kabul kriteri çapraz kontrolü** | Ekibin fiilen bildiği iş + PBI-kod sapmasını yakalayan yeni bir katman |
| Otonom kod düzeltme → **kapsam dışı (v1)**; başarısızlıkta otomatik Bug work item oluşturma var | Kod değişikliğine insan onayı olmadan dokunulmuyor, ama süreç Board'a otomatik yazılarak ilerliyor |

---

## 4. Çözüm — Otomasyon Akışı

```
[Azure Repos: PR açılır / güncellenir]  ← TETİKLEYİCİ (pipeline, insan müdahalesi yok)
        │
        ▼
1. BAĞLAM TOPLAMA (Azure DevOps MCP Server üzerinden)
   - get_work_item(id)   → PR'a linkli PBI/Task'ın açıklaması + kabul kriterleri
   - get_pr_changes(id)  → değişen dosyalar / diff
        │
        ▼
2. KOD ANALİZİ
   Agent değişen dosyalardaki validasyon/iş kuralını
   doğrudan koddan çıkarır
   (örn. "if (!iban.match(/^TR\d{24}$/)) → IBAN kuralı bulundu")
        │
        ▼
3. ÇAPRAZ KONTROL (yeni, farklılaştırıcı adım)
   Koddan çıkarılan kuralları PBI'daki kabul kriterleriyle karşılaştırır.
   Sapma varsa işaretler
   (örn. "PBI'da limit 10.000 TL yazıyor, kodda 5.000 TL kontrolü var")
        │
        ▼
4. EKRAN EŞLEME + SENARYO ÇIKARIMI
   Değişen dosyayı route'a eşler, çıkarılan kurallardan
   (happy path + her kuralın ihlal durumu) test senaryoları üretir
        │
        ▼
5. TEST VERİSİ ÜRETİMİ + SCRIPT ÇALIŞTIRMA
   Sahte veri üretir, Playwright script'ine çevirir, tarayıcıda çalıştırır
        │
        ▼
6. SONUCU AZURE DEVOPS'A OTOMATİK YAZMA (MCP ile)
   ✅ Tüm senaryolar geçti  → PR'a otomatik check/yorum:
       "UI Test Agent: 6/6 senaryo geçti, kabul kriteriyle uyumlu"
   ❌ Bir senaryo/kural sapması var → otomatik olarak:
       - Azure Boards'ta yeni bir Bug work item'ı açılır
         (repro adımları, ekran görüntüsü, ciddiyet)
       - Bug, ilgili PBI ve PR'a otomatik linklenir
       - PR'a referans yorumu düşülür
        │
        ▼
[Süreç Azure Boards/Repos üzerinden normal akışında devam eder —
 hiçbir noktada insan agent'a soru sormadı]
```

### 4.1 SDLC Sürecine Etkisi — Adım Bazlı Eşleme

| Agent Adımı | SDLC Kategorisi | Neden |
|---|---|---|
| 1. Bağlam Toplama | Destekleyici (Pre-Analysis benzeri) | Girdilerin standart şekilde toplanması |
| 2. Kod Analizi | **01 · Analysis** | Kaynak koddan davranış/kural çıkarımı |
| 3. Çapraz Kontrol | **01 · Analysis** | Gereksinim (PBI) ile gerçekleşen (kod) arasındaki tutarlılık analizi |
| 4-5. Senaryo + Test Çalıştırma | **04 · Test** (ana kategori) | Kalite kontrolü, hataların erken yakalanması |
| 6. Otomatik Board/PR Yazımı | **03 · Development** | Bug work item'ı doğrudan geliştirme sürecine (backlog'a) giren bir iş öğesi |

Ana kategori **Test**, ama akış **Analysis → Test → Development**'ı otomatik, insansız bir döngüyle kapatıyor — bu, "birden fazla SDLC aşamasına dokunan uçtan uca" kriterine güçlü şekilde uyuyor.

---

## 5. Neden Farklılaşıyor

| Genel "AI test agent" / chatbot yaklaşımı | Bu Proje |
|---|---|
| İnsan agent'a soru sorar, agent cevap verir | **Sıfır sohbet** — PR açılınca kendiliğinden çalışan bir otomasyon |
| Test senaryosu insan açıklamasına dayanır | Senaryo **doğrudan koddan** çıkarılır |
| Kabul kriteri ile kod arasındaki sapma kontrol edilmez | **PBI ↔ kod çapraz kontrolü** — sessiz gereksinim sapmalarını yakalar |
| Sonuç bir rapor/chat mesajı olarak kalır | Sonuç **doğrudan Azure Boards/Repos'a yazılır** — Bug otomatik açılır, PR'a check düşülür |
| Entegrasyon sıfırdan yazılır | **Resmi Azure DevOps MCP Server** kullanılır — "AI native" temayı teknik olarak somutlaştırır |

---

## 6. Etki Ölçümü (Kanıt Planı)

| Metrik | Nasıl Ölçülecek |
|---|---|
| PR başına test hazırlık + çalıştırma süresi | Aynı PR'ı önce elle test et (kronometre) → agent ile karşılaştır |
| Kabul kriteri sapması yakalama oranı | Bilinçli olarak PBI ile kod arasına eklenen bir tutarsızlık, agent tarafından yakalanıyor mu? |
| Bug'ın Board'a düşme süresi | Manuel bug girme süresi vs. otomatik oluşturma süresi |
| Senaryo kapsamı | Elle bulunan senaryo sayısı vs. koddan otomatik çıkarılan senaryo sayısı |

> Baseline, Hafta 1'de kendi manuel sürecinle (gerçek Azure DevOps board'unda) ölçülecek.

---

## 7. Yapım Planı

**Çekirdek geliştirme (2 hafta):**

| Hafta | Odak |
|---|---|
| 1 | Ücretsiz bir Azure DevOps organizasyonu + demo proje kurulumu (örnek PBI'lar, demo ekran, Git reposu); Azure DevOps MCP Server bağlantısının kurulup work item/PR okuma-yazmanın test edilmesi |
| 2 | Kod Analizi + Çapraz Kontrol + Senaryo/Veri Üretimi + Playwright Runner geliştirilmesi; sonucun otomatik olarak PR check/yorum ve Bug work item'ı olarak yazılmasının bağlanması |

**Yarışma takvimine göre kalan süre (Hafta 3-4):**
- Hafta 3: Birkaç farklı PR/PBI senaryosuyla pilot çalıştırma, baseline karşılaştırması
- Hafta 4: Sonuçların dokümantasyonu, final başvurusunun hazırlanması

---

## 8. Riskler ve Azaltım

| Risk | Azaltım |
|---|---|
| Azure DevOps MCP Server'ın yetenekleri (özellikle otomatik Bug oluşturma / PR yorum yazma) tam ihtiyacı karşılamayabilir | Resmi repo (microsoft/azure-devops-mcp) EXAMPLES dokümantasyonu Hafta 1'in ilk günlerinde incelenip kapsam buna göre netleştirilir; eksik bir tool varsa doğrudan Azure DevOps REST API'ye düşülür |
| Ekran eşleme (kod → route) karmaşık olabilir | Demo app kendi yazılacağı için basit bir konvansiyon kullanılır |
| PBI kabul kriterleri serbest metin, tutarsız formatta olabilir | Demo PBI'lar, gerçekçi ama standart bir şablonla (kabul kriteri listesi) kendi yazılır |
| Playwright script üretiminde LLM hatası (yanlış seçici) | Demo ekranın elementlerine test-id eklenir, hata payı azaltılır |

---

## 9. Değerlendirme Kriterlerine Uygunluk

- **İş Değeri:** Manuel test hazırlığı + bug girişi sürecini otomatikleştiriyor, ölçülebilir süre iyileşmesi sağlıyor.
- **Çözüm Kalitesi:** Gerçek bir Azure DevOps ortamında uçtan uca çalışan bir otomasyon.
- **Yapay Zekanın Katkısı:** AI soru-cevap değil — kodu analiz ediyor, kabul kriteriyle karşılaştırıyor, test ediyor, sonucu doğrudan iş sistemine (Board) yazıyor.
- **Yaygınlaştırma Potansiyeli:** Aynı otomasyon, organizasyondaki her PR/PBI için doğrudan uygulanabilir; MCP tabanlı mimari başka Azure DevOps projelerine kolayca taşınabilir.

---

## 10. Kaynaklar

- [Azure DevOps MCP Server (resmi, Microsoft)](https://github.com/microsoft/azure-devops-mcp)
- [Azure DevOps MCP Server — Genel Bakış (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/devops/mcp-server/mcp-server-overview?view=azure-devops)
- [Azure DevOps Remote MCP Server — Genel Kullanıma Açık (Devblog)](https://devblogs.microsoft.com/devops/azure-devops-remote-mcp-server-ga/)
