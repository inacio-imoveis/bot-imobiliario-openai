const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "https://evolution-api-production-8ffe.up.railway.app";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "ed44cb6b57f549bd2e1a9fad756fefd59387fd2962b5748d6939099742ff8640";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "bot-ricardo";

export async function sendWhatsAppMessage(to, text) {
  // Garantir formato correto do número
  const number = to.includes("@") ? to.replace("@s.whatsapp.net", "") : to;

  const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: {
      "apikey": EVOLUTION_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      number: number,
      text: text,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Erro Evolution API:", JSON.stringify(data));
  }
  return data;
}
