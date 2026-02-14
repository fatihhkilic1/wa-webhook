// /api/whatsapp-webhook.js
// Production-ready v1: Intent Config + State Machine + Smart Escalation (HUMAN handoff)
// NOTE: Memory store (Set/Map) serverless restart'ta sıfırlanabilir. DB'ye sonra taşıyacağız.

const seen = new Set();
const userState = new Map(); // phone -> { state, data, updatedAt }
const tickets = new Map();   // ticketNo -> ticket object (demo)

function pickInboundText(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return null;

  const from = msg.from;
  const id = msg.id;

  const text =
    msg.type === "text" ? msg.text?.body :
    msg.type === "button" ? msg.button?.text :
    msg.type === "interactive"
      ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title)
      : "";

  return { from, id, text: (text || "").trim(), raw: msg };
}

// --- TR normalize (typo-friendly baseline) ---
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/[ç]/g, "c")
    .replace(/[ğ]/g, "g")
    .replace(/[ı]/g, "i")
    .replace(/[ö]/g, "o")
    .replace(/[ş]/g, "s")
    .replace(/[ü]/g, "u")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, arr) {
  for (const k of arr) if (text.includes(k)) return true;
  return false;
}

function genTicketNo(prefix = "MX") {
  const n = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}-${n}`;
}

function getMainMenu() {
  return (
    "Madmext WhatsApp Destek\n\n" +
    "Size nasıl yardımcı olalım?\n" +
    "1) Sipariş durumu\n" +
    "2) Kargo takibi\n" +
    "3) İade / Değişim\n" +
    "4) Şikayet / Destek\n\n" +
    "İsterseniz direkt yazarak da anlatabilirsiniz. (örn: 'iade istiyorum')"
  );
}

function orderNoHelpText() {
  return (
    "Sipariş numaranızı şöyle bulabilirsiniz:\n\n" +
    "• Madmext.com: Hesabım → Siparişlerim → ilgili sipariş → Sipariş No\n" +
    "• Mobil Uygulama: Hesabım → Siparişlerim → ilgili sipariş → Sipariş No\n" +
    "• Pazaryeri: Uygulama → Siparişlerim → ilgili sipariş → Sipariş/Sipariş Kodu\n\n" +
    "Bulamazsanız 'bulamadım' yazın, canlı desteğe aktaralım."
  );
}

async function sendTextMessage({ to, text }) {
  const token = process.env.WA_ACCESS_TOKEN;
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log("⚠️ Missing WA_ACCESS_TOKEN or WA_PHONE_NUMBER_ID");
    return { ok: false, error: "missing_env" };
  }

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await resp.json().catch(() => ({}));
  console.log("SEND_STATUS:", resp.status, "BODY:", JSON.stringify(data));
  return { ok: resp.ok, status: resp.status, data };
}

// Operatöre bildirim (Telegram/Slack/Panel webhook). İstersen kapat.
async function notifyOperator(payload) {
  const url = process.env.OPERATOR_WEBHOOK_URL; // örn: Telegram bot webhook / Slack webhook / kendi panel endpoint'in
  if (!url) {
    console.log("OPERATOR_WEBHOOK_URL not set; skipping notify.");
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.log("notifyOperator error:", e?.message || e);
  }
}

// ---------------- INTENT ENGINE (config-based) ----------------
const INTENTS = [
  {
    name: "menu",
    keywords: ["menu", "menü", "ana menu", "ana menü", "anamenu", "basla", "başla", "start", "yardim", "yardım", "help"],
    score: 5,
  },
  {
    name: "greeting",
    keywords: ["merhaba", "mrb", "mrhb", "selam", "slm", "selamlar", "sa", "s a", "gunaydin", "günaydın", "iyi gunler", "iyi günler", "iyi aksamlar", "iyi akşamlar", "hello", "hi"],
    score: 3,
  },
  {
    name: "human",
    keywords: ["canli destek", "canlı destek", "temsilci", "insan", "musteri hizmetleri", "müşteri hizmetleri", "canli baglan", "canlıya baglan", "canliya bagla"],
    score: 5,
  },
  {
    name: "return",
    keywords: ["iade", "degisim", "değişim", "geri gonder", "geri gönder", "geri yolla", "degistir", "değiştir", "beden kucuk", "beden küçük", "beden buyuk", "beden büyük", "kusurlu", "defolu", "hasarli", "hasarlı"],
    score: 4,
  },
  {
    name: "cargo",
    keywords: ["kargo", "kargo takip", "takip no", "takip numarasi", "kargom", "kargo nerede", "kargo geldi mi"],
    score: 3,
  },
  {
    name: "order",
    keywords: ["siparis", "sipariş", "siparisim", "siparişim", "siparis durumu", "sipariş durumu", "nerede", "hazirlaniyor", "hazırlanıyor", "iptal", "adres degis", "adres değiş"],
    score: 3,
  },
  {
    name: "complaint",
    keywords: ["sikayet", "şikayet", "magdur", "mağdur", "problem", "sorun", "destek", "yardim edin", "yardım edin"],
    score: 2,
  },
];

function detectIntent(normalizedText) {
  if (!normalizedText) return null;
  const t = normalizedText;

  let best = { name: null, score: 0 };
  for (const intent of INTENTS) {
    let s = 0;
    for (const kw of intent.keywords) {
      const nkw = normalize(kw);
      if (!nkw) continue;
      if (t.includes(nkw)) s += intent.score;
    }
    if (s > best.score) best = { name: intent.name, score: s };
  }

  // eşik: 3 altı belirsiz kabul
  if (best.score < 3) return null;
  return best.name;
}

// --------- State helpers ----------
function getSession(from) {
  return userState.get(from) || { state: "NEW", data: {}, updatedAt: Date.now() };
}
function setSession(from, state, dataPatch = {}) {
  const current = getSession(from);
  const data = { ...(current.data || {}), ...dataPatch };
  userState.set(from, { state, data, updatedAt: Date.now() });
}

// “bulamadım” / “yok” / “bilmiyorum” varyasyonları
function isCannotFind(textN) {
  return containsAny(textN, [
    "bulamadim", "bulamadım", "yok", "bilmiyorum", "hatirlamiyorum", "hatırlamıyorum",
    "siparis no yok", "siparis numaram yok", "siparis numarasi yok", "bulamiyorum", "bulamıyorum",
  ]);
}

// ---------------- Webhook ----------------
export default async function handler(req, res) {
  // GET verify
  if (req.method === "GET") {
    const mode = (req.query["hub.mode"] || "").toString();
    const token = (req.query["hub.verify_token"] || "").toString().trim();
    const challenge = req.query["hub.challenge"];
    const expected = (process.env.WA_VERIFY_TOKEN || "madmext_verify_123").toString().trim();

    if (mode !== "subscribe" || token !== expected) return res.status(403).send("Forbidden");
    return res.status(200).send(challenge);
  }

  // POST events
  if (req.method === "POST") {
    try {
      const isWhatsapp = req.body?.object === "whatsapp_business_account";
      if (!isWhatsapp) return res.status(200).send("EVENT_RECEIVED");

      const inbound = pickInboundText(req.body);
      if (!inbound || !inbound.from) return res.status(200).send("EVENT_RECEIVED");

      // dedup
      if (inbound.id && seen.has(inbound.id)) return res.status(200).send("EVENT_RECEIVED");
      if (inbound.id) seen.add(inbound.id);

      const from = inbound.from;
      const rawText = inbound.text || "";
      const t = normalize(rawText);

      const session = getSession(from);

      console.log("FROM:", from, "STATE:", session.state, "TEXT:", t);

      // HUMAN MODE: bot otomatik cevap vermesin (sadece bilgilendirme)
      if (session.state === "HUMAN") {
        // İstersen burada hiçbir şey yazma; ben çok kısa bir cümle bırakıyorum:
        await sendTextMessage({ to: from, text: "Talebiniz ekipte. Kısa süre içinde yanıt vereceğiz." });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Menü komutu her yerden
      const intent = detectIntent(t);
      if (intent === "menu") {
        setSession(from, "MAIN_MENU");
        await sendTextMessage({ to: from, text: getMainMenu() });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // İlk temas: selam veya boş/başlangıç -> "size nasıl yardımcı olabilirim?"
      if (session.state === "NEW") {
        setSession(from, "MAIN_MENU");
        await sendTextMessage({ to: from, text: "Merhaba 👋 Size nasıl yardımcı olabilirim?\n\n" + getMainMenu() });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Global “canlı destek” intent
      if (intent === "human" || containsAny(t, ["canli", "canlı", "temsilci"])) {
        const ticketNo = genTicketNo("LIVE");
        tickets.set(ticketNo, { ticketNo, from, reason: rawText, status: "NEW", createdAt: Date.now() });

        setSession(from, "HUMAN", { ticketNo });

        await notifyOperator({
          type: "HUMAN_REQUEST",
          ticketNo,
          from,
          message: rawText,
          at: new Date().toISOString(),
        });

        await sendTextMessage({
          to: from,
          text: `Canlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nBirazdan ekibimiz bu sohbet üzerinden yazacak.`,
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ----- MAIN MENU STATE (1-2-3-4 veya serbest yazı) -----
      if (session.state === "MAIN_MENU") {
        // numerik menü
        if (t === "1") {
          setSession(from, "ASK_ORDER_NO", { topic: "order" });
          await sendTextMessage({ to: from, text: "Sipariş numaranızı yazar mısınız?" });
          return res.status(200).send("EVENT_RECEIVED");
        }
        if (t === "2") {
          setSession(from, "ASK_ORDER_NO", { topic: "cargo" });
          await sendTextMessage({ to: from, text: "Kargo takibi için sipariş numaranızı yazar mısınız?" });
          return res.status(200).send("EVENT_RECEIVED");
        }
        if (t === "3") {
          setSession(from, "RETURN_SOURCE");
          await sendTextMessage({
            to: from,
            text:
              "İade / Değişim için siparişinizi nereden oluşturdunuz?\n\n" +
              "1) Madmext.com\n2) Mobil Uygulama\n3) Pazaryeri\n4) Sipariş numaramı nasıl öğrenirim?",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }
        if (t === "4") {
          setSession(from, "ASK_COMPLAINT");
          await sendTextMessage({ to: from, text: "Destek talebinizi kısaca yazar mısınız? (Konu + sipariş no varsa ekleyin)" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        // serbest yazı -> intent ile akıllı yönlendirme
        if (intent === "greeting") {
          await sendTextMessage({ to: from, text: "Merhaba 👋 Size nasıl yardımcı olabilirim?\n\n" + getMainMenu() });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (intent === "return") {
          setSession(from, "RETURN_SOURCE");
          await sendTextMessage({
            to: from,
            text:
              "İade / Değişim için siparişinizi nereden oluşturdunuz?\n\n" +
              "1) Madmext.com\n2) Mobil Uygulama\n3) Pazaryeri\n4) Sipariş numaramı nasıl öğrenirim?",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (intent === "cargo") {
          setSession(from, "ASK_ORDER_NO", { topic: "cargo" });
          await sendTextMessage({ to: from, text: "Kargo takibi için sipariş numaranızı yazar mısınız?" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (intent === "order") {
          setSession(from, "ASK_ORDER_NO", { topic: "order" });
          await sendTextMessage({ to: from, text: "Sipariş durumunu kontrol edebilmem için sipariş numaranızı yazar mısınız?" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (intent === "complaint") {
          setSession(from, "ASK_COMPLAINT");
          await sendTextMessage({ to: from, text: "Destek konunuzu kısaca yazar mısınız? (Sipariş no varsa ekleyin)" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        await sendTextMessage({ to: from, text: "Tam anlayamadım. İsterseniz menüden seçim yapın ya da kısaca yazın.\n\n" + getMainMenu() });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ----- ASK_ORDER_NO -----
      if (session.state === "ASK_ORDER_NO") {
        if (isCannotFind(t)) {
          // 1) nasıl bulunur anlat
          setSession(from, "ORDER_NO_HELP", { helpCount: (session.data.helpCount || 0) + 1 });
          await sendTextMessage({ to: from, text: orderNoHelpText() });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (t.length < 3) {
          await sendTextMessage({ to: from, text: "Sipariş numarası çok kısa görünüyor. Lütfen tekrar yazın. (Bulamıyorsanız: bulamadım)" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        // demo cevap
        setSession(from, "MAIN_MENU");
        await sendTextMessage({
          to: from,
          text:
            `Sipariş numaranız alındı: ${rawText}\n\n` +
            "Demo bilgi: Siparişiniz hazırlanıyor.\n\n" +
            "Başka bir konuda yardımcı olmamı ister misiniz?\n\n" +
            getMainMenu(),
        });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ----- ORDER_NO_HELP (müşteri hala bulamıyor -> canlı destek) -----
      if (session.state === "ORDER_NO_HELP") {
        // müşteri yine bulamadım / yok derse -> HUMAN handoff
        if (isCannotFind(t) || containsAny(t, ["olmadi", "olmadı", "bulamiyorum", "bulamıyorum", "yok"])) {
          const ticketNo = genTicketNo("LIVE");
          tickets.set(ticketNo, {
            ticketNo,
            from,
            reason: "OrderNo not found",
            lastMessage: rawText,
            status: "NEW",
            createdAt: Date.now(),
          });

          setSession(from, "HUMAN", { ticketNo });

          await notifyOperator({
            type: "HUMAN_REQUEST",
            ticketNo,
            from,
            message: "Müşteri sipariş numarasını bulamıyor. Canlı destek istiyor.",
            lastUserText: rawText,
            at: new Date().toISOString(),
          });

          await sendTextMessage({
            to: from,
            text: `Sipariş numarasını bulamadığınızı anladım.\nCanlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`,
          });

          return res.status(200).send("EVENT_RECEIVED");
        }

        // müşteri sipariş no gönderdiyse ASK_ORDER_NO'ya geri
        if (t.length >= 3) {
          setSession(from, "ASK_ORDER_NO", { topic: session.data.topic || "order" });
          await sendTextMessage({ to: from, text: "Teşekkürler. Sipariş numaranızı aldım, kontrol ediyorum." });
          // demo cevap:
          setSession(from, "MAIN_MENU");
          await sendTextMessage({ to: from, text: "Demo bilgi: Siparişiniz hazırlanıyor.\n\n" + getMainMenu() });
          return res.status(200).send("EVENT_RECEIVED");
        }

        await sendTextMessage({ to: from, text: "Sipariş numarasını yazabilir misiniz? Bulamıyorsanız 'bulamadım' yazın, canlı desteğe aktaralım." });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ----- RETURN SOURCE (iade/değişim) -----
      if (session.state === "RETURN_SOURCE") {
        if (t === "4" || containsAny(t, ["siparis numarami nasil", "siparis no nasil", "siparis numarasi nasil"])) {
          setSession(from, "ORDER_NO_HELP", { topic: "return" });
          await sendTextMessage({ to: from, text: orderNoHelpText() });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (t === "1" || t === "2") {
          setSession(from, "RETURN_TYPE", { source: t === "1" ? "madmext_web" : "madmext_app" });
          await sendTextMessage({ to: from, text: "İşleminiz hangisi?\n1) İade\n2) Değişim" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (t === "3") {
          setSession(from, "MARKETPLACE_SELECT");
          await sendTextMessage({ to: from, text: "Hangi pazaryerinden sipariş verdiniz?\n1) Trendyol\n2) Flo\n3) Hepsiburada\n4) Diğer" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        await sendTextMessage({ to: from, text: "Lütfen 1-2-3-4 seçeneklerinden birini yazın. (Ana menü: menü)" });
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "MARKETPLACE_SELECT") {
        const platform =
          t === "1" ? "Trendyol" :
          t === "2" ? "Flo" :
          t === "3" ? "Hepsiburada" :
          t === "4" ? "Diger" : null;

        if (!platform) {
          await sendTextMessage({ to: from, text: "Lütfen 1-2-3-4 seçin." });
          return res.status(200).send("EVENT_RECEIVED");
        }

        setSession(from, "RETURN_TYPE", { source: "marketplace", platform });
        await sendTextMessage({ to: from, text: `Tamam. Platform: ${platform}\n\nİşleminiz hangisi?\n1) İade\n2) Değişim` });
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "RETURN_TYPE") {
        if (t !== "1" && t !== "2") {
          await sendTextMessage({ to: from, text: "Lütfen 1) İade veya 2) Değişim yazın." });
          return res.status(200).send("EVENT_RECEIVED");
        }

        const type = t === "1" ? "iade" : "degisim";
        setSession(from, "RETURN_ORDER_NO", { returnType: type });

        await sendTextMessage({ to: from, text: "Sipariş numaranızı yazar mısınız? (Bulamıyorsanız: bulamadım)" });
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "RETURN_ORDER_NO") {
        if (isCannotFind(t)) {
          setSession(from, "ORDER_NO_HELP", { topic: "return" });
          await sendTextMessage({ to: from, text: orderNoHelpText() });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (t.length < 3) {
          await sendTextMessage({ to: from, text: "Sipariş numarası çok kısa görünüyor. Lütfen tekrar yazın. (Bulamıyorsanız: bulamadım)" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        setSession(from, "RETURN_PRODUCT", { orderNo: rawText });
        await sendTextMessage({ to: from, text: "Ürün kodu ve beden nedir? (örn: MG2693 / M)" });
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "RETURN_PRODUCT") {
        if (t.length < 2) {
          await sendTextMessage({ to: from, text: "Ürün kodu/beden bilgisini tekrar yazar mısınız? (örn: MG2693 / M)" });
          return res.status(200).send("EVENT_RECEIVED");
        }
        setSession(from, "RETURN_REASON", { productSize: rawText });
        await sendTextMessage({ to: from, text: "İade/Değişim sebebinizi kısaca yazar mısınız? (örn: beden büyük geldi)" });
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "RETURN_REASON") {
        const s = getSession(from);
        const ticketNo = genTicketNo(s.data.source === "marketplace" ? "MP" : "MX");

        const ticket = {
          ticketNo,
          from,
          topic: "return",
          source: s.data.source,
          platform: s.data.platform || null,
          returnType: s.data.returnType,
          orderNo: s.data.orderNo,
          productSize: s.data.productSize,
          reason: rawText,
          status: "NEW",
          createdAt: Date.now(),
        };
        tickets.set(ticketNo, ticket);

        setSession(from, "MAIN_MENU");

        await sendTextMessage({
          to: from,
          text:
            `Talebinizi aldık ✅\nTalep No: ${ticketNo}\n\n` +
            `• İşlem: ${ticket.returnType}\n` +
            `• Sipariş: ${ticket.orderNo}\n` +
            `• Ürün/Beden: ${ticket.productSize}\n` +
            (ticket.platform ? `• Platform: ${ticket.platform}\n` : "") +
            `• Sebep: ${ticket.reason}\n\n` +
            "Ekibimiz inceleyip bu sohbet üzerinden dönüş yapacak.\n\n" +
            getMainMenu(),
        });

        // Operatöre bilgi (isteğe bağlı)
        await notifyOperator({
          type: "NEW_TICKET",
          ticket,
          at: new Date().toISOString(),
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ----- Complaint -----
      if (session.state === "ASK_COMPLAINT") {
        const ticketNo = genTicketNo("SUP");
        const ticket = { ticketNo, from, topic: "support", message: rawText, status: "NEW", createdAt: Date.now() };
        tickets.set(ticketNo, ticket);

        setSession(from, "MAIN_MENU");

        await sendTextMessage({
          to: from,
          text: `Talebinizi aldık ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden dönüş yapacak.\n\n` + getMainMenu(),
        });

        await notifyOperator({ type: "NEW_TICKET", ticket, at: new Date().toISOString() });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Fallback
      await sendTextMessage({ to: from, text: "Tam anlayamadım. 'menü' yazabilir veya kısaca anlatabilirsiniz." });
      return res.status(200).send("EVENT_RECEIVED");

    } catch (e) {
      console.log("WEBHOOK_ERROR:", e?.message || e);
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
