const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "https://evolution-api-production-8ffe.up.railway.app";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "ed44cb6b57f549bd2e1a9fad756fefd59387fd2962b5748d6939099742ff8640";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "bot-ricardo";

// ── RASTREIO DE MENSAGENS ENVIADAS PELO BOT ─────────────────────────────────
// Toda mensagem enviada pela instância (seja pela Ana, seja digitada manualmente
// pelo corretor no mesmo número 5562992786934) chega de volta no webhook como
// fromMe:true — o WhatsApp não distingue origem. Para diferenciar "Ana respondeu"
// de "corretor assumiu a conversa manualmente", guardamos aqui o id de toda
// mensagem que a própria Ana mandou via sendWhatsAppMessage/sendWhatsAppImage.
// Se um fromMe:true chegar com um id que NÃO está neste Set, foi digitado
// manualmente por um humano — sinal de que o corretor assumiu a conversa.
const botMessageIds = new Set();
const BOT_MESSAGE_ID_TTL_MS = 60 * 60 * 1000; // 1h é suficiente; a checagem é sempre quase imediata

// Segunda camada de proteção (fallback): se por algum motivo a Evolution API não
// devolver key.id na resposta do envio (rastreio por id acima não funciona), evita
// pausar a Ana por engano usando uma janela curta de cooldown por número — uma
// mensagem fromMe chegando logo após a Ana ter mandado algo pra esse número é
// tratada como eco da própria resposta, não como mensagem manual do corretor.
const lastBotSendByNumber = new Map();
const BOT_SEND_COOLDOWN_MS = 15 * 1000;

function registrarMensagemDoBot(id, number) {
  if (number) lastBotSendByNumber.set(number, Date.now());
  if (!id) return;
  botMessageIds.add(id);
  setTimeout(() => botMessageIds.delete(id), BOT_MESSAGE_ID_TTL_MS);
}

export function isBotMessageId(id) {
  return !!id && botMessageIds.has(id);
}

export function isWithinBotSendCooldown(number) {
  const last = lastBotSendByNumber.get(number);
  return !!last && (Date.now() - last) < BOT_SEND_COOLDOWN_MS;
}

export async function sendWhatsAppMessage(to, text) {
  const number = to.includes("@") ? to.replace("@s.whatsapp.net", "") : to;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: {
      "apikey": EVOLUTION_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number, text }),
  });

  const data = await response.json();
  if (!response.ok) console.error("Erro Evolution API (text):", JSON.stringify(data));
  const sentId = data?.key?.id || null;
  if (!sentId) console.warn("[whatsapp] sendText: resposta sem key.id — rastreio fromMe pode falhar:", JSON.stringify(data).slice(0, 300));
  registrarMensagemDoBot(sentId, number);
  data._sentMessageId = sentId;
  return data;
}

export async function sendWhatsAppImage(to, imageUrl, caption = "") {
  const number = to.includes("@") ? to.replace("@s.whatsapp.net", "") : to;

  // Tenta sendMedia com ambos os formatos (media e mediaUrl)
  const response = await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: {
      "apikey": EVOLUTION_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      number,
      mediatype: "image",
      mimetype: "image/jpeg",
      media: imageUrl,
      mediaUrl: imageUrl,
      caption,
      fileName: "foto.jpg",
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Erro Evolution API (image):", JSON.stringify(data));
    // Fallback: envia como URL de texto simples
    return sendWhatsAppMessage(to, imageUrl);
  }
  const sentId = data?.key?.id || null;
  if (!sentId) console.warn("[whatsapp] sendMedia: resposta sem key.id — rastreio fromMe pode falhar:", JSON.stringify(data).slice(0, 300));
  registrarMensagemDoBot(sentId, number);
  data._sentMessageId = sentId;
  return data;
}
