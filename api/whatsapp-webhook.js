export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;

  // 1️⃣ Webhook doğrulama (Meta ilk GET atar)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // 2️⃣ Mesaj alma
  if (req.method === "POST") {
    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return res.status(200).send("OK");

      const from = msg.from;
      const text = (msg?.text?.body || "").trim().toLowerCase();

      if (text === "1" || text.includes("iade")) {
        await sendText(from, "İade/Değişim için sipariş numaranızı yazar mısınız?");
      } else if (text === "2" || text.includes("ürün") || text.includes("urun")) {
        await sendText(from, "Ürün kodunu yazın (örn: MG2362). Beden için boy/kilo da paylaşabilirsiniz.");
      } else {
        await sendText(from, "Merhaba 👋\n1) İade/Değişim\n2) Ürün & Beden\nYanıt olarak 1 veya 2 yazabilirsiniz.");
      }

      return res.status(200).send("OK");
    } catch (e) {
      console.error(e);
      return res.status(200).send("OK");
    }
  }

  return res.status(405).send("Method Not Allowed");

  async function sendText(to, body) {
    const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
    const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;

    if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
      throw new Error("WA_ACCESS_TOKEN veya WA_PHONE_NUMBER_ID eksik.");
    }

    const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(data));
    return data;
  }
}
