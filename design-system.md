# Design System — Archi Video Maker

Kaynak: `src/app/globals.css`, `src/app/page.tsx`, `src/components/chat-input.tsx`, `src/components/sidebar.tsx`, `src/app/layout.tsx`

## 1. Renk Paleti

### Marka Renkleri (`@theme` — globals.css)
| Token | Hex | Kullanım |
|---|---|---|
| `--color-brand-navy` | `#0f1d3d` | Sidebar arka planı, ana başlıklar, seçili sekme (mode toggle) |
| `--color-brand-blue` | `#1e87f0` | Birincil aksiyon rengi (CTA butonlar, aktif ikonlar, linkler) |
| `--color-brand-teal` | `#0098d8` | İkincil marka rengi (tanımlı, şu an aktif kullanım sınırlı) |
| `--color-brand-deep` | `#2c3698` | İkincil marka rengi (tanımlı, şu an aktif kullanım sınırlı) |

### Fonksiyonel Renkler
| Renk | Hex | Kullanım |
|---|---|---|
| Primary Blue | `#1e87f0` | Butonlar, aktif durumlar, ikon vurguları |
| Primary Blue (hover) | `#1a78d8` | Buton hover state'i |
| Navy | `#0f1d3d` | Sidebar bg, seçili toggle bg, başlık metni |
| Beyaz | `#ffffff` | Sayfa bg, kart bg, buton metni |

### Nötr / Slate Skalası (Tailwind slate)
| Sınıf | Hex (yaklaşık) | Kullanım |
|---|---|---|
| `slate-50` | `#f8fafc` | Hafif bg (mode toggle container, hover bg) |
| `slate-100` | `#f1f5f9` | Kullanıcı mesaj balonu bg, disabled bg, ayırıcı çizgiler |
| `slate-200` | `#e2e8f0` | Border (input, kart, buton) |
| `slate-400` | `#94a3b8` | Placeholder, ikon (pasif), yardımcı metin |
| `slate-500` | `#64748b` | Toggle pasif metin, açıklama metni |
| `slate-600` | `#475569` | İkincil buton metni |
| `slate-700` | `#334155` | Gövde metni |
| `slate-800` | `#1e293b` | Body ana metin rengi |

### Durum Renkleri (semantic)
| Durum | BG | Text/Border | Kullanım |
|---|---|---|---|
| Hata | `red-50` | `red-600` / `red-100` border | Hata mesajları |
| Uyarı | `amber-50` | `amber-800` / `amber-200` border | "Uygun olmayan içerik" kutusu |
| Bilgi/Seçili | `blue-50` (`#eff6ff`) | `#1e40af` text | Seçili öğe vurgusu (kütüphane picker) |

### Sidebar (koyu tema) — rgba beyaz katmanları (navy `#0f1d3d` üzerine)
| Opaklık | Kullanım |
|---|---|
| `rgba(255,255,255,0.06–0.08)` | İnce ayırıcı çizgiler |
| `rgba(255,255,255,0.15–0.35)` | Pasif ikon/metin |
| `rgba(255,255,255,0.65–0.8)` | Aktif/okunabilir metin |
| `rgba(30,135,240,0.15)` → `rgba(30,135,240,0.25)` (hover) | "Yeni Video" butonu (mavi tonlu, saydam) |

## 2. Tipografi

- **Font ailesi:** Plus Jakarta Sans (`next/font/google`, `--font-plus-jakarta`), `font-sans` olarak Tailwind'e bağlı.
- **Başlık (H1):** `text-2xl font-semibold`, renk `#0f1d3d` (navy)
- **Gövde metni:** `text-sm` (14px), `text-slate-700`
- **Yardımcı/açıklama metni:** `text-xs` – `text-sm`, `text-slate-400` / `text-slate-500`
- **Buton metni:** `text-sm font-medium` (bazı yerlerde `font-semibold`)
- **Etiket (label):** `text-xs font-medium text-slate-500`
- **Kategori başlığı (uppercase):** `text-[10px] font-semibold uppercase tracking-wider`

## 3. Buton Sistemi

### Primary (Solid Blue)
```
background: #1e87f0 → hover #1a78d8
color: #fff
padding: px-5 py-2 (veya px-4 py-2)
border-radius: rounded-xl (12px)
font: text-sm font-medium
transition: transition-colors
```
Kullanım: "Video Oluştur →", "İndir", gönder butonu (chat input, ikon buton `rounded-full`).

### Secondary (Outline)
```
border: 1px solid slate-200 (#e2e8f0)
color: slate-600 / slate-700
background: transparent → hover slate-50
border-radius: rounded-xl (12px)
padding: px-4 py-2
font: text-sm font-medium
```
Kullanım: "← Görselleri Değiştir", "Yeni Video" (tamamlanma ekranı).

### Toggle / Segmented Control
```
Container: rounded-xl border border-slate-200 bg-slate-50 p-1
Aktif buton: background #0f1d3d, color #fff
Pasif buton: color #64748b, background transparent
border-radius: rounded-lg (buton içi)
```

### Icon Button (ghost)
```
padding: p-2
color: slate-400 → hover slate-600
hover background: slate-100
border-radius: rounded-lg
disabled: opacity-40
```

### Disabled state
```
opacity: 30–60%
cursor: not-allowed
```

## 4. Border Radius Skalası

| Token | Değer | Kullanım |
|---|---|---|
| `rounded-lg` | 8px | İkon butonlar, toggle iç buton |
| `rounded-xl` | 12px | Standart butonlar, input, kartlar, mesaj container |
| `rounded-2xl` | 16px | Chat input dış kutusu, kullanıcı mesaj balonu, kart/panel, picker dropdown |
| `rounded-full` | 999px | Avatar (assistant ikon), gönder butonu, sayaç rozetleri |

## 5. Gölge & Kenarlık

- **Kart/panel gölgesi:** `shadow-sm` (chat input container)
- **Dropdown/popover gölgesi:** `shadow-xl` (@ kütüphane picker)
- **Standart border:** `1px solid slate-200 (#e2e8f0)`
- **İnce ayırıcı:** `slate-100 (#f1f5f9)` veya sidebar'da `rgba(255,255,255,0.06)`

## 6. Spacing & Layout

- **Sayfa yapısı:** Sol sabit sidebar (`w-60` / mobilde `w-72` drawer) + `flex-1` ana içerik
- **İçerik max-width:** `max-w-2xl` (welcome ekranı), `max-w-3xl` (chat/mesaj alanı)
- **Standart dikey boşluk (stack):** `space-y-2` → `space-y-6` (bağlama göre)
- **Buton iç boşluk:** `px-4 py-2` / `px-5 py-2` (standart), `p-2` (icon-only)
- **Input iç boşluk:** `px-4 py-2.5` / `py-3`

## 7. İkonlar

- Kütüphane: Heroicons (outline), `stroke-width` genelde `1.5–2.5`
- Boyut: `w-4 h-4` (standart), `w-3.5 h-3.5` (küçük/avatar içi), `w-8 h-8` (durum ikon dairesi)

## 8. Animasyon

- `transition-colors` / `transition-all` — standart hover geçişleri
- `animate-spin` — yükleme spinner'ları (SVG)
- `progress-indeterminate` (globals.css keyframes) — belirsiz ilerleme çubuğu
- Progress bar: `transition-all duration-700 ease-out`

## 9. Genel Tasarım Dili

- **Stil:** Temiz, minimal, "chat/asistan" arayüzü — beyaz zemin + koyu lacivert (navy) sidebar kontrastı
- **Vurgu rengi olarak tek bir canlı mavi (`#1e87f0`)** tutarlı biçimde tüm CTA'larda kullanılıyor
- **Nötr gri tonlar (slate)** metin hiyerarşisi ve arka plan katmanlaması için
- **Yuvarlatılmış köşeler her yerde baskın** (rounded-xl / rounded-2xl) — sert köşe neredeyse yok
- **Inline `style` ile hex renkler** yaygın kullanılıyor (Tailwind arbitrary yerine); marka renkleri `@theme` üzerinden tanımlı ama komponentlerde çoğunlukla ham hex (`#1e87f0`, `#0f1d3d`) olarak tekrarlanıyor — tutarlılık için ileride Tailwind token'larına (`text-brand-blue`, `bg-brand-navy`) taşınması önerilir
