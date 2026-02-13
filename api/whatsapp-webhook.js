export default function handler(req, res) {
  if (req.method === "GET") {
    const mode = (req.query["hub.mode"] || "").toString();
    const token = (req.query["hub.verify_token"] || "").toString().trim();
    const challenge = req.query["hub.challenge"];

    const expected = (process.env.WA_VERIFY_TOKEN || "madmext_verify_123").toString().trim();

    // DEBUG: eşleşmiyorsa ne geldiğini görelim (tokenı maskeleyerek)
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

  if (req.method === "POST") {
    // Şimdilik sadece 200 dönelim
    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}
