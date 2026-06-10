import express from "express";
import OpenAI from "openai";
import { catalog } from "./imoveis.js";
import { sessionManager } from "./sessions.js";
import { sendWhatsAppMessage, sendWhatsAppImage } from "./whatsapp.js";
import { buildSystemPrompt } from "./prompt.js";
import { detectHandoffTrigger, formatHandoffAlert } from "./handoff.js";
import { initDB, logMensagem, upsertLead, getConversas, getLeads, getResumo } from "./db.js";

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Inicializar banco
initDB();

// Detecta pedido de fotos
function detectPhotoRequest(text) {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const keywords = [
    { key: "botanico",           names: ["botanico"] },
    { key: "della penna",        names: ["della penna", "della", "penna"] },
    { key: "nacoes",             names: ["nacoes", "setor das nacoes"] },
    { key: "pilar dos sonhos",   names: ["noroeste", "pilar", "pilar dos sonhos", "sonhos", "atacadao", "portal shopping"] },
    { key: "carolina",           names: ["carolina", "carolina parque", "joao braz"] },
    { key: "monte pascoal",      names: ["monte pascoal", "pascoal"] },
    { key: "santa fe",           names: ["santa fe"] },
  ];

  const isFotoRequest = lower.includes("foto") || lower.includes("imagem") || lower.includes("pic") || lower.includes("ver") || lower.includes("manda") || lower.includes("mostra");
  if (!isFotoRequest) return null;

  for (const k of keywords) {
    if (k.names.some(n => lower.includes(n))) {
      return catalog.find(i => i.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(k.key));
    }
  }
  return null;
}

// Detecta dados de simulação na resposta da IA
function extractLeadData(messages) {
  const history = messages.map(m => m.content).join("\n").toLowerCase();
  const data = {};

  const nomeMatch = history.match(/nome completo[:\s]+([^\n\d]+)/i);
  if (nomeMatch) data.nome = nomeMatch[1].trim().substring(0, 200);

  const nascMatch = history.match(/data de nascimento[:\s]+([^\n]+)/i);
  if (nascMatch) data.data_nascimento = nascMatch[1].trim().substring(0, 50);

  const rendaMatch = history.match(/renda mensal[:\s]+([^\n]+)/i);
  if (rendaMatch) data.renda_mensal = rendaMatch[1].trim().substring(0, 100);

  const tipoMatch = history.match(/(clt|mei|renda informal|autonomo|autonomo)/i);
  if (tipoMatch) data.tipo_renda = tipoMatch[1].trim().substring(0, 100);

  if (history.includes("calendar.app.google")) data.agendou = true;

  return Object.keys(data).length > 0 ? data : null;
}

// Verificação Meta
app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

// Webhook principal
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    let phone, userText;

    if (body?.event === "messages.upsert" || body?.data?.key) {
      const data = body.data || body;
      const key = data.key || {};
      if (key.fromMe === true) return;
      phone = key.remoteJid?.replace("@s.whatsapp.net", "").replace("@g.us", "");
      if (key.remoteJid?.includes("@g.us")) return;
      const msg = data.message || {};
      userText = msg.conversation || msg.extendedTextMessage?.text || msg.text || null;
      if (!userText || !phone) return;
    } else if (body?.entry?.[0]?.changes?.[0]?.value) {
      const entry = body.entry[0].changes[0].value;
      const message = entry?.messages?.[0];
      if (!message || message.type !== "text") return;
      phone = message.from;
      userText = message.text.body.trim();
    } else {
      return;
    }

    userText = userText.trim();
    console.log(`[${phone}] → ${userText}`);

    // Log mensagem do cliente
    await logMensagem(phone, "cliente", userText);

    const session = sessionManager.get(phone);

    if (session.waitingForHuman) {
      console.log(`[${phone}] Em espera de atendente — bot pausado.`);
      return;
    }

    session.addMessage("user", userText);

    // Handoff
    const handoffRequest = detectHandoffTrigger(userText);
    if (handoffRequest) {
      session.waitingForHuman = true;
      sessionManager.save(phone, session);
      const msg = "Entendido! 🙋 Vou chamar um consultor agora. Aguarde um momento.";
      await sendWhatsAppMessage(phone, msg);
      await logMensagem(phone, "bot", msg);
      const TEAM_NUMBER = process.env.TEAM_PHONE_NUMBER;
      if (TEAM_NUMBER) {
        const alert = formatHandoffAlert(phone, session, handoffRequest);
        await sendWhatsAppMessage(TEAM_NUMBER, alert);
      }
      return;
    }

    // Pedido de fotos
    const imovelComFotos = detectPhotoRequest(userText);
    if (imovelComFotos) {
      if (imovelComFotos.fotos && imovelComFotos.fotos.length > 0) {
        const msg1 = `📸 Veja as fotos do *${imovelComFotos.nome}*:`;
        await sendWhatsAppMessage(phone, msg1);
        await logMensagem(phone, "bot", msg1);
        for (const foto of imovelComFotos.fotos) {
          await sendWhatsAppImage(phone, foto);
          await new Promise(r => setTimeout(r, 800));
        }
        const msg2 = `Gostou? 😍 Você pode ver mais detalhes no nosso site:\n🔗 https://ricardoinacioimoveis.com.br/#imoveis\n\nOu posso agendar uma visita pra você conhecer pessoalmente! 🏠`;
        await sendWhatsAppMessage(phone, msg2);
        await logMensagem(phone, "bot", msg2);
        session.addMessage("assistant", `[Enviou ${imovelComFotos.fotos.length} fotos do ${imovelComFotos.nome}]`);
        sessionManager.save(phone, session);
        await upsertLead(phone, { imovel_interesse: imovelComFotos.nome });
        return;
      } else {
        const msg = `Ainda não tenho fotos disponíveis aqui, mas você pode ver mais no nosso site 👇\n🔗 https://ricardoinacioimoveis.com.br/#imoveis\n\nOu posso agendar uma visita pra você conhecer pessoalmente! 🏠😊`;
        await sendWhatsAppMessage(phone, msg);
        await logMensagem(phone, "bot", msg);
        session.addMessage("assistant", `[Informou que não há fotos do ${imovelComFotos.nome}]`);
        sessionManager.save(phone, session);
        return;
      }
    }

    // Resposta da IA
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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
    await logMensagem(phone, "bot", reply);

    // Extrair dados de lead automaticamente
    const leadData = extractLeadData(session.getHistory());
    if (leadData) await upsertLead(phone, leadData);

  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

// Reativar bot após atendimento humano
app.post("/handoff/resolve/:phone", (req, res) => {
  const phone = req.params.phone;
  const session = sessionManager.get(phone);
  session.waitingForHuman = false;
  sessionManager.save(phone, session);
  res.json({ ok: true, message: `Bot reativado para ${phone}` });
});

// ── ENDPOINTS DE LOG ──────────────────────────────────────

// Resumo geral
app.get("/logs", async (req, res) => {
  const resumo = await getResumo();
  res.json(resumo);
});

// Todos os leads
app.get("/logs/leads", async (req, res) => {
  const leads = await getLeads();
  res.json(leads);
});

// Conversa de um número específico
app.get("/logs/conversa/:phone", async (req, res) => {
  const msgs = await getConversas(req.params.phone);
  res.json(msgs);
});

app.get("/status", (req, res) => {
  res.json({ status: "online", sessions: sessionManager.count(), uptime: process.uptime() });
});

app.listen(process.env.PORT || 8080, () => {
  console.log("🤖 Bot imobiliário OpenAI rodando na porta", process.env.PORT || 8080);
});
