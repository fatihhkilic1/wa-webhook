// ===============================
// MADMEXT WHATSAPP SUPPORT ENGINE v7 (Robust)
// - Works with BOTH: interactive payloads AND typed text
// - Full Return/Exchange flow + Marketplace routing
// - Refund complaint auto-ticket
// - WAITING_AGENT handles "ne zaman / kimse yok mu" properly
// - HARD HUMAN LOCK (bot silent) except "menü"
// - Anti-spam menu (cooldown)
// ===============================

const seen = new Set();           // dedup (serverless reset => resets)
const sessions = new Map();       // from -> {state,data,lastBotAt,lastMenuAt}
const tickets = new Map();        // demo in-memory tickets

// ---------- Basics ----------
function now() { return Date.now(); }

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[ç]/g, "c")
    .replace(/[ğ]/g, "g")
    .replace(/[ı]/g, "i")
    .replace(/[ö]/g, "o")
    .replace(/[ş]/g, "s")
    .replace(/[ü]/g, "u")
    .replace(/[“”"']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(t, arr) {
  return arr.some((k) => t.includes(k));
}

function getSession(from) {
  return (
    sessions.get(from) || {
      state: "NEW",
      data: {},
      lastBotAt: 0,
      lastMenuAt: 0,
    }
  );
}

function setSession(from, state, patch = {}) {
  const cur = getSession(from);
  const next = {
    ...cur,
    state,
    data: { ...(cur.data || {}), ...(patch.data || {}), ...patch },
  };
  // patch.data merged already; remove duplicated key if any
  if (next.data?.data) delete next.data.data;
  sessions.set(from, next);
  return next;
}

function updateSession(from, patch = {}) {
  const cur = getSession(from);
  const next = { ...cur, ...patch, data: { ...(cur.data || {}), ...(patch.data || {}) } };
  sessions.set(from, next);
  return next;
}

function ticketNo(prefix) {
  return `${prefix}-${Math.floor(10000 + Math.random() * 90000)}`;
}

// ---------- Extract inbound ----------
function extractInbound(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return null;

  const from = msg.from;
  const id = msg.id;

  let text = "";
  let payloadId = null;

  if (msg.type === "text") {
    text = msg.text?.body || "";
  } else if (msg.type === "interactive") {
    if (msg.interactive?.button_reply) {
      text = msg.interactive.button_reply.title || "";
      payloadId = msg.interactive.button_reply.id || null;
    } else if (msg.interactive?.list_reply) {
      text = msg.interactive.list_reply.title || "";
      payloadId = msg.interactive.list_reply.id || null;
    }
  } else if (msg.type === "button") {
    text = msg.button?.text || "";
  }

  return { from, id, text: (text || "").trim(), payloadId, raw: msg };
}

// ---------- WhatsApp send ----------
async function waSend(payload) {
  const token = process.env.WA_ACCESS_TOKEN;
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.log("⚠️ Missing WA_ACCESS_TOKEN or WA_PHONE_NUMBER_ID");
    return;
  }

  const resp = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  console.log("SEND:", resp.status, JSON.stringify(data));
}

async function sendText(to, body) {
  return waSend({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

async function sendButtons(to, body, buttons) {
  // WhatsApp buttons max 3
  return waSend({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

async function sendList(to, body, buttonText, sections) {
  return waSend({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: { button: buttonText, sections },
    },
  });
}

// ---------- Optional operator notify ----------
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

// ---------- UX helpers ----------
function isMenuCmd(t) {
  return containsAny(t, ["menu", "menü", "ana menu", "ana menü", "basla", "başla", "start", "yardim", "yardım", "help"]);
}

function isGreeting(t) {
  return containsAny(t, ["merhaba", "mrb", "mrhb", "selam", "slm", "selamlar", "gunaydin", "günaydın", "iyi gunler", "iyi günler"]);
}

function isLiveSupport(t) {
  return containsAny(t, [
    "canli destek", "canlı destek", "musteri hizmetleri", "müşteri hizmetleri",
    "temsilci", "operatore bagla", "operatöre bağla", "insanla konus", "canliya aktar",
  ]);
}

function isWhenQuestion(t) {
  return containsAny(t, ["ne zaman", "kac dk", "kaç dk", "kimse yok", "cevap", "ne kadar sure", "ne kadar süre"]);
}

function isRefundComplaint(t) {
  return containsAny(t, [
    "para iadesi", "ucret iadesi", "ücret iadesi", "geri odeme", "geri ödeme",
    "refund", "iade yatmadi", "iade yatmadı", "para iadem", "para iademi",
    "para iadesi yapilmadi", "para iadesi yapılmadı",
  ]);
}

function isReturnIntent(t) {
  // iade/değişim intent
  return containsAny(t, [
    "iade", "degisim", "değişim", "degistir", "değiştir", "beden kucuk", "beden küçük", "beden buyuk", "beden büyük",
    "kucuk geldi", "küçük geldi", "buyuk geldi", "büyük geldi", "defolu", "kusurlu", "hasarli", "hasarlı",
  ]);
}

function isOrderIntent(t) {
  return containsAny(t, ["siparis", "sipariş", "siparis durumu", "sipariş durumu", "siparisim", "siparişim", "siparis nerede", "sipariş nerede"]);
}

function isCargoIntent(t) {
  return containsAny(t, ["kargo", "kargom", "kargo takip", "takip no", "takip numarasi", "takip numarası", "kargo nerede"]);
}

function isSupportIntent(t) {
  return containsAny(t, ["sikayet", "şikayet", "destek", "problem", "sorun", "yardim", "yardım"]);
}

function isCannotFindOrderNo(t) {
  return containsAny(t, ["bulamadim", "bulamadım", "bulamiyorum", "bulamıyorum", "bilmiyorum", "yok", "hatirlamiyorum", "hatırlamıyorum", "bulunmuyor"]);
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

async function showMainMenu(from, force = false) {
  const s = getSession(from);
  const cooldownMs = 8000; // 8 sn içinde menüyü tekrar basma
  if (!force && now() - (s.lastMenuAt || 0) < cooldownMs) {
    return; // spam önleme
  }
  updateSession(from, { lastMenuAt: now(), lastBotAt: now() });

  return sendList(from, "Size nasıl yardımcı olabilirim?", "Menüyü Aç", [
    {
      title: "Madmext Destek",
      rows: [
        { id: "m_order", title: "Sipariş Durumu" },
        { id: "m_cargo", title: "Kargo Takibi" },
        { id: "m_return", title: "İade / Değişim" },
        { id: "m_support", title: "Şikayet / Destek" },
      ],
    },
  ]);
}

// Typed text equivalents for menu choices
function typedMenuChoice(t) {
  if (t === "siparis durumu" || t === "sipariş durumu" || t === "siparis" || t === "sipariş") return "m_order";
  if (t === "kargo takibi" || t === "kargo" || t === "kargo takip") return "m_cargo";
  if (t === "iade / degisim" || t === "iade degisim" || t === "iade" || t === "degisim" || t === "değişim") return "m_return";
  if (t === "sikayet / destek" || t === "şikayet / destek" || t === "sikayet" || t === "şikayet" || t === "destek") return "m_support";
  return null;
}

// Typed equivalents for return source
function typedReturnSource(t) {
  if (t === "madmextcom" || t === "madmext.com" || t === "madmext") return "rs_web";
  if (t === "mobil uygulama" || t === "uygulama" || t === "app") return "rs_app";
  if (t === "pazaryeri" || t === "pazar yeri" || t === "marketplace") return "rs_mp";
  return null;
}

// Typed equivalents for marketplaces
function typedMarketplace(t) {
  if (t.includes("trendyol")) return "mp_trendyol";
  if (t.includes("flo")) return "mp_flo";
  if (t.includes("hepsiburada") || t.includes("hb")) return "mp_hb";
  if (t.includes("diger") || t.includes("diğer") || t.includes("other")) return "mp_other";
  return null;
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  // Verify
  if (req.method === "GET") {
    const mode = (req.query["hub.mode"] || "").toString();
    const token = (req.query["hub.verify_token"] || "").toString().trim();
    const challenge = req.query["hub.challenge"];
    const expected = (process.env.WA_VERIFY_TOKEN || "madmext_verify_123").toString().trim();

    if (mode !== "subscribe" || token !== expected) return res.status(403).send("Forbidden");
    return res.status(200).send(challenge);
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    if (req.body?.object !== "whatsapp_business_account") return res.status(200).send("OK");

    const inbound = extractInbound(req.body);
    if (!inbound) return res.status(200).send("OK");

    // dedup
    if (seen.has(inbound.id)) return res.status(200).send("OK");
    seen.add(inbound.id);

    const from = inbound.from;
    const rawText = inbound.text || "";
    const t = normalize(rawText);
    const pid = inbound.payloadId;
    const s = getSession(from);

    console.log("IN:", { from, state: s.state, t, pid });

    // --------------------
    // HARD HUMAN LOCK
    // --------------------
    if (s.state === "HUMAN") {
      if (isMenuCmd(t)) {
        setSession(from, "MAIN_MENU", {});
        await showMainMenu(from, true);
      }
      return res.status(200).send("OK");
    }

    // --------------------
    // Global: menu / greet / live support
    // --------------------
    if (isMenuCmd(t)) {
      setSession(from, "MAIN_MENU", {});
      await showMainMenu(from, true);
      return res.status(200).send("OK");
    }

    if (isLiveSupport(t)) {
      const liveNo = ticketNo("LIVE");
      tickets.set(liveNo, { ticketNo: liveNo, from, topic: "live_support", message: rawText, status: "NEW", createdAt: now() });
      setSession(from, "HUMAN", { ticketNo: liveNo });

      await notifyOperator({ type: "HUMAN_REQUEST", ticketNo: liveNo, from, message: rawText, at: new Date().toISOString() });
      await sendText(from, `Canlı desteğe aktardım ✅\nTalep No: ${liveNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
      return res.status(200).send("OK");
    }

    // NEW user
    if (s.state === "NEW") {
      setSession(from, "MAIN_MENU", {});
      await sendText(from, "Merhaba 👋");
      await showMainMenu(from, true);
      return res.status(200).send("OK");
    }

    // Greeting (anti-spam)
    if (isGreeting(t)) {
      setSession(from, "MAIN_MENU", {});
      await showMainMenu(from, false); // cooldown applies
      return res.status(200).send("OK");
    }

    // --------------------
    // Payload router FIRST
    // --------------------
    // Main menu selections
    if (pid === "m_order" || pid === "m_cargo" || pid === "m_return" || pid === "m_support") {
      // fallthrough to switch below
    } else {
      // typed equivalents for menu items
      const typed = typedMenuChoice(t);
      if (typed) {
        // mimic payload
        return await handleMenuChoice(from, typed, rawText, res);
      }
    }

    if (pid) {
      // handle any payload centrally
      return await handlePayload(from, pid, rawText, t, res);
    }

    // --------------------
    // State machine (text-driven)
    // --------------------
    // If user writes free text in MAIN_MENU, route by intent
    if (s.state === "MAIN_MENU") {
      if (isRefundComplaint(t)) {
        return await createSupportTicket(from, rawText, "refund_complaint", res);
      }
      if (isReturnIntent(t)) {
        setSession(from, "RETURN_SOURCE", {});
        await sendButtons(from, "Siparişinizi nereden oluşturdunuz?", [
          { id: "rs_web", title: "Madmext.com" },
          { id: "rs_app", title: "Mobil Uygulama" },
          { id: "rs_mp", title: "Pazaryeri" },
        ]);
        return res.status(200).send("OK");
      }
      if (isCargoIntent(t)) {
        setSession(from, "ASK_ORDER_NO", { topic: "cargo", tries: 0 });
        await sendText(from, "Kargo takibi için sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
        return res.status(200).send("OK");
      }
      if (isOrderIntent(t)) {
        setSession(from, "ASK_ORDER_NO", { topic: "order", tries: 0 });
        await sendText(from, "Sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
        return res.status(200).send("OK");
      }
      if (isSupportIntent(t)) {
        setSession(from, "ASK_SUPPORT_TEXT", {});
        await sendText(from, "Destek talebinizi kısaca yazar mısınız? (Konu + sipariş no varsa ekleyin)");
        return res.status(200).send("OK");
      }

      // unknown => show menu once
      await showMainMenu(from, false);
      return res.status(200).send("OK");
    }

    // RETURN_SOURCE: accept typed source too
    if (s.state === "RETURN_SOURCE") {
      const src = typedReturnSource(t);
      if (src) return await handlePayload(from, src, rawText, t, res);

      await sendText(from, "Lütfen sipariş kaynağını seçin: Madmext.com / Mobil Uygulama / Pazaryeri (Ana menü: menü)");
      return res.status(200).send("OK");
    }

    // MARKETPLACE_SELECT: accept typed marketplace too
    if (s.state === "MARKETPLACE_SELECT") {
      const mp = typedMarketplace(t);
      if (mp) return await handlePayload(from, mp, rawText, t, res);

      await sendText(from, "Lütfen pazaryerini seçin: Trendyol / Flo / Hepsiburada / Diğer (Ana menü: menü)");
      return res.status(200).send("OK");
    }

    // RETURN_TYPE: accept typed iade/degisim too
    if (s.state === "RETURN_TYPE") {
      if (t === "iade" || t.includes("iade")) return await handlePayload(from, "rt_iade", rawText, t, res);
      if (t.includes("degisim") || t.includes("değişim")) return await handlePayload(from, "rt_degisim", rawText, t, res);
      await sendText(from, "İşleminizi yazabilirsiniz: 'iade' veya 'değişim'. (Ana menü: menü)");
      return res.status(200).send("OK");
    }

    // ASK_ORDER_NO
    if (s.state === "ASK_ORDER_NO") {
      return await handleAskOrderNo(from, rawText, t, res);
    }

    // RETURN_ORDER_NO
    if (s.state === "RETURN_ORDER_NO") {
      return await handleReturnOrderNo(from, rawText, t, res);
    }

    // RETURN_PRODUCT
    if (s.state === "RETURN_PRODUCT") {
      if (t.length < 2) {
        await sendText(from, "Ürün kodu ve bedeni tekrar yazar mısınız? (örn: MG2693 / M)");
        return res.status(200).send("OK");
      }
      setSession(from, "RETURN_REASON", { productSize: rawText });
      await sendText(from, "İade/Değişim sebebinizi kısaca yazar mısınız? (örn: beden küçük geldi)");
      return res.status(200).send("OK");
    }

    // RETURN_REASON -> ticket
    if (s.state === "RETURN_REASON") {
      if (t.length < 2) {
        await sendText(from, "Sebebi kısaca yazar mısınız? (örn: beden büyük geldi / defolu geldi)");
        return res.status(200).send("OK");
      }
      return await finalizeReturnTicket(from, rawText, res);
    }

    // ASK_SUPPORT_TEXT -> ticket
    if (s.state === "ASK_SUPPORT_TEXT") {
      return await createSupportTicket(from, rawText, "support", res);
    }

    // WAITING_AGENT
    if (s.state === "WAITING_AGENT") {
      if (isWhenQuestion(t)) {
        await sendText(from, "Yoğunluğa göre değişebilir. Genelde 5–15 dk içinde dönüş olur. İsterseniz canlı desteğe bağlanabilirsiniz.");
        await sendButtons(from, "Ne yapmak istersiniz?", [
          { id: "go_live", title: "Canlı Destek" },
          { id: "back_menu", title: "Ana Menü" },
          { id: "noop", title: "Bekleyeceğim" },
        ]);
        return res.status(200).send("OK");
      }
      await sendText(from, "Talebiniz sırada. Ekibimiz bu sohbet üzerinden dönüş yapacak. (Canlı destek için: canlı destek)");
      return res.status(200).send("OK");
    }

    // Default: show menu
    setSession(from, "MAIN_MENU", {});
    await showMainMenu(from, false);
    return res.status(200).send("OK");
  } catch (e) {
    console.log("WEBHOOK_ERROR:", e?.message || e);
    return res.status(200).send("OK");
  }
}

// ===============================
// Central handlers
// ===============================

async function handleMenuChoice(from, choiceId, rawText, res) {
  if (choiceId === "m_order") {
    setSession(from, "ASK_ORDER_NO", { topic: "order", tries: 0 });
    await sendText(from, "Sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
    return res.status(200).send("OK");
  }
  if (choiceId === "m_cargo") {
    setSession(from, "ASK_ORDER_NO", { topic: "cargo", tries: 0 });
    await sendText(from, "Kargo takibi için sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
    return res.status(200).send("OK");
  }
  if (choiceId === "m_return") {
    setSession(from, "RETURN_SOURCE", {});
    await sendButtons(from, "Siparişinizi nereden oluşturdunuz?", [
      { id: "rs_web", title: "Madmext.com" },
      { id: "rs_app", title: "Mobil Uygulama" },
      { id: "rs_mp", title: "Pazaryeri" },
    ]);
    return res.status(200).send("OK");
  }
  if (choiceId === "m_support") {
    setSession(from, "ASK_SUPPORT_TEXT", {});
    await sendText(from, "Destek talebinizi kısaca yazar mısınız? (Konu + sipariş no varsa ekleyin)");
    return res.status(200).send("OK");
  }
  await showMainMenu(from, false);
  return res.status(200).send("OK");
}

async function handlePayload(from, pid, rawText, t, res) {
  const s = getSession(from);

  // Main menu list
  if (pid === "m_order" || pid === "m_cargo" || pid === "m_return" || pid === "m_support") {
    return handleMenuChoice(from, pid, rawText, res);
  }

  // Waiting agent buttons
  if (pid === "go_live") {
    const liveNo = ticketNo("LIVE");
    tickets.set(liveNo, { ticketNo: liveNo, from, topic: "live_support", message: "User pressed live button", status: "NEW", createdAt: now() });
    setSession(from, "HUMAN", { ticketNo: liveNo });

    await notifyOperator({ type: "HUMAN_REQUEST", ticketNo: liveNo, from, at: new Date().toISOString() });
    await sendText(from, `Canlı desteğe aktardım ✅\nTalep No: ${liveNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
    return res.status(200).send("OK");
  }
  if (pid === "back_menu") {
    setSession(from, "MAIN_MENU", {});
    await showMainMenu(from, true);
    return res.status(200).send("OK");
  }
  if (pid === "noop") {
    // IMPORTANT: do not reset to NEW or greet
    setSession(from, "WAITING_AGENT", s.data || {});
    await sendText(from, "Tamam. Ekibimiz dönüş yapınca bu sohbetten yazacak.");
    return res.status(200).send("OK");
  }

  // Return source buttons
  if (pid === "rs_web" || pid === "rs_app") {
    setSession(from, "RETURN_TYPE", { source: pid === "rs_web" ? "madmext_web" : "madmext_app" });
    await sendButtons(from, "İşleminiz hangisi?", [
      { id: "rt_iade", title: "İade" },
      { id: "rt_degisim", title: "Değişim" },
      { id: "rt_back", title: "Ana Menü" },
    ]);
    return res.status(200).send("OK");
  }

  if (pid === "rs_mp") {
    setSession(from, "MARKETPLACE_SELECT", { source: "marketplace" });
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
    return res.status(200).send("OK");
  }

  // Marketplace selection
  if (pid === "mp_trendyol" || pid === "mp_flo" || pid === "mp_hb" || pid === "mp_other") {
    const platform =
      pid === "mp_trendyol" ? "Trendyol" :
      pid === "mp_flo" ? "Flo" :
      pid === "mp_hb" ? "Hepsiburada" : "Diğer";

    setSession(from, "RETURN_TYPE", { source: "marketplace", platform });
    await sendButtons(from, `Platform: ${platform}\n\nİşleminiz hangisi?`, [
      { id: "rt_iade", title: "İade" },
      { id: "rt_degisim", title: "Değişim" },
      { id: "rt_back", title: "Ana Menü" },
    ]);
    return res.status(200).send("OK");
  }

  // Return type
  if (pid === "rt_back") {
    setSession(from, "MAIN_MENU", {});
    await showMainMenu(from, true);
    return res.status(200).send("OK");
  }

  if (pid === "rt_iade" || pid === "rt_degisim") {
    const returnType = pid === "rt_iade" ? "iade" : "degisim";
    setSession(from, "RETURN_ORDER_NO", { ...s.data, returnType, tries: 0 });
    await sendText(from, "Sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
    return res.status(200).send("OK");
  }

  // Unknown payload => show menu
  await showMainMenu(from, false);
  return res.status(200).send("OK");
}

async function handleAskOrderNo(from, rawText, t, res) {
  const s = getSession(from);
  const tries = Number(s.data?.tries || 0);

  if (isCannotFindOrderNo(t)) {
    if (tries === 0) {
      setSession(from, "ASK_ORDER_NO", { ...s.data, tries: 1 });
      await sendText(from, orderNoHelpText());
      return res.status(200).send("OK");
    }
    const liveNo = ticketNo("LIVE");
    tickets.set(liveNo, { ticketNo: liveNo, from, topic: "live_support", message: "Order no not found", context: s.data, status: "NEW", createdAt: now() });
    setSession(from, "HUMAN", { ticketNo: liveNo });

    await notifyOperator({ type: "HUMAN_REQUEST", ticketNo: liveNo, from, reason: "OrderNoNotFound", at: new Date().toISOString() });
    await sendText(from, `Sipariş numarasını bulamadığınızı anladım.\nCanlı desteğe aktardım ✅\nTalep No: ${liveNo}`);
    return res.status(200).send("OK");
  }

  if (t.length < 3) {
    await sendText(from, "Sipariş numarası çok kısa görünüyor. Lütfen tekrar yazın. (Bulamıyorsanız: bulamadım)");
    return res.status(200).send("OK");
  }

  // demo success
  setSession(from, "MAIN_MENU", {});
  const label = s.data?.topic === "cargo" ? "Kargo" : "Sipariş";
  await sendText(from, `${label} için sipariş numaranız alındı: ${rawText}\nDemo: İşlem kontrol ediliyor.`);
  await showMainMenu(from, true);
  return res.status(200).send("OK");
}

async function handleReturnOrderNo(from, rawText, t, res) {
  const s = getSession(from);
  const tries = Number(s.data?.tries || 0);

  if (isCannotFindOrderNo(t)) {
    if (tries === 0) {
      setSession(from, "RETURN_ORDER_NO", { ...s.data, tries: 1 });
      await sendText(from, orderNoHelpText());
      return res.status(200).send("OK");
    }

    const liveNo = ticketNo("LIVE");
    tickets.set(liveNo, { ticketNo: liveNo, from, topic: "live_support", message: "Return flow order no not found", context: s.data, status: "NEW", createdAt: now() });
    setSession(from, "HUMAN", { ticketNo: liveNo });

    await notifyOperator({ type: "HUMAN_REQUEST", ticketNo: liveNo, from, reason: "ReturnOrderNoNotFound", at: new Date().toISOString() });
    await sendText(from, `Sipariş numarasını bulamadığınızı anladım.\nCanlı desteğe aktardım ✅\nTalep No: ${liveNo}`);
    return res.status(200).send("OK");
  }

  if (t.length < 3) {
    await sendText(from, "Sipariş numarası çok kısa görünüyor. Lütfen tekrar yazın. (Bulamıyorsanız: bulamadım)");
    return res.status(200).send("OK");
  }

  setSession(from, "RETURN_PRODUCT", { ...s.data, orderNo: rawText });
  await sendText(from, "Ürün kodu ve beden nedir? (örn: MG2693 / M)");
  return res.status(200).send("OK");
}

async function finalizeReturnTicket(from, reasonText, res) {
  const s = getSession(from);
  const data = s.data || {};

  const prefix = data.source === "marketplace" ? "MP" : "MX";
  const no = ticketNo(prefix);

  const ticket = {
    ticketNo: no,
    from,
    topic: "return",
    source: data.source || null,
    platform: data.platform || null,
    returnType: data.returnType || null,
    orderNo: data.orderNo || null,
    productSize: data.productSize || null,
    reason: reasonText,
    status: "NEW",
    createdAt: now(),
  };

  tickets.set(no, ticket);
  setSession(from, "WAITING_AGENT", { ticketNo: no });

  await notifyOperator({ type: "NEW_TICKET", ticket, at: new Date().toISOString() });

  await sendText(
    from,
    `Talebinizi aldık ✅\nTalep No: ${no}\n\n` +
      `• İşlem: ${ticket.returnType}\n` +
      `• Sipariş: ${ticket.orderNo}\n` +
      `• Ürün/Beden: ${ticket.productSize}\n` +
      (ticket.platform ? `• Platform: ${ticket.platform}\n` : "") +
      `• Sebep: ${ticket.reason}\n\n` +
      "Ekibimiz inceleyip bu sohbet üzerinden dönüş yapacak."
  );

  await sendButtons(from, "İsterseniz canlı desteğe de bağlanabilirsiniz:", [
    { id: "go_live", title: "Canlı Destek" },
    { id: "back_menu", title: "Ana Menü" },
    { id: "noop", title: "Bekleyeceğim" },
  ]);

  return res.status(200).send("OK");
}

async function createSupportTicket(from, messageText, topic, res) {
  const no = ticketNo("SUP");
  const ticket = { ticketNo: no, from, topic, message: messageText, status: "NEW", createdAt: now() };
  tickets.set(no, ticket);
  setSession(from, "WAITING_AGENT", { ticketNo: no });

  await notifyOperator({ type: "NEW_TICKET", ticket, at: new Date().toISOString() });

  await sendText(from, `Talebinizi aldık ✅\nTalep No: ${no}\nEkibimiz bu sohbet üzerinden dönüş yapacak.`);
  await sendButtons(from, "İsterseniz canlı desteğe de bağlanabilirsiniz:", [
    { id: "go_live", title: "Canlı Destek" },
    { id: "back_menu", title: "Ana Menü" },
    { id: "noop", title: "Bekleyeceğim" },
  ]);

  return res.status(200).send("OK");
}
