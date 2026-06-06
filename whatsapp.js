const WHATSAPP_API_URL = "https://graph.facebook.com/v18.0";

export async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  const response = await fetch(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Erro WhatsApp API:", JSON.stringify(data));
  }
  return data;
}
