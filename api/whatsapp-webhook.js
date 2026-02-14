// ===============================
// MADMEXT WHATSAPP SUPPORT ENGINE v6
// Fixes:
// - Refund/Payment return complaints routed to SUPPORT ticket
// - Payload handled BEFORE greeting/NEW
// - WAITING_AGENT "noop" handled cleanly
// NOTE: Serverless memory resets can still happen -> DB needed for perfect state
// ===============================

const seen = new Set();
const sessions = new Map();
const tickets = new Map();

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
    .replace(/[^\w\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, arr) {
  return arr.some((k) => text.includes(k));
}

function getSession(user) {
  return sessions.get(user) || { state: "NEW", data: {} };
}

function setSession(user, state, data = {}) {
  const cur = getSession(user);
  sessions.set(user, { state, data: { ...cur.data, ...data } });
}

function generateTicket(prefix = "MX") {
  return `${prefix}-${Math.floor(10000 + Math.random() * 90000)}`;
}

function extractInbound(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return null;

  let text = "";
  let payloadId = null;

  if (msg.type === "text") text = msg.text?.body || "";

  if (msg.type === "interactive") {
    if (msg.interactive?.button_reply) {
      text = msg.interactive.button_reply.title;
      payloadId = msg.interactive.button_reply.id;
    } else if (msg.interactive?.list_reply) {
      text = msg.interactive.list_reply.title;
      payloadId = msg.interactive.list_reply.id;
    }
  }

  if (msg.type === "button") text = msg.button?.text || "";

  return { from: msg.from, id: msg.id, text, payloadId };
}

// ---------- WhatsApp send ----------
async function sendMessage(payload) {
  const token = process.env.WA_ACCESS_TOKEN;
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) return;
  await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendText(to, text) {
  return sendMessage({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
}

async function sendButtons(to, body, buttons) {
  return sendMessage({
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
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "list", body: { text: body }, action: { button: buttonText, sections } },
  });
}

async function showMainMenu(user) {
  return sendList(user, "Size nasıl yardımcı olabilirim?", "Menüyü Aç", [
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

function isMenuWord(t) {
  return containsAny(t, ["menu", "menü", "ana menu", "ana menü", "basla", "başla", "yardim", "yardım", "start"]);
}
function isGreeting(t) {
  return containsAny(t, ["merhaba", "mrb", "mrhb", "selam", "slm", "selamlar", "gunaydin", "günaydın"]);
}
function isLiveSupportText(t) {
  return containsAny(t, ["canli destek", "canlı destek", "musteri hizmetleri", "müşteri hizmetleri", "temsilci", "operatore", "operatöre"]);
}
function isWhenQuestion(t) {
  return containsAny(t, ["ne zaman", "kac dk", "kaç dk", "ne kadar sure", "ne kadar süre", "kimse var", "cevap"]);
}
function isRefundComplaint(t) {
  return containsAny(t, [
    "para iadesi", "ucret iadesi", "ücret iadesi", "geri odeme", "geri ödeme",
    "refund", "iade yapilmadi", "iade yapılmadı", "iade yatmadi", "iade yatmadı",
    "para iadem", "para iademi", "iadem yapilmadi", "iadem yapılmadı"
  ]);
}

export default async function handler(req, res) {
  // Verify
  if (req.method === "GET") {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.WA_VERIFY_TOKEN) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    if (req.body?.object !== "whatsapp_business_account") return res.status(200).send("OK");

    const inbound = extractInbound(req.body);
    if (!inbound) return res.status(200).send("OK");

    if (seen.has(inbound.id)) return res.status(200).send("OK");
    seen.add(inbound.id);

    const user = inbound.from;
    const rawText = inbound.text || "";
    const t = normalize(rawText);
    const pid = inbound.payloadId;
    const session = getSession(user);

    // HARD HUMAN LOCK
    if (session.state === "HUMAN") {
      if (isMenuWord(t)) {
        setSession(user, "MAIN_MENU", {});
        await showMainMenu(user);
      }
      return res.status(200).send("OK");
    }

    // MENU command
    if (isMenuWord(t)) {
      setSession(user, "MAIN_MENU", {});
      await showMainMenu(user);
      return res.status(200).send("OK");
    }

    // LIVE SUPPORT from text
    if (isLiveSupportText(t)) {
      const ticketNo = generateTicket("LIVE");
      tickets.set(ticketNo, { ticketNo, from: user, topic: "live_support", message: rawText, status: "NEW", createdAt: Date.now() });
      setSession(user, "HUMAN", { ticketNo });
      await sendText(user, `Canlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
      return res.status(200).send("OK");
    }

    // ========= PAYLOAD FIRST (critical) =========
    if (pid === "m_order") {
      setSession(user, "ASK_ORDER_NO", { topic: "order", tries: 0 });
      await sendText(user, "Sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
      return res.status(200).send("OK");
    }
    if (pid === "m_cargo") {
      setSession(user, "ASK_ORDER_NO", { topic: "cargo", tries: 0 });
      await sendText(user, "Kargo takibi için sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
      return res.status(200).send("OK");
    }
    if (pid === "m_return") {
      setSession(user, "RETURN_SOURCE", {});
      await sendButtons(user, "Siparişinizi nereden oluşturdunuz?", [
        { id: "rs_web", title: "Madmext.com" },
        { id: "rs_app", title: "Mobil Uygulama" },
        { id: "rs_mp", title: "Pazaryeri" },
      ]);
      return res.status(200).send("OK");
    }
    if (pid === "m_support") {
      setSession(user, "ASK_SUPPORT_TEXT", {});
      await sendText(user, "Destek talebinizi kısaca yazar mısınız? (Konu + sipariş no varsa ekleyin)");
      return res.status(200).send("OK");
    }

    // WAITING_AGENT buttons
    if (pid === "go_live") {
      const ticketNo = generateTicket("LIVE");
      tickets.set(ticketNo, { ticketNo, from: user, topic: "live_support", message: "User pressed live button", status: "NEW", createdAt: Date.now() });
      setSession(user, "HUMAN", { ticketNo });
      await sendText(user, `Canlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
      return res.status(200).send("OK");
    }
    if (pid === "back_menu") {
      setSession(user, "MAIN_MENU", {});
      await showMainMenu(user);
      return res.status(200).send("OK");
    }
    if (pid === "noop") {
      // IMPORTANT: stay in WAITING_AGENT if already there
      if (session.state !== "WAITING_AGENT") setSession(user, "WAITING_AGENT", session.data || {});
      await sendText(user, "Tamam. Ekibimiz dönüş yapınca bu sohbetten yazacak.");
      return res.status(200).send("OK");
    }

    // NEW / Greeting
    if (session.state === "NEW") {
      setSession(user, "MAIN_MENU", {});
      await sendText(user, "Merhaba 👋");
      await showMainMenu(user);
      return res.status(200).send("OK");
    }
    if (isGreeting(t)) {
      setSession(user, "MAIN_MENU", {});
      await showMainMenu(user);
      return res.status(200).send("OK");
    }

    // ========= TEXT INTENT: Refund complaint -> Support ticket مباشرة =========
    if (isRefundComplaint(t)) {
      const ticketNo = generateTicket("SUP");
      tickets.set(ticketNo, { ticketNo, from: user, topic: "refund_complaint", message: rawText, status: "NEW", createdAt: Date.now() });
      setSession(user, "WAITING_AGENT", { ticketNo });
      await sendText(user, `Talebinizi aldık ✅\nTalep No: ${ticketNo}\nEkibimiz inceleyip bu sohbet üzerinden dönüş yapacak.`);
      await sendButtons(user, "İsterseniz canlı desteğe bağlanabilirsiniz:", [
        { id: "go_live", title: "Canlı Destek" },
        { id: "back_menu", title: "Ana Menü" },
        { id: "noop", title: "Bekleyeceğim" },
      ]);
      return res.status(200).send("OK");
    }

    // WAITING_AGENT: answer "ne zaman" / "kimse var mı"
    if (session.state === "WAITING_AGENT") {
      if (isWhenQuestion(t)) {
        await sendText(user, "Yoğunluğa göre değişebilir. Genelde 5–15 dk içinde dönüş olur. İsterseniz canlı desteğe bağlanabilirsiniz.");
        await sendButtons(user, "Ne yapmak istersiniz?", [
          { id: "go_live", title: "Canlı Destek" },
          { id: "back_menu", title: "Ana Menü" },
          { id: "noop", title: "Bekleyeceğim" },
        ]);
        return res.status(200).send("OK");
      }
      await sendText(user, "Talebiniz sırada. Ekibimiz bu sohbet üzerinden dönüş yapacak. (Canlı destek isterseniz: canlı destek)");
      return res.status(200).send("OK");
    }

    // If nothing matched -> menu
    setSession(user, "MAIN_MENU", {});
    await showMainMenu(user);
    return res.status(200).send("OK");

  } catch (e) {
    console.log("WEBHOOK_ERROR:", e?.message || e);
    return res.status(200).send("OK");
  }
}
