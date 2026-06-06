import express from "express";
import OpenAI from "openai";
import { catalog } from "./imoveis.js";
import { sessionManager } from "./sessions.js";
import { sendWhatsAppMessage } from "./whatsapp.js";
import { buildSystemPrompt } from "./prompt.js";
import { detectHandoffTrigger, formatHandoffAlert } from "./handoff.js";

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message || message.type !== "text") return;

  const phone = message.from;
  const userText = message.text.body.trim();

  console.log(`[${phone}] → ${userText}`);

  try {
    const session = sessionManager.get(phone);

    if (session.waitingForHuman) {
      console.log(`[${phone}] Em espera de atendente — bot pausado.`);
      return;
    }

    session.addMessage("user", userText);

    const handoffRequest = detectHandoffTrigger(userText);
    if (handoffRequest) {
      session.waitingForHuman = true;
      sessionManager.save(phone, session);
      await sendWhatsAppMessage(phone, "Entendido! 🙋 Vou chamar um consultor agora. Aguarde um momento.");
      const TEAM_NUMBER = process.env.TEAM_PHONE_NUMBER;
      if (TEAM_NUMBER) {
        const alert = formatHandoffAlert(phone, session, handoffRequest);
        await sendWhatsAppMessage(TEAM_NUMBER, alert);
      }
      return;
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1000,
      messages: [
        { role: "system", content: buildSystemPrompt(catalog) },
        ...session.getHistory()
      ],
    });

    const reply = response.choices[0].message.content;

    session.addMessage("assistant", reply);
    sessionManager.save(phone, session);

    await sendWhatsAppMessage(phone, reply);

    if (/agendar|visita|proposta|interesse|quero ver/i.test(userText)) {
      await new Promise(r => setTimeout(r, 2000));
      await sendWhatsAppMessage(phone, "📅 Posso agendar uma visita sem compromisso! Quer que eu passe para um consultor confirmar o melhor horário?");
    }

  } catch (err) {
    console.error(`[${phone}] Erro:`, err.message);
    await sendWhatsAppMessage(phone, "Desculpe, tive um problema técnico. Pode repetir sua mensagem? 🙏");
  }
});

app.post("/handoff/resolve/:phone", (req, res) => {
  const phone = req.params.phone;
  const session = sessionManager.get(phone);
  session.waitingForHuman = false;
  sessionManager.save(phone, session);
  res.json({ ok: true, message: `Bot reativado para ${phone}` });
});

app.get("/status", (req, res) => {
  res.json({ status: "online", sessions: sessionManager.count(), uptime: process.uptime() });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🤖 Bot imobiliário OpenAI rodando na porta", process.env.PORT || 3000);
});
