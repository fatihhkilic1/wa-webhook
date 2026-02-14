// ===============================
// MADMEXT WHATSAPP SUPPORT ENGINE v5 (Production)
// Fixes:
// - Live support intent
// - Full return flow after source selection
// - No double-menu spam (single-exit handling)
// - Ticket waiting state answers ("ne zaman?")
// - Hard HUMAN lock (bot silent) with "menü" escape
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

  if (msg.type === "button") {
    text = msg.button?.text || "";
  }

  return { from: msg.from, id: msg.id, text, payloadId, raw: msg };
}

// ---------- WhatsApp send ----------
async function sendMessage(payload) {
  const token = process.env.WA_ACCESS_TOKEN;
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.log("Missing WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID");
    return;
  }
  await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendText(to, text) {
  return sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

// Buttons max 3
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

// List for 4+ options
async function sendList(to, body, buttonText, sections) {
  return sendMessage({
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

// ---------- Operator notify (optional) ----------
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
async function showMainMenu(user) {
  // List menu (4 seçenek)
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

function orderNoHelpText() {
  return (
    "Sipariş numaranızı şöyle bulabilirsiniz:\n\n" +
    "• Madmext.com: Hesabım → Siparişlerim → ilgili sipariş → Sipariş No\n" +
    "• Mobil Uygulama: Hesabım → Siparişlerim → ilgili sipariş → Sipariş No\n" +
    "• Pazaryeri: Uygulama → Siparişlerim → ilgili sipariş → Sipariş/Sipariş Kodu\n\n" +
    "Bulamazsanız 'bulamadım' yazın, canlı desteğe aktaralım."
  );
}

function isCannotFind(t) {
  return containsAny(t, [
    "bulamadim", "bulamiyorum", "bulamadım", "bulamıyorum",
    "yok", "bilmiyorum", "hatirlamiyorum", "hatırlamiyorum", "hatırlamıyorum",
    "siparis no yok", "siparis numaram yok", "siparis numarasi yok",
    "bulunmuyor",
  ]);
}

function isLiveSupportText(t) {
  return containsAny(t, [
    "canli destek", "canlı destek", "musteri hizmetleri", "müşteri hizmetleri",
    "temsilci", "operatore bagla", "operatöre bağla", "insanla konus",
    "canliya aktar", "canli baglan",
  ]);
}

function isGreeting(t) {
  return containsAny(t, ["merhaba", "mrb", "mrhb", "selam", "slm", "selamlar", "gunaydin", "günaydın"]);
}

function isMenuWord(t) {
  return containsAny(t, ["menu", "menü", "ana menu", "ana menü", "basla", "başla", "start", "yardim", "yardım"]);
}

function isWhenQuestion(t) {
  return containsAny(t, ["ne zaman", "kac dk", "kaç dk", "ne kadar sure", "ne kadar süre", "hemen mi", "ne zaman yazar"]);
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  // Verify
  if (req.method === "GET") {
    if (
      req.query["hub.mode"] === "subscribe" &&
      req.query["hub.verify_token"] === process.env.WA_VERIFY_TOKEN
    ) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    if (req.body?.object !== "whatsapp_business_account") return res.status(200).send("OK");

    const inbound = extractInbound(req.body);
    if (!inbound) return res.status(200).send("OK");

    // Dedup
    if (seen.has(inbound.id)) return res.status(200).send("OK");
    seen.add(inbound.id);

    const user = inbound.from;
    const rawText = inbound.text || "";
    const t = normalize(rawText);
    const session = getSession(user);

    // --------------------------
    // HARD HUMAN LOCK (BOT SILENT)
    // --------------------------
    if (session.state === "HUMAN") {
      // sadece menü ile çıkar
      if (isMenuWord(t)) {
        setSession(user, "MAIN_MENU", {});
        await showMainMenu(user);
      }
      return res.status(200).send("OK");
    }

    // --------------------------
    // Global: menu command
    // --------------------------
    if (isMenuWord(t)) {
      setSession(user, "MAIN_MENU", {});
      await showMainMenu(user);
      return res.status(200).send("OK");
    }

    // --------------------------
    // Global: live support from text
    // --------------------------
    if (isLiveSupportText(t)) {
      const ticketNo = generateTicket("LIVE");
      const ticket = {
        ticketNo,
        from: user,
        topic: "live_support",
        message: rawText,
        status: "NEW",
        createdAt: Date.now(),
      };
      tickets.set(ticketNo, ticket);

      setSession(user, "HUMAN", { ticketNo });

      await notifyOperator({ type: "HUMAN_REQUEST", ticket, at: new Date().toISOString() });

      await sendText(
        user,
        `Canlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`
      );
      return res.status(200).send("OK");
    }

    // --------------------------
    // NEW / Greeting
    // --------------------------
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

    // --------------------------
    // Payload router (Interactive)
    // --------------------------
    const pid = inbound.payloadId;

    // Main menu list
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

    // Return source buttons
    if (pid === "rs_web" || pid === "rs_app") {
      setSession(user, "RETURN_TYPE", { source: pid === "rs_web" ? "madmext_web" : "madmext_app" });
      await sendButtons(user, "İşleminiz hangisi?", [
        { id: "rt_iade", title: "İade" },
        { id: "rt_degisim", title: "Değişim" },
        { id: "rt_back", title: "Ana Menü" },
      ]);
      return res.status(200).send("OK");
    }

    if (pid === "rs_mp") {
      setSession(user, "MARKETPLACE_SELECT", { source: "marketplace" });
      await sendList(user, "Hangi pazaryerinden sipariş verdiniz?", "Seçenekleri Gör", [
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

    // Marketplace selection (list)
    if (session.state === "MARKETPLACE_SELECT" && pid) {
      const platform =
        pid === "mp_trendyol" ? "Trendyol" :
        pid === "mp_flo" ? "Flo" :
        pid === "mp_hb" ? "Hepsiburada" :
        pid === "mp_other" ? "Diğer" : null;

      if (!platform) {
        await sendText(user, "Lütfen listeden bir pazaryeri seçin. (Ana menü: menü)");
        return res.status(200).send("OK");
      }

      setSession(user, "RETURN_TYPE", { source: "marketplace", platform });
      await sendButtons(user, `Platform: ${platform}\n\nİşleminiz hangisi?`, [
        { id: "rt_iade", title: "İade" },
        { id: "rt_degisim", title: "Değişim" },
        { id: "rt_back", title: "Ana Menü" },
      ]);
      return res.status(200).send("OK");
    }

    // Return type buttons
    if (pid === "rt_back") {
      setSession(user, "MAIN_MENU", {});
      await showMainMenu(user);
      return res.status(200).send("OK");
    }

    if (pid === "rt_iade" || pid === "rt_degisim") {
      const rt = pid === "rt_iade" ? "iade" : "degisim";
      setSession(user, "RETURN_ORDER_NO", { ...session.data, returnType: rt, tries: 0 });
      await sendText(user, "Sipariş numaranızı yazar mısınız? (Bulamazsanız: bulamadım)");
      return res.status(200).send("OK");
    }

    // --------------------------
    // State machine (text steps)
    // --------------------------

    // 1) Order/Cargo asks order no
    if (session.state === "ASK_ORDER_NO") {
      const tries = Number(session.data?.tries || 0);

      if (isCannotFind(t)) {
        if (tries === 0) {
          setSession(user, "ASK_ORDER_NO", { ...session.data, tries: 1 });
          await sendText(user, orderNoHelpText());
          return res.status(200).send("OK");
        }
        // 2. deneme de yoksa canlıya
        const ticketNo = generateTicket("LIVE");
        const ticket = {
          ticketNo,
          from: user,
          topic: "live_support",
          message: "Müşteri sipariş no bulamıyor.",
          context: session.data,
          status: "NEW",
          createdAt: Date.now(),
        };
        tickets.set(ticketNo, ticket);
        setSession(user, "HUMAN", { ticketNo });

        await notifyOperator({ type: "HUMAN_REQUEST", ticket, at: new Date().toISOString() });

        await sendText(user, `Sipariş numarasını bulamadığınızı anladım.\nCanlı desteğe aktardım ✅\nTalep No: ${ticketNo}`);
        return res.status(200).send("OK");
      }

      if (t.length < 3) {
        await sendText(user, "Sipariş numarası çok kısa görünüyor. Lütfen tekrar yazın. (Bulamıyorsanız: bulamadım)");
        return res.status(200).send("OK");
      }

      setSession(user, "MAIN_MENU", {});
      const label = session.data?.topic === "cargo" ? "Kargo" : "Sipariş";
      await sendText(user, `${label} için sipariş numaranız alındı: ${rawText}\nDemo: İşlem kontrol ediliyor.`);
      await showMainMenu(user);
      return res.status(200).send("OK");
    }

    // 2) Return order no
    if (session.state === "RETURN_ORDER_NO") {
      const tries = Number(session.data?.tries || 0);

      if (isCannotFind(t)) {
        if (tries === 0) {
          setSession(user, "RETURN_ORDER_NO", { ...session.data, tries: 1 });
          await sendText(user, orderNoHelpText());
          return res.status(200).send("OK");
        }
        // 2. deneme de yok -> canlı
        const ticketNo = generateTicket("LIVE");
        const ticket = {
          ticketNo,
          from: user,
          topic: "live_support",
          message: "İade/Değişim akışında sipariş no bulunamadı.",
          context: session.data,
          status: "NEW",
          createdAt: Date.now(),
        };
        tickets.set(ticketNo, ticket);
        setSession(user, "HUMAN", { ticketNo });

        await notifyOperator({ type: "HUMAN_REQUEST", ticket, at: new Date().toISOString() });

        await sendText(user, `Sipariş numarasını bulamadığınızı anladım.\nCanlı desteğe aktardım ✅\nTalep No: ${ticketNo}`);
        return res.status(200).send("OK");
      }

      if (t.length < 3) {
        await sendText(user, "Sipariş numarası çok kısa görünüyor. Lütfen tekrar yazın. (Bulamıyorsanız: bulamadım)");
        return res.status(200).send("OK");
      }

      setSession(user, "RETURN_PRODUCT", { ...session.data, orderNo: rawText });
      await sendText(user, "Ürün kodu ve beden nedir? (örn: MG2693 / M)");
      return res.status(200).send("OK");
    }

    // 3) Return product/size
    if (session.state === "RETURN_PRODUCT") {
      if (t.length < 2) {
        await sendText(user, "Ürün kodu/beden bilgisini tekrar yazar mısınız? (örn: MG2693 / M)");
        return res.status(200).send("OK");
      }
      setSession(user, "RETURN_REASON", { ...session.data, productSize: rawText });
      await sendText(user, "İade/Değişim sebebinizi kısaca yazar mısınız? (örn: beden küçük geldi)");
      return res.status(200).send("OK");
    }

    // 4) Return reason => create ticket + WAITING_AGENT
    if (session.state === "RETURN_REASON") {
      if (t.length < 2) {
        await sendText(user, "Sebebi kısaca yazar mısınız? (örn: beden büyük geldi / defolu geldi)");
        return res.status(200).send("OK");
      }

      const data = session.data || {};
      const ticketNo = generateTicket(data.source === "marketplace" ? "MP" : "MX");

      const ticket = {
        ticketNo,
        from: user,
        topic: "return",
        source: data.source,
        platform: data.platform || null,
        returnType: data.returnType,
        orderNo: data.orderNo,
        productSize: data.productSize,
        reason: rawText,
        status: "NEW",
        createdAt: Date.now(),
      };
      tickets.set(ticketNo, ticket);

      setSession(user, "WAITING_AGENT", { ticketNo });

      await notifyOperator({ type: "NEW_TICKET", ticket, at: new Date().toISOString() });

      await sendText(
        user,
        `Talebinizi aldık ✅\nTalep No: ${ticketNo}\n\n` +
        `• İşlem: ${ticket.returnType}\n` +
        `• Sipariş: ${ticket.orderNo}\n` +
        `• Ürün/Beden: ${ticket.productSize}\n` +
        (ticket.platform ? `• Platform: ${ticket.platform}\n` : "") +
        `• Sebep: ${ticket.reason}\n\n` +
        "Ekibimiz inceleyip bu sohbet üzerinden dönüş yapacak."
      );

      // UX: beklerken seçenek sun
      await sendButtons(user, "İsterseniz canlı desteğe de bağlanabilirsiniz:", [
        { id: "go_live", title: "Canlı Destek" },
        { id: "back_menu", title: "Ana Menü" },
        { id: "noop", title: "Bekleyeceğim" },
      ]);

      return res.status(200).send("OK");
    }

    // 5) Support text => create ticket + WAITING_AGENT
    if (session.state === "ASK_SUPPORT_TEXT") {
      const ticketNo = generateTicket("SUP");
      const ticket = {
        ticketNo,
        from: user,
        topic: "support",
        message: rawText,
        status: "NEW",
        createdAt: Date.now(),
      };
      tickets.set(ticketNo, ticket);

      setSession(user, "WAITING_AGENT", { ticketNo });

      await notifyOperator({ type: "NEW_TICKET", ticket, at: new Date().toISOString() });

      await sendText(user, `Talebinizi aldık ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden dönüş yapacak.`);

      await sendButtons(user, "İsterseniz canlı desteğe de bağlanabilirsiniz:", [
        { id: "go_live", title: "Canlı Destek" },
        { id: "back_menu", title: "Ana Menü" },
        { id: "noop", title: "Bekleyeceğim" },
      ]);

      return res.status(200).send("OK");
    }

    // WAITING_AGENT: "ne zaman" gibi sorulara doğru cevap
    if (session.state === "WAITING_AGENT") {
      if (pid === "go_live") {
        const ticketNo = generateTicket("LIVE");
        const ticket = {
          ticketNo,
          from: user,
          topic: "live_support",
          message: "Kullanıcı beklerken canlı desteğe geçmek istedi.",
          contextTicket: session.data?.ticketNo || null,
          status: "NEW",
          createdAt: Date.now(),
        };
        tickets.set(ticketNo, ticket);

        setSession(user, "HUMAN", { ticketNo });

        await notifyOperator({ type: "HUMAN_REQUEST", ticket, at: new Date().toISOString() });

        await sendText(user, `Canlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
        return res.status(200).send("OK");
      }

      if (pid === "back_menu") {
        setSession(user, "MAIN_MENU", {});
        await showMainMenu(user);
        return res.status(200).send("OK");
      }

      if (isWhenQuestion(t)) {
        await sendText(
          user,
          "Yoğunluğa göre değişebilir. Genelde 5–15 dk içinde dönüş olur.\n" +
          "İsterseniz canlı desteğe bağlanmayı seçebilirsiniz."
        );
        await sendButtons(user, "Ne yapmak istersiniz?", [
          { id: "go_live", title: "Canlı Destek" },
          { id: "back_menu", title: "Ana Menü" },
          { id: "noop", title: "Bekleyeceğim" },
        ]);
        return res.status(200).send("OK");
      }

      // başka bir şey yazarsa: nazik bekleme
      await sendText(user, "Talebiniz sırada. Ekibimiz bu sohbet üzerinden dönüş yapacak. (Canlı destek isterseniz yazın: canlı destek)");
      return res.status(200).send("OK");
    }

    // Buttons in WAITING_AGENT are payload-based
    if (pid === "go_live" || pid === "back_menu" || pid === "noop") {
      // if payload arrives outside WAITING_AGENT, safely route
      if (pid === "back_menu") {
        setSession(user, "MAIN_MENU", {});
        await showMainMenu(user);
        return res.status(200).send("OK");
      }
      if (pid === "go_live") {
        // same as live support
        const ticketNo = generateTicket("LIVE");
        const ticket = { ticketNo, from: user, topic: "live_support", message: "Kullanıcı canlı destek butonuna bastı.", status: "NEW", createdAt: Date.now() };
        tickets.set(ticketNo, ticket);
        setSession(user, "HUMAN", { ticketNo });
        await notifyOperator({ type: "HUMAN_REQUEST", ticket, at: new Date().toISOString() });
        await sendText(user, `Canlı desteğe aktardım ✅\nTalep No: ${ticketNo}\nEkibimiz bu sohbet üzerinden yazacak.`);
        return res.status(200).send("OK");
      }
      // noop: do nothing
      await sendText(user, "Tamam, ekibimiz dönüş yapınca buradan yazacak.");
      return res.status(200).send("OK");
    }

    // If nothing matched: show menu (single response)
    setSession(user, "MAIN_MENU", {});
    await showMainMenu(user);
    return res.status(200).send("OK");

  } catch (e) {
    console.log("WEBHOOK_ERROR:", e?.message || e);
    return res.status(200).send("OK");
  }
}
