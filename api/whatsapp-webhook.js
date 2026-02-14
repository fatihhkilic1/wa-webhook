// /api/whatsapp-webhook.js

// ===== DEDUP + STATE =====
const seen = new Set(); // duplicate engelleme (serverless reset olabilir)
const userState = new Map(); 
// key: phone
// value: { state: "MAIN_MENU" | "FLOW_1" | ..., updatedAt: timestamp }

function pickInboundText(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return null;

  const from = msg.from;
  const id = msg.id;

  const text =
    msg.type === "text" ? msg.text?.body :
    msg.type === "button" ? msg.button?.text :
    msg.type === "interactive"
      ? (msg.interactive?.button_reply?.title ||
         msg.interactive?.list_reply?.title)
      : "";

  return { from, id, text: (text || "").trim(), raw: msg };
}

async function sendTextMessage({ to, text }) {
  const token = process.env.WA_ACCESS_TOKEN;
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;

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

  return resp;
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

export default async function handler(req, res) {

  // ===== GET VERIFY =====
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const expected = process.env.WA_VERIFY_TOKEN || "madmext_verify_123";

    if (mode === "subscribe" && token === expected) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // ===== POST =====
  if (req.method === "POST") {
    try {
      const isWhatsapp = req.body?.object === "whatsapp_business_account";
      if (!isWhatsapp) return res.status(200).send("EVENT_RECEIVED");

      const inbound = pickInboundText(req.body);
      if (!inbound || !inbound.from) {
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== DEDUP =====
      if (inbound.id && seen.has(inbound.id)) {
        return res.status(200).send("EVENT_RECEIVED");
      }
      if (inbound.id) seen.add(inbound.id);

      const from = inbound.from;
      const text = inbound.text;

      const current = userState.get(from) || { state: "NEW" };

      console.log("STATE:", current.state);
      console.log("TEXT:", text);

      // ===== FIRST MESSAGE =====
      if (current.state === "NEW") {
        userState.set(from, { state: "MAIN_MENU", updatedAt: Date.now() });

        await sendTextMessage({
          to: from,
          text: getMainMenu(),
        });

        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== MAIN MENU STATE =====
      if (current.state === "MAIN_MENU") {

        if (text === "1") {
          userState.set(from, { state: "FLOW_1", updatedAt: Date.now() });

          await sendTextMessage({
            to: from,
            text: "Sipariş numaranızı yazar mısınız?",
          });

          return res.status(200).send("EVENT_RECEIVED");
        }

        if (text === "2") {
          await sendTextMessage({
            to: from,
            text: "Kargo takip için sipariş numaranızı yazın.",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (text === "3") {
          await sendTextMessage({
            to: from,
            text: "İade veya değişim için siparişinizi nasıl oluşturmuştunuz?\n\n1) Madmext.com\n2) Mobil Uygulama\n3) Pazaryeri\n4) Sipariş numaramı nasıl öğrenirim?",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (text === "4") {
          await sendTextMessage({
            to: from,
            text: "Şikayet veya destek talebinizi detaylı yazabilirsiniz.",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        // Tanınmayan mesaj → menüye geri dön
        await sendTextMessage({
          to: from,
          text: "Seçiminizi anlayamadım.\n\n" + getMainMenu(),
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
      console.log("WEBHOOK_ERROR:", e?.message || e);
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
