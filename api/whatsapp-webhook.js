// /api/whatsapp-webhook.js

// ===== SIMPLE MEMORY (TEST) =====
const seen = new Set();
const userState = new Map();
// userState format:
// key: phone
// value: { state: "MAIN_MENU" | "FLOW_ORDER" | "FLOW_RETURN_SOURCE" | "HUMAN", updatedAt }

function pickInboundText(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return null;

  const from = msg.from;
  const id = msg.id;

  const text =
    msg.type === "text"
      ? msg.text?.body
      : msg.type === "button"
      ? msg.button?.text
      : msg.type === "interactive"
      ? msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title
      : "";

  return { from, id, text: (text || "").trim(), raw: msg };
}

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getMainMenu() {
  return (
    "Madmext WhatsApp Destek\n\n" +
    "Size nasıl yardımcı olalım?\n" +
    "1) Sipariş durumu\n" +
    "2) Kargo takibi\n" +
    "3) İade / Değişim\n" +
    "4) Şikayet / Destek\n\n" +
    "Lütfen sadece 1-2-3-4 yazın."
  );
}

async function sendTextMessage({ to, text }) {
  const token = process.env.WA_ACCESS_TOKEN;
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log("Missing env variables");
    return;
  }

  const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;

  await fetch(url, {
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
}

export default async function handler(req, res) {
  // ===== VERIFY =====
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const expected =
      process.env.WA_VERIFY_TOKEN || "madmext_verify_123";

    if (mode === "subscribe" && token === expected) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  }

  // ===== POST =====
  if (req.method === "POST") {
    try {
      if (req.body?.object !== "whatsapp_business_account")
        return res.status(200).send("EVENT_RECEIVED");

      const inbound = pickInboundText(req.body);
      if (!inbound || !inbound.from)
        return res.status(200).send("EVENT_RECEIVED");

      // ===== DEDUP =====
      if (inbound.id && seen.has(inbound.id))
        return res.status(200).send("EVENT_RECEIVED");

      if (inbound.id) seen.add(inbound.id);

      const from = inbound.from;
      const text = inbound.text;
      const normalized = normalize(text);

      const current =
        userState.get(from) || { state: "NEW" };

      console.log("STATE:", current.state);
      console.log("TEXT:", normalized);

      // ===== GLOBAL MENU COMMAND =====
      const menuWords = [
        "menü",
        "menu",
        "ana menü",
        "anamenu",
        "başla",
        "basla",
        "start",
        "yardım",
        "yardim",
      ];

      if (
        menuWords.includes(normalized) ||
        normalized.includes("menü") ||
        normalized.includes("menu")
      ) {
        userState.set(from, {
          state: "MAIN_MENU",
          updatedAt: Date.now(),
        });

        await sendTextMessage({
          to: from,
          text: getMainMenu(),
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== GREETING =====
      const greetings = [
        "merhaba",
        "selam",
        "selamlar",
        "slm",
        "iyi günler",
        "iyi gunler",
        "günaydın",
        "gunaydin",
        "iyi akşamlar",
        "iyi aksamlar",
        "hello",
        "hi",
      ];

      if (current.state === "NEW" && greetings.some(g => normalized.includes(g))) {
        userState.set(from, {
          state: "MAIN_MENU",
          updatedAt: Date.now(),
        });

        await sendTextMessage({
          to: from,
          text: getMainMenu(),
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== NEW USER =====
      if (current.state === "NEW") {
        userState.set(from, {
          state: "MAIN_MENU",
          updatedAt: Date.now(),
        });

        await sendTextMessage({
          to: from,
          text: getMainMenu(),
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== MAIN MENU =====
      if (current.state === "MAIN_MENU") {
        if (normalized === "1") {
          userState.set(from, {
            state: "FLOW_ORDER",
            updatedAt: Date.now(),
          });

          await sendTextMessage({
            to: from,
            text: "Sipariş numaranızı yazar mısınız?",
          });

          return res.status(200).send("EVENT_RECEIVED");
        }

        if (normalized === "2") {
          await sendTextMessage({
            to: from,
            text: "Kargo takip için sipariş numaranızı yazın.",
          });

          return res.status(200).send("EVENT_RECEIVED");
        }

        if (normalized === "3") {
          userState.set(from, {
            state: "FLOW_RETURN_SOURCE",
            updatedAt: Date.now(),
          });

          await sendTextMessage({
            to: from,
            text:
              "İade veya değişim için siparişinizi nasıl oluşturmuştunuz?\n\n" +
              "1) Madmext.com\n" +
              "2) Mobil Uygulama\n" +
              "3) Pazaryeri\n" +
              "4) Sipariş numaramı nasıl öğrenirim?",
          });

          return res.status(200).send("EVENT_RECEIVED");
        }

        if (normalized === "4") {
          await sendTextMessage({
            to: from,
            text: "Şikayet veya destek talebinizi detaylı yazabilirsiniz.",
          });

          return res.status(200).send("EVENT_RECEIVED");
        }

        await sendTextMessage({
          to: from,
          text: "Seçiminizi anlayamadım.\n\n" + getMainMenu(),
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== FLOW ORDER =====
      if (current.state === "FLOW_ORDER") {
        if (normalized.length < 3) {
          await sendTextMessage({
            to: from,
            text: "Sipariş numarası geçersiz görünüyor. Lütfen tekrar yazın. (Ana menü: menü)",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        userState.set(from, {
          state: "MAIN_MENU",
          updatedAt: Date.now(),
        });

        await sendTextMessage({
          to: from,
          text:
            `Sipariş numaranız alındı: ${text}\n\n` +
            "Demo: Siparişiniz hazırlanıyor.\n\n" +
            "Ana menü için 'menü' yazabilirsiniz.",
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== RETURN SOURCE =====
      if (current.state === "FLOW_RETURN_SOURCE") {
        if (normalized === "1" || normalized === "2") {
          await sendTextMessage({
            to: from,
            text: "Lütfen sipariş numaranızı yazın.",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (normalized === "3") {
          await sendTextMessage({
            to: from,
            text:
              "Hangi pazaryerinden sipariş verdiniz?\n" +
              "Trendyol / Flo / Hepsiburada",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (normalized === "4") {
          await sendTextMessage({
            to: from,
            text:
              "Sipariş numaranızı öğrenmek için:\n\n" +
              "Madmext.com → Hesabım → Siparişlerim\n" +
              "Mobil → Hesabım → Siparişlerim\n" +
              "Pazaryeri → Uygulama → Siparişlerim",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        await sendTextMessage({
          to: from,
          text: "Lütfen 1-2-3-4 seçeneklerinden birini yazın.",
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== LIVE SUPPORT INTENT =====
      if (
        normalized.includes("canlı") ||
        normalized.includes("canli")
      ) {
        userState.set(from, {
          state: "HUMAN",
          updatedAt: Date.now(),
        });

        await sendTextMessage({
          to: from,
          text: "Canlı desteğe yönlendiriliyorsunuz. Lütfen bekleyiniz.",
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== FALLBACK =====
      await sendTextMessage({
        to: from,
        text: "Ana menüye dönmek için 'menü' yazabilirsiniz.",
      });

      return res.status(200).send("EVENT_RECEIVED");
    } catch (e) {
      console.log("ERROR:", e?.message || e);
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
