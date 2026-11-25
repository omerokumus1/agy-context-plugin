# Antigravity Context Window — Türkçe Rehber

**Google Antigravity Desktop** için sıfır harici bağımlılığa sahip, açık kaynak (MIT) **Context Window** sidecar eklentisi.

Antigravity'nin kendi `sidecar_sdk`, Language Server Connect-RPC ve `node:sqlite` protobuf okuyucusunu kullanarak sohbet sırasında context doluluk oranını, prompt cache verimliliğini, tur bazlı zaman çizelgesini ve en çok token tüketen araç adımlarını canlı gösterir — **refresh başına 0 ekstra LLM token harcar**.

---

## Özellikler

- **Canlı Doluluk Göstergesi (`%` + Segmentli Bar):**
  - **Cache** (mavi) + **Uncached** (yeşil) + **Free** dağılımı.
  - Sağ üstten tıklanabilir limit seçici: `Auto (model)`, `128K`, `200K`, `256K`, `512K`, `1M`, `2M`.
- **Konuşma Değiştirici:** Üst başlıktan aktif konuşmayı otomatik takip edebilir veya geçmiş konuşmalar arasında geçiş yapabilirsin.
- **3'lü Özet Kartları:**
  - **Cache Hit:** Son turun önbellek isabet oranı (üzerine gelince oturum ortalamasını gösterir).
  - **Output:** Toplam üretilen output tokenı (response + thinking dağılımı tooltip'te).
  - **Activity:** Toplam tur, araç çağrısı ve oturum süresi.
- **Etkileşimli Timeline Grafiği:** `#1` – `#N` arası turlarda toplam context ve cache eğrilerini (compaction/temizleme düşüşleri dahil) gösterir; fareyle üzerine gelince tur detayını verir.
- **Top Spikes (Top 5):** Context'i en çok büyüten 5 adımı (`+Δ`) ilgili araç (`read_file`, `write_file`, `edit_file`, `2 tools`) ve dosya adıyla listeler. Satıra tıklayınca grafikte o tur vurgulanır.
- **Çift Görünüm:**
  - **Sağ Panel (`AUX_PANE` — `Context` sekmesi):** Sağ üst **Toggle Panel** butonuyla açılıp kapanır.
  - **Tam Ekran (`SIDEBAR` — `Context Window`):** Sol menüde **Plugins → Context Window** altından açılır ve ek olarak **Turn Ledger** (tüm turların tablosu) sunar.

---

## Kurulum (Mac / Linux / Windows)

### 1. Proje Klasöründen Tek Komutla Kurulum

```bash
cd /Users/omerokumus/Documents/Projects/agy-context-plugin
node scripts/install.mjs
```

Bu komut:
1. Eklentiyi `~/.gemini/config/plugins/agy-context-plugin/` (Windows'ta `%USERPROFILE%\.gemini\config\plugins\agy-context-plugin\`) altına kopyalar.
2. `~/.gemini/config/config.json` içinde `"agy-context-plugin/context_window": { "enabled": true }` ayarını aktif eder.

Sadece tek bir projeye kurmak için (`.agents/plugins/agy-context-plugin/`):

```bash
node scripts/install.mjs --workspace
```

### 2. GitHub Üzerinden Tek Komutla Kurulum (`agy` CLI)

Repo GitHub'da **Public** olduğunda (veya erişim yetkisi olan kişiler için):

```bash
agy plugin install https://github.com/omerokumus1/agy-context-plugin
```

### 3. Antigravity Desktop İçinden Açma

1. Sol menüden **Customizations → Installed** bölümünü aç.
2. **Context Window** eklentisinin ve altındaki **Context Window** sidecar'ının **Enabled** olduğundan emin ol (yeni kurduysan bir kez Off → On yapabilirsin).
3. Sağ üstteki **Toggle Panel** düğmesine basıp **Context** sekmesini aç veya sol menüden **Plugins → Context Window**'a tıkla.
4. Sohbet içinden hızlı açmak için `/context-window` yazabilirsin.

---

## Yararlı Komutlar

```bash
# Birim ve entegrasyon testlerini çalıştır (Node 22+ yerleşik test runner)
npm test

# Gerçekçi demo verisiyle tarayıcıda önizle (http://127.0.0.1:17840)
npm run demo

# Kurulum durumunu kontrol et
node scripts/install.mjs --status

# Eklentiyi kaldır
node scripts/install.mjs --uninstall
```

---

## Tasarımı Özelleştirme

Tüm arayüz tek bir dosyadadır: [`sidecars/context_window/ui.html`](../sidecars/context_window/ui.html).

- Renkleri değiştirmek için `:root` altındaki `--cw-blue`, `--cw-teal`, `--cw-green`, `--cw-bg`, `--cw-surface` değişkenlerini düzenle.
- Yeniden build gerekmez; paneli kapatıp tekrar açtığında değişiklikler anında görünür.
- Yeni bir model limiti eklemek için [`sidecars/context_window/lib/rpc.mjs`](../sidecars/context_window/lib/rpc.mjs) içindeki `MODEL_LIMIT_FALLBACKS` tablosunu güncelleyebilirsin.

---

## Sorun Giderme

- **Panelde "Waiting for Antigravity session data" yazıyorsa:** Aktif bir sohbet açıp en az 1 mesaj gönder, ardından sağ üstteki yenile (`↻`) ikonuna bas.
- **Değişiklikler görünmüyorsa:** `ui.html` değişiklikleri paneli kapatıp açınca gelir; `main.mjs` veya `lib/*.mjs` değişiklikleri için **Customizations → Installed** içinden eklentiyi **Disable → Enable** yap.
- **Limit yanlış görünüyorsa:** Sağ üstteki `178K / 1M ▾` menüsünden istediğin tavanı seç; seçim `${ANTIGRAVITY_EXECUTABLE_DATA_DIR}/prefs.json` dosyasına kaydedilir.
