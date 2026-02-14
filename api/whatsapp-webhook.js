// /api/whatsapp-webhook.js

// ===== DEDUP + STATE (test için; serverless restart olursa sıfırlanabilir) =====
const seen = new Set(); // duplicate engelleme
const userState = new Map(); // key: phone, value: { state, updatedAt }

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
      // WhatsApp event mi?
      const isWhatsapp = req.body?.object === "whatsapp_business_account";
      if (!isWhatsapp) return res.status(200).send("EVENT_RECEIVED");

      const inbound = pickInboundText(req.body);

      // Mesaj yoksa (status update vs) sadece 200 dön
      if (!inbound || !inbound.from) return res.status(200).send("EVENT_RECEIVED");

      // ===== DEDUP =====
      if (inbound.id && seen.has(inbound.id)) {
        console.log("DUPLICATE_MESSAGE_SKIPPED:", inbound.id);
        return res.status(200).send("EVENT_RECEIVED");
      }
      if (inbound.id) seen.add(inbound.id);

      const from = inbound.from;
      const text = inbound.text;

      // ===== NORMALIZE + MENU/GREETING DETECTION =====
      const normalized = (text || "")
        .toLowerCase()
        .replace(/[“”"']/g, "")                 // tırnaklar
        .replace(/[^\p{L}\p{N}\s]/gu, " ")      // noktalama temizle
        .replace(/\s+/g, " ")
        .trim();

      const compact = normalized.replace(/\s/g, ""); // boşluksuz

      const menuExact = new Set([
        "menü", "menu", "ana menü", "anamenu", "ana-menu", "main menu", "mainmenu",
        "başla", "basla", "start", "başlangıç", "baslangic", "home", "help",
        "yardım", "yardim"
      ]);

      const menuContains = [
        "menüye dön", "menuye don", "ana menüye", "anamenuye",
        "menü istiyorum", "menu istiyorum", "menü göster", "menu goster",
        "menüye", "menuye", "ana menü", "anamenu"
      ];

      const greetExact = new Set([
        "merhaba", "selam", "selamlar", "slm", "s.a", "sa", "s a",
        "iyi günler", "iyi gunler", "günaydın", "gunaydin", "iyi akşamlar", "iyi aksamlar",
        "iyi geceler", "hayırlı günler", "hayırlı gunler", "kolay gelsin",
        "hello", "hi"
      ]);

      const greetContains = [
        "merhabalar", "selamünaleyküm", "selamunaleykum", "aleyküm selam", "aleykum selam",
        "iyi gün", "iyi gun", "günayd", "gunayd", "akşam", "aksam", "geceler"
      ];

      const hasMenuCore =
        compact.includes("menu") || compact.includes("menü") ||
        compact.includes("anamenu") || compact.includes("anamenü") ||
        compact.includes("basla") || compact.includes("başla") ||
        compact.includes("start") || compact.includes("yardim") || compact.includes("yardım");

      const hasGreetCore =
        compact.includes("merhaba") || compact.includes("selam") ||
        compact.includes("slm") || compact === "sa" ||
        compact.includes("gunaydin") || compact.includes("günaydın") ||
        compact.includes("iyigun") || compact.includes("iyigün") ||
        compact.includes("iyiaksam") || compact.includes("iyiakşam") ||
        compact.includes("iyigec");

      const isMenuCall =
        menuExact.has(normalized) ||
        menuExact.has(compact) ||
        menuContains.some(k => normalized.includes(k)) ||
        hasMenuCore;

      const isGreeting =
        greetExact.has(normalized) ||
        greetExact.has(compact) ||
        greetContains.some(k => normalized.includes(k)) ||
        hasGreetCore;

      // ===== GLOBAL: GREETING OR MENU -> SHOW MAIN MENU =====
      if (isGreeting || isMenuCall) {
        userState.set(from, { state: "MAIN_MENU", updatedAt: Date.now() });
        await sendTextMessage({ to: from, text: getMainMenu() });
        return res.status(200).send("EVENT_RECEIVED");
      }

      const current = userState.get(from) || { state: "NEW" };

      console.log("INBOUND_FROM:", from);
      console.log("INBOUND_TEXT:", text);
      console.log("CURRENT_STATE:", current.state);

      // ===== FIRST MESSAGE (NEW) =====
      if (current.state === "NEW") {
        userState.set(from, { state: "MAIN_MENU", updatedAt: Date.now() });
        await sendTextMessage({ to: from, text: getMainMenu() });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== MAIN MENU =====
      if (current.state === "MAIN_MENU") {
        if (normalized === "1") {
          userState.set(from, { state: "FLOW_1", updatedAt: Date.now() });
          await sendTextMessage({ to: from, text: "Sipariş numaranızı yazar mısınız?" });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (normalized === "2") {
          await sendTextMessage({ to: from, text: "Kargo takip için sipariş numaranızı yazın." });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (normalized === "3") {
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
          await sendTextMessage({ to: from, text: "Şikayet veya destek talebinizi detaylı yazabilirsiniz." });
          return res.status(200).send("EVENT_RECEIVED");
        }

        await sendTextMessage({ to: from, text: "Seçiminizi anlayamadım.\n\n" + getMainMenu() });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== FLOW_1: ORDER NO EXPECTED =====
      if (current.state === "FLOW_1") {
        // 1-2-3-4 gibi seçim yazarsa yanlış
        if (/^(1|2|3|4)$/.test(normalized)) {
          await sendTextMessage({
            to: from,
            text: "Sipariş numarası bekliyorum. Ana menü için 'menü' yazabilirsiniz.",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (normalized.length < 3) {
          await sendTextMessage({
            to: from,
            text: "Sipariş numaranız çok kısa görünüyor. Lütfen sipariş numaranızı yazın. (Ana menü: menü)",
          });
          return res.status(200).send("EVENT_RECEIVED");
        }

        // Demo cevap + menüye dön
        userState.set(from, { state: "MAIN_MENU", updatedAt: Date.now() });
        await sendTextMessage({
          to: from,
          text:
            `Sipariş numaranız alındı: ${text}\n\n` +
            "Demo bilgi: Siparişiniz hazırlanıyor.\n\n" +
            "Ana menü için 'menü' yazabilirsiniz.",
        });
        return res.status(200).send("EVENT_RECEIVED");
      }

      // ===== FALLBACK (other states) =====
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
