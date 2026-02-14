// ===============================
// MADMEXT WHATSAPP SUPPORT ENGINE v4
// Stable Human Lock + Clean State Machine
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
    .replace(/[^\w\s]/gi, "")
    .trim();
}

function containsAny(text, arr) {
  return arr.some(k => text.includes(k));
}

function getSession(user) {
  return sessions.get(user) || { state: "NEW", data: {} };
}

function setSession(user, state, data = {}) {
  const current = getSession(user);
  sessions.set(user, {
    state,
    data: { ...current.data, ...data }
  });
}

function generateTicket(prefix = "MX") {
  return `${prefix}-${Math.floor(10000 + Math.random() * 90000)}`;
}

async function sendMessage(payload) {
  const token = process.env.WA_ACCESS_TOKEN;
  const phoneId = process.env.WA_PHONE_NUMBER_ID;

  await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function sendText(to, text) {
  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

async function sendButtons(to, body, buttons) {
  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

async function sendList(to, body, buttonText, sections) {
  await sendMessage({
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

function extractInbound(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return null;

  let text = "";
  let payloadId = null;

  if (msg.type === "text") text = msg.text.body;

  if (msg.type === "interactive") {
    if (msg.interactive.button_reply) {
      text = msg.interactive.button_reply.title;
      payloadId = msg.interactive.button_reply.id;
    }
    if (msg.interactive.list_reply) {
      text = msg.interactive.list_reply.title;
      payloadId = msg.interactive.list_reply.id;
    }
  }

  return { from: msg.from, id: msg.id, text, payloadId };
}

// ===============================
// MAIN HANDLER
// ===============================

export default async function handler(req, res) {

  if (req.method === "GET") {
    if (
      req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === process.env.WA_VERIFY_TOKEN
    ) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {

    if (req.body.object !== "whatsapp_business_account")
      return res.status(200).send("OK");

    const inbound = extractInbound(req.body);
    if (!inbound) return res.status(200).send("OK");

    if (seen.has(inbound.id)) return res.status(200).send("OK");
    seen.add(inbound.id);

    const user = inbound.from;
    const rawText = inbound.text || "";
    const text = normalize(rawText);
    const session = getSession(user);

    // ===============================
    // HARD HUMAN LOCK
    // ===============================
    if (session.state === "HUMAN") {

      console.log("HUMAN MODE ACTIVE");

      if (containsAny(text, ["menu", "menü", "ana menu"])) {
        setSession(user, "MAIN");
        await showMainMenu(user);
      }

      return res.status(200).send("OK");
    }

    // ===============================
    // GREETING
    // ===============================
    if (containsAny(text, ["merhaba", "mrb", "selam", "slm"])) {
      setSession(user, "MAIN");
      await showMainMenu(user);
      return res.status(200).send("OK");
    }

    // ===============================
    // PAYLOAD ROUTER
    // ===============================
    if (inbound.payloadId === "menu_order") {
      setSession(user, "ASK_ORDER");
      await sendText(user, "Sipariş numaranızı yazar mısınız?");
      return res.status(200).send("OK");
    }

    if (inbound.payloadId === "menu_cargo") {
      setSession(user, "ASK_ORDER");
      await sendText(user, "Kargo takibi için sipariş numaranızı yazar mısınız?");
      return res.status(200).send("OK");
    }

    if (inbound.payloadId === "menu_return") {
      setSession(user, "RETURN_SOURCE");
      await sendButtons(user, "Siparişinizi nereden oluşturdunuz?", [
        { id: "src_web", title: "Madmext.com" },
        { id: "src_app", title: "Mobil Uygulama" },
        { id: "src_mp", title: "Pazaryeri" }
      ]);
      return res.status(200).send("OK");
    }

    if (inbound.payloadId === "menu_support") {
      setSession(user, "ASK_SUPPORT");
      await sendText(user, "Destek talebinizi kısaca yazar mısınız?");
      return res.status(200).send("OK");
    }

    // ===============================
    // ORDER FLOW
    // ===============================
    if (session.state === "ASK_ORDER") {

      if (containsAny(text, ["bulamadim", "yok", "bilmiyorum"])) {
        const ticket = generateTicket("LIVE");
        tickets.set(ticket, { user, reason: "Order not found" });

        setSession(user, "HUMAN");

        await sendText(user,
          `Sipariş numarası bulunamadı.\nCanlı desteğe aktardım ✅\nTalep No: ${ticket}`
        );

        return res.status(200).send("OK");
      }

      setSession(user, "MAIN");
      await sendText(user,
        `Sipariş numaranız alındı: ${rawText}\nDemo: İşlem kontrol ediliyor.`
      );
      await showMainMenu(user);
      return res.status(200).send("OK");
    }

    // ===============================
    // SUPPORT FLOW
    // ===============================
    if (session.state === "ASK_SUPPORT") {

      const ticket = generateTicket("SUP");
      tickets.set(ticket, { user, message: rawText });

      setSession(user, "MAIN");

      await sendText(user,
        `Talebinizi aldık ✅\nTalep No: ${ticket}\nEkibimiz dönüş yapacak.`
      );

      await showMainMenu(user);
      return res.status(200).send("OK");
    }

    // ===============================
    // FALLBACK
    // ===============================
    await showMainMenu(user);
    return res.status(200).send("OK");
  }

  return res.status(405).send("Method Not Allowed");
}

// ===============================
// MAIN MENU (LIST UX)
// ===============================
async function showMainMenu(user) {
  await sendList(user,
    "Size nasıl yardımcı olabilirim?",
    "Menüyü Aç",
    [
      {
        title: "Madmext Destek",
        rows: [
          { id: "menu_order", title: "Sipariş Durumu" },
          { id: "menu_cargo", title: "Kargo Takibi" },
          { id: "menu_return", title: "İade / Değişim" },
          { id: "menu_support", title: "Şikayet / Destek" }
        ]
      }
    ]
  );
}
