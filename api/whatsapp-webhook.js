// /api/whatsapp-webhook.js
// ===============================
// Madmext WhatsApp Support Engine v3 (Production)
// - Intent scoring + typo/abbr tolerance
// - State machine (order/cargo/return/support)
// - Interactive UI (List + Buttons)
// - Smart escalation to human when user can't find info
// - Ticket creation (in-memory demo; DB ready)
// - Operator notification webhook (optional)
// ===============================

const seen = new Set();         // dedup (serverless restart -> resets)
const sessions = new Map();     // from -> { state, data, updatedAt }
const tickets = new Map();      // ticketNo -> ticket (demo, DB ready)

// ---------- Helpers ----------
function nowTs() { return Date.now(); }

function normalize(raw) {
  // TR-friendly, typo baseline
  return (raw || "")
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

function compact(s) { return (s || "").replace(/\s/g, ""); }

function containsAny(text, arr) {
  for (const k of arr) if (text.includes(k)) return true;
  return false;
}

function getSession(from) {
  return sessions.get(from) || { state: "NEW", data: {}, updatedAt: nowTs() };
}
function setSession(from, state, patch = {}) {
  const cur = getSession(from);
  sessions.set(from, {
    state,
    data: { ...(cur.data || {}), ...patch },
    updatedAt: nowTs(),
  });
}

function genTicket(prefix = "MX") {
  const n = Math.floor(10000 + Math.random() * 90000);
  return `${prefix}-${n}`;
}

function isCannotFind(t) {
  // user can't find order no / info
  return containsAny(t, [
    "bulamadim", "bulamiyorum", "bulamiyorum", "bulamiyorum",
    "bulamadım", "bulamıyorum",
    "yok", "bilmiyorum", "hatirlamiyorum", "hatırlamiyorum", "hatirlamiyorum",
    "siparis no yok", "siparis numaram yok", "siparis numarasi yok",
    "bulunmuyor", "bulamadim ya", "bulamiyorum ya",
  ]);
}

function isLiveSupportIntent(t) {
  return containsAny(t, [
    "canli destek", "canli", "temsilci", "musteri hizmetleri", "insanla konus",
    "canli baglan", "canliya bagla", "operatore baglan", "canliya aktar",
  ]);
}

// ---------- WhatsApp Message Extraction ----------
function extractInbound(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return null;

  const from = msg.from;
  const id = msg.id;

  let text = "";
  let payloadId = null;
  let payloadTitle = null;

  if (msg.type === "text") {
    text = msg.text?.body || "";
  } else if (msg.type === "interactive") {
    if (msg.interactive?.button_reply) {
      payloadId = msg.interactive.button_reply.id;
      payloadTitle = msg.interactive.button_reply.title;
      text = payloadTitle || "";
    } else if (msg.interactive?.list_reply) {
      payloadId = msg.interactive.list_reply.id;
      payloadTitle = msg.interactive.list_reply.title;
      text = payloadTitle || "";
    }
  } else if (msg.type === "button") {
    // legacy button messages
    text = msg.button?.text || "";
  }

  return { from, id, text: (text || "").trim(), payloadId, payloadTitle, raw: msg };
}

// ---------- WhatsApp Sender ----------
async function waSend(payload) {
  const token = process.env.WA_ACCESS_TOKEN;
  const phoneId = process.env.WA_PHONE_NUMBER_ID;

  if (!token || !phoneId) {
    console.log("⚠️ Missing WA_ACCESS_TOKEN or WA_PHONE_NUMBER_ID");
    return { ok: false };
  }

  const resp = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  console.log("SEND_STATUS:", resp.status, "BODY:", JSON.stringify(data));
  return { ok: resp.ok, status: resp.status, data };
}

async function sendText(to, text) {
  return waSend({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

// Buttons max 3
async function sendButtons(to, bodyText, buttons) {
  return waSend({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

// List for 4+ options
async function sendList(to, bodyText, buttonText, sections) {
  return waSend({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: { button: buttonText, sections },
    },
  });
}

// ---------- Operator Notify (optional) ----------
async function notifyOperator(payload) {
  const url = process.env.OPERATOR_WEBHOOK_URL; // optional
  if (!url) return;
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

// ---------- UX blocks ----------
function orderNoHelpText() {
  return (
    "Sipariş numaranızı şöyle bulabilirsiniz:\n\n" +
    "• Madmext.com: Hesabım → Siparişlerim → ilgili sipariş → Sipariş No\n" +
    "• Mobil Uygulama: Hesabım → Siparişlerim → ilgili sipariş → Sipariş No\n" +
    "• Pazaryeri: Uygulama → Siparişlerim → ilgili sipariş → Sipariş/Sipariş Kodu\n\n" +
    "Bulamazsanız 'bulamadım' yazın, canlı desteğe aktaralım."
  );
}

function returnFlowIntroText() {
  return "İade / Değişim için siparişinizi nereden oluşturdunuz?";
}

async function showMainMenu(from) {
  // List menu (best UX + 4 seçenek)
  return sendList(
    from,
    "Size nasıl yardımcı olabilirim?",
    "Menüyü Aç",
    [
      {
        title: "Madmext Destek",
        rows: [
          { id: "m_order", title: "Sipariş Durumu" },
          { id: "m_cargo", title: "Kargo Takibi" },
          { id: "m_return", title: "İade / Değişim" },
          { id: "m_support", title: "Şikayet / Destek" },
        ],
      },
    ]
  );
}

// ---------- Abbreviations / typo tolerance ----------
const ABBR = new Map([
  ["mrb", "merhaba"],
  ["mrhb", "merhaba"],
  ["slm", "selam"],
  ["sa", "selam"],
  ["s.a", "selam"],
  ["s a", "selam"],
  ["ii", "iyi"],
]);

function expandAbbr(t) {
  // token-based: replace common abbreviations
  const parts = (t || "").split(" ");
  const out = parts.map((p) => ABBR.get(p) || p);
  return out.join(" ");
}

// ---------- Intent Scoring Engine (config) ----------
const INTENTS = [
  { name: "menu", weight: 6, keywords: ["menu", "menü", "ana menu", "ana menü", "anamenu", "basla", "başla", "start", "yardim", "yardım", "help"] },
  { name: "greet", weight: 3, keywords: ["merhaba", "selam", "selamlar", "gunaydin", "günaydın", "iyi gunler", "iyi günler", "iyi aksamlar", "iyi akşamlar", "hello", "hi"] },
  { name: "human", weight: 6, keywords: ["canli destek", "temsilci", "musteri hizmetleri", "insanla konus", "operatore baglan", "canliya aktar"] },
  { name: "return", weight: 5, keywords: ["iade", "degisim", "değişim", "geri gonder", "geri gönder", "geri yolla", "degistir", "değiştir", "beden kucuk", "beden küçük", "beden buyuk", "beden büyük", "kusurlu", "defolu", "hasarli", "hasarlı"] },
  { name: "cargo", weight: 4, keywords: ["kargo", "kargo takip", "takip no", "takip numarasi", "kargo nerede", "kargom"] },
  { name: "order", weight: 4, keywords: ["siparis", "sipariş", "siparisim", "siparişim", "siparis durumu", "sipariş durumu", "nerede", "hazirlaniyor", "hazırlanıyor"] },
  { name: "support", weight: 3, keywords: ["sikayet", "şikayet", "problem", "sorun", "destek", "yardim edin", "yardım edin"] },
];

function detectIntent(rawNormalized) {
  if (!rawNormalized) return null;

  const t = expandAbbr(rawNormalized);
  const c = compact(t);

  let best = { name: null, score: 0 };

  for (const intent of INTENTS) {
    let s = 0;
    for (const kw of intent.keywords) {
      const k = compact(normalize(kw));
      if (!k) continue;
      if (c.includes(k)) s += intent.weight;
    }
    if (s > best.score) best = { name: intent.name, score: s };
  }

  // threshold: 4+ is confident
  if (best.score < 4) return null;
  return best.name;
}

// ---------- Main Handler ----------
export default async function handler(req, res) {
  // ---- GET verify ----
  if (req.method === "GET") {
    const mode = (req.query["hub.mode"] || "").toString();
    const token = (req.query["hub.verify_token"] || "").toString().trim();
    const challenge = req.query["hub.challenge"];
    const expected = (process.env.WA_VERIFY_TOKEN || "madmext_verify_123").toString().trim();

    if (mode !== "subscribe" || token !== expected) return res.status(403).send("Forbidden");
    return res.status(200).send(challenge);
  }

  // ---- POST events ----
  if (req.method === "POST") {
    try {
      if (req.body?.object !== "whatsapp_business_account") return res.status(200).send("EVENT_RECEIVED");

      const inbound = extractInbound(req.body);
      if (!inbound || !inbound.from) return res.status(200).send("EVENT_RECEIVED");

      // dedup
      if (inbound.id && seen.has(inbound.id)) return res.status(200).send("EVENT_RECEIVED");
      if (inbound.id) seen.add(inbound.id);

      const from = inbound.from;
      const rawText = inbound.text || "";
      const t = normalize(rawText);
      const session = getSession(from);

      console.log("FROM:", from, "STATE:", session.state, "TEXT:", t, "PAYLOAD:", inbound.payloadId);

      // ---------- HUMAN MODE ----------
      // Bot susar. Sadece menü komutu ile menü gösterilebilir (istersen kaldır).
      if (session.state === "HUMAN") {
        const intent = detectIntent(t);
        if (intent === "menu") {
          setSession(from, "MAIN_MENU");
          await showMainMenu(from);
        }
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ---------- Payload Router (Interactive) ----------
      // Main menu list ids
      if (inbound.payloadId === "m_order") {
        setSession(from, "ASK_ORDER_NO", { topic: "order", tries: 0 });
        await sendText(from, "Sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
        return res.status(200).send("EVENT_RECEIVED");
      }
      if (inbound.payloadId === "m_cargo") {
        setSession(from, "ASK_ORDER_NO", { topic: "cargo", tries: 0 });
        await sendText(from, "Kargo takibi için sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
        return res.status(200).send("EVENT_RECEIVED");
      }
      if (inbound.payloadId === "m_return") {
        setSession(from, "RETURN_SOURCE");
        await sendButtons(from, returnFlowIntroText(), [
          { id: "rs_web", title: "Madmext.com" },
          { id: "rs_app", title: "Mobil Uygulama" },
          { id: "rs_mp", title: "Pazaryeri" },
        ]);
        return res.status(200).send("EVENT_RECEIVED");
      }
      if (inbound.payloadId === "m_support") {
        setSession(from, "ASK_SUPPORT_TEXT");
        await sendText(from, "Destek talebinizi kısaca yazar mısınız? (Konu + sipariş no varsa ekleyin)");
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Return source buttons
      if (inbound.payloadId === "rs_web" || inbound.payloadId === "rs_app") {
        setSession(from, "RETURN_TYPE", {
          source: inbound.payloadId === "rs_web" ? "madmext_web" : "madmext_app",
        });
        await sendButtons(from, "İşleminiz hangisi?", [
          { id: "rt_return", title: "İade" },
          { id: "rt_exchange", title: "Değişim" },
          { id: "rt_back", title: "Ana Menü" },
        ]);
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (inbound.payloadId === "rs_mp") {
        setSession(from, "MARKETPLACE_SELECT");
        await sendList(from, "Hangi pazaryerinden sipariş verdiniz?", "Seçenekleri Gör", [
          {
            title: "Pazaryeri",
            rows: [
              { id: "mp_trendyol", title: "Trendyol" },
              { id: "mp_flo", title: "Flo" },
              { id: "mp_hb", title: "Hepsiburada" },
              { id: "mp_other", title: "Diğer" },
            ],
          },
        ]);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Marketplace list selection
      if (session.state === "MARKETPLACE_SELECT" && inbound.payloadId) {
        const platform =
          inbound.payloadId === "mp_trendyol" ? "Trendyol" :
          inbound.payloadId === "mp_flo" ? "Flo" :
          inbound.payloadId === "mp_hb" ? "Hepsiburada" :
          inbound.payloadId === "mp_other" ? "Diğer" : null;

        if (!platform) {
          await sendText(from, "Lütfen listeden bir pazaryeri seçin. (Ana menü: menü)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        setSession(from, "RETURN_TYPE", { source: "marketplace", platform });
        await sendButtons(from, `Platform: ${platform}\n\nİşleminiz hangisi?`, [
          { id: "rt_return", title: "İade" },
          { id: "rt_exchange", title: "Değişim" },
          { id: "rt_back", title: "Ana Menü" },
        ]);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Return type buttons
      if (inbound.payloadId === "rt_back") {
        setSession(from, "MAIN_MENU");
        await showMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (inbound.payloadId === "rt_return" || inbound.payloadId === "rt_exchange") {
        const rt = inbound.payloadId === "rt_return" ? "iade" : "degisim";
        const cur = getSession(from);
        setSession(from, "RETURN_ORDER_NO", { ...cur.data, returnType: rt, tries: 0 });
        await sendText(from, "Sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ---------- Global Intent (text) ----------
      // menu / live support should work from anywhere (except HUMAN handled above)
      const intent = detectIntent(t);

      if (intent === "menu") {
        setSession(from, "MAIN_MENU");
        await showMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Live support intent from free text
      if (intent === "human" || isLiveSupportIntent(t)) {
        const ticketNo = genTicket("LIVE");
        const ticket = {
          ticketNo,
          from,
          topic: "live_support",
          message: rawText,
          status: "NEW",
          createdAt: nowTs(),
        };
        tickets.set(ticketNo, ticket);

        setSession(from, "HUMAN", { ticketNo });

        await notifyOperator({
          type: "HUMAN_REQUEST",
          ticketNo,
          from,
          message: rawText,
          at: new Date().toISOString(),
        });

        await sendText(from, `Canlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // Greeting: ALWAYS show menu (best UX)
      if (intent === "greet" || containsAny(t, ["merhaba", "selam", "selamlar", "mrb", "slm", "gunaydin", "günaydın"])) {
        setSession(from, "MAIN_MENU");
        await showMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // NEW user: welcome + menu
      if (session.state === "NEW") {
        setSession(from, "MAIN_MENU");
        await sendText(from, "Merhaba 👋");
        await showMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // MAIN_MENU: if user writes free text, route by intent
      if (session.state === "MAIN_MENU") {
        if (intent === "return") {
          setSession(from, "RETURN_SOURCE");
          await sendButtons(from, returnFlowIntroText(), [
            { id: "rs_web", title: "Madmext.com" },
            { id: "rs_app", title: "Mobil Uygulama" },
            { id: "rs_mp", title: "Pazaryeri" },
          ]);
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (intent === "cargo") {
          setSession(from, "ASK_ORDER_NO", { topic: "cargo", tries: 0 });
          await sendText(from, "Kargo takibi için sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (intent === "order") {
          setSession(from, "ASK_ORDER_NO", { topic: "order", tries: 0 });
          await sendText(from, "Sipariş durumunu kontrol edebilmem için sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (intent === "support") {
          setSession(from, "ASK_SUPPORT_TEXT");
          await sendText(from, "Destek talebinizi kısaca yazar mısınız? (Konu + sipariş no varsa ekleyin)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        // Unknown -> ask user to choose menu
        await sendText(from, "Tam anlayamadım. Menüyü açıp seçim yapabilir misiniz?");
        await showMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ---------- ORDER/CARGO flow ----------
      if (session.state === "ASK_ORDER_NO") {
        const tries = Number(session.data?.tries || 0);

        if (isCannotFind(t)) {
          if (tries === 0) {
            setSession(from, "ASK_ORDER_NO", { ...session.data, tries: 1 });
            await sendText(from, orderNoHelpText());
            return res.status(200).send("EVENT_RECEIVED");
          }

          // second failure -> live support handoff
          const ticketNo = genTicket("LIVE");
          const topic = session.data?.topic || "order";
          const ticket = {
            ticketNo,
            from,
            topic: "live_support",
            reason: "OrderNo not found",
            contextTopic: topic,
            lastUserText: rawText,
            status: "NEW",
            createdAt: nowTs(),
          };
          tickets.set(ticketNo, ticket);

          setSession(from, "HUMAN", { ticketNo });

          await notifyOperator({
            type: "HUMAN_REQUEST",
            ticketNo,
            from,
            message: "Müşteri sipariş numarasını bulamıyor (2. deneme).",
            contextTopic: topic,
            lastUserText: rawText,
            at: new Date().toISOString(),
          });

          await sendText(from, `Sipariş numarasını bulamadığınızı anladım.\nCanlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (t.length < 3) {
          await sendText(from, "Sipariş numarası çok kısa görünüyor. Lütfen tekrar yazın. (Bulamıyorsanız: bulamadım)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        // Demo response, then back to menu
        setSession(from, "MAIN_MENU");
        const topicLabel = session.data?.topic === "cargo" ? "Kargo" : "Sipariş";
        await sendText(from, `${topicLabel} için sipariş numaranız alındı: ${rawText}\n\nDemo bilgi: İşlem kontrol ediliyor.`);
        await showMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ---------- RETURN flow (full ticket) ----------
      if (session.state === "RETURN_SOURCE") {
        // if user typed instead of clicking
        if (intent === "return") {
          await sendButtons(from, returnFlowIntroText(), [
            { id: "rs_web", title: "Madmext.com" },
            { id: "rs_app", title: "Mobil Uygulama" },
            { id: "rs_mp", title: "Pazaryeri" },
          ]);
          return res.status(200).send("EVENT_RECEIVED");
        }

        await sendText(from, "Lütfen seçeneklerden birini seçin. (Ana menü: menü)");
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "RETURN_TYPE") {
        // If user writes "iade"/"degisim" instead of button
        if (containsAny(t, ["iade", "degisim", "değişim"])) {
          const rt = t.includes("iade") ? "iade" : "degisim";
          setSession(from, "RETURN_ORDER_NO", { ...session.data, returnType: rt, tries: 0 });
          await sendText(from, "Sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        await sendText(from, "İşlemi seçmek için butonları kullanın. (Ana menü: menü)");
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "RETURN_ORDER_NO") {
        const tries = Number(session.data?.tries || 0);

        if (isCannotFind(t)) {
          if (tries === 0) {
            setSession(from, "RETURN_ORDER_NO", { ...session.data, tries: 1 });
            await sendText(from, orderNoHelpText());
            return res.status(200).send("EVENT_RECEIVED");
          }

          // second failure -> human
          const ticketNo = genTicket("LIVE");
          const ticket = {
            ticketNo,
            from,
            topic: "live_support",
            reason: "Return flow - OrderNo not found",
            context: session.data,
            lastUserText: rawText,
            status: "NEW",
            createdAt: nowTs(),
          };
          tickets.set(ticketNo, ticket);

          setSession(from, "HUMAN", { ticketNo });

          await notifyOperator({
            type: "HUMAN_REQUEST",
            ticketNo,
            from,
            message: "İade/Değişim akışında sipariş no bulunamadı (2. deneme).",
            context: session.data,
            lastUserText: rawText,
            at: new Date().toISOString(),
          });

          await sendText(from, `Sipariş numarasını bulamadığınızı anladım.\nCanlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (t.length < 3) {
          await sendText(from, "Sipariş numarası çok kısa görünüyor. Lütfen tekrar yazın. (Bulamıyorsanız: bulamadım)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        setSession(from, "RETURN_PRODUCT", { ...session.data, orderNo: rawText });
        await sendText(from, "Ürün kodu ve beden nedir? (örn: MG2693 / M)");
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "RETURN_PRODUCT") {
        if (t.length < 2) {
          await sendText(from, "Ürün kodu/beden bilgisini tekrar yazar mısınız? (örn: MG2693 / M)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        setSession(from, "RETURN_REASON", { ...session.data, productSize: rawText });
        await sendText(from, "İade/Değişim sebebinizi kısaca yazar mısınız? (örn: beden küçük geldi)");
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (session.state === "RETURN_REASON") {
        if (t.length < 2) {
          await sendText(from, "Sebebi kısaca yazar mısınız? (örn: beden büyük geldi / defolu geldi)");
          return res.status(200).send("EVENT_RECEIVED");
        }

        const data = session.data || {};
        const ticketNo = genTicket(data.source === "marketplace" ? "MP" : "MX");

        const ticket = {
          ticketNo,
          from,
          topic: "return",
          source: data.source,
          platform: data.platform || null,
          returnType: data.returnType,
          orderNo: data.orderNo,
          productSize: data.productSize,
          reason: rawText,
          status: "NEW",
          createdAt: nowTs(),
        };
        tickets.set(ticketNo, ticket);

        setSession(from, "MAIN_MENU");

        await sendText(
          from,
          `Talebinizi aldık ✅\nTalep No: ${ticketNo}\n\n` +
          `• İşlem: ${ticket.returnType}\n` +
          `• Sipariş: ${ticket.orderNo}\n` +
          `• Ürün/Beden: ${ticket.productSize}\n` +
          (ticket.platform ? `• Platform: ${ticket.platform}\n` : "") +
          `• Sebep: ${ticket.reason}\n\n` +
          "Ekibimiz inceleyip bu sohbet üzerinden dönüş yapacak."
        );

        await notifyOperator({ type: "NEW_TICKET", ticket, at: new Date().toISOString() });

        await showMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ---------- SUPPORT flow ----------
      if (session.state === "ASK_SUPPORT_TEXT") {
        const ticketNo = genTicket("SUP");
        const ticket = {
          ticketNo,
          from,
          topic: "support",
          message: rawText,
          status: "NEW",
          createdAt: nowTs(),
        };
        tickets.set(ticketNo, ticket);

        setSession(from, "MAIN_MENU");

        await sendText(from, `Talebinizi aldık ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden dönüş yapacak.`);
        await notifyOperator({ type: "NEW_TICKET", ticket, at: new Date().toISOString() });
        await showMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ---------- Fallback ----------
      // If we reach here, we don't know how to handle in current state.
      await sendText(from, "Tam anlayamadım. 'menü' yazabilir veya menüden seçim yapabilirsiniz.");
      await showMainMenu(from);
      return res.status(200).send("EVENT_RECEIVED");

    } catch (e) {
      console.log("WEBHOOK_ERROR:", e?.message || e);
      // always 200 to prevent retries storm
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
