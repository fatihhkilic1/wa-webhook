// /api/whatsapp-webhook.js  (veya sende hangi path ise)

const seen = new Set(); // test için basit tekrar engeli (serverless'ta kalıcı değildir)

function pickInboundText(body) {
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return null;

  const from = msg.from; // müşteri numarası
  const id = msg.id;     // mesaj id
  const text =
    msg.type === "text" ? msg.text?.body :
    msg.type === "button" ? msg.button?.text :
    msg.type === "interactive" ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title) :
    "";

  return { from, id, text: (text || "").trim(), raw: msg };
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
  console.log("SEND_RESPONSE_STATUS:", resp.status);
  console.log("SEND_RESPONSE_BODY:", JSON.stringify(data, null, 2));

  return { ok: resp.ok, status: resp.status, data };
}

export default async function handler(req, res) {
  // ---- GET: Webhook verify ----
  if (req.method === "GET") {
    const mode = (req.query["hub.mode"] || "").toString();
    const token = (req.query["hub.verify_token"] || "").toString().trim();
    const challenge = req.query["hub.challenge"];

    const expected = (process.env.WA_VERIFY_TOKEN || "madmext_verify_123").toString().trim();

    if (mode !== "subscribe" || token !== expected) {
      return res.status(403).json({
        error: "Forbidden",
        mode,
        token_len: token.length,
        expected_len: expected.length,
        token_last4: token.slice(-4),
        expected_last4: expected.slice(-4),
        env_set: !!process.env.WA_VERIFY_TOKEN,
      });
    }

    return res.status(200).send(challenge);
  }

  // ---- POST: Incoming events ----
  if (req.method === "POST") {
    try {
      // Vercel loglarında body'yi görelim:
      console.log("INCOMING_BODY:", JSON.stringify(req.body, null, 2));

      // WhatsApp event mi?
      const isWhatsapp = req.body?.object === "whatsapp_business_account";
      if (!isWhatsapp) return res.status(200).send("EVENT_RECEIVED");

      const inbound = pickInboundText(req.body);

      // Mesaj yoksa (status update vs) sadece 200 dön
      if (!inbound || !inbound.from) return res.status(200).send("EVENT_RECEIVED");

      // Tekrar engelle (test)
      if (inbound.id && seen.has(inbound.id)) {
        console.log("DUPLICATE_MESSAGE_SKIPPED:", inbound.id);
        return res.status(200).send("EVENT_RECEIVED");
      }
      if (inbound.id) seen.add(inbound.id);

      console.log("INBOUND_FROM:", inbound.from);
      console.log("INBOUND_TEXT:", inbound.text);

      // Basit destek menüsü (marketing yok, sadece bilgilendirme)
      const menu =
        "Madmext WhatsApp Destek\n\n" +
        "Size nasıl yardımcı olalım?\n" +
        "1) Sipariş durumu\n" +
        "2) Kargo takibi\n" +
        "3) İade / Değişim\n" +
        "4) Şikayet / Destek\n\n" +
        "Lütfen sadece 1-2-3-4 yazın.";

      // İlk mesaja otomatik cevap ver
      await sendTextMessage({
        to: inbound.from,
        text: menu,
      });

      return res.status(200).send("EVENT_RECEIVED");
    } catch (e) {
      console.log("WEBHOOK_ERROR:", e?.message || e);
      // WhatsApp retry etmesin diye yine 200 dönmek iyi olur:
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
