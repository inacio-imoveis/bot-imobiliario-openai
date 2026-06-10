import express from "express";
import OpenAI from "openai";
import { catalog } from "./imoveis.js";
import { sessionManager } from "./sessions.js";
import { sendWhatsAppMessage, sendWhatsAppImage } from "./whatsapp.js";
import { buildSystemPrompt } from "./prompt.js";
import { detectHandoffTrigger, formatHandoffAlert } from "./handoff.js";
import { initDB, logMensagem, upsertLead, getConversas, getLeads, getResumo } from "./db.js";
import { transcribeBase64Audio } from "./audio.js";
import { simular, formatarSimulacao } from "./simulador.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

initDB();

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "https://evolution-api-production-8ffe.up.railway.app";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "ed44cb6b57f549bd2e1a9fad756fefd59387fd2962b5748d6939099742ff8640";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "bot-ricardo";

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

// Extrai dados de lead da sessão e tenta montar simulação
function extractLeadData(messages) {
  const history = messages.map(m => m.content).join("\n");
  const lower = history.toLowerCase();
  const data = {};

  const nomeMatch = history.match(/(?:nome completo|nome)[:\s*]+([A-Za-zÀ-ú\s]{5,60})/i);
  if (nomeMatch) data.nome = nomeMatch[1].trim();

  const nascMatch = history.match(/(\d{2}\/\d{2}\/\d{4}|\d{4})/);
  if (nascMatch) data.data_nascimento = nascMatch[1].trim();

  const rendaMatch = history.match(/r\$?\s*([\d.,]+)\s*mil|renda[^R\n]*R\$?\s*([\d.,]+)/i);
  if (rendaMatch) data.renda_mensal = (rendaMatch[1] || rendaMatch[2] || "").trim();

  if (lower.includes("clt") || lower.includes("carteira assinada")) data.tipo_renda = "clt";
  else if (lower.includes("mei")) data.tipo_renda = "mei";
  else if (lower.includes("autônomo") || lower.includes("autonomo") || lower.includes("informal") || lower.includes("renda própria") || lower.includes("renda propria")) data.tipo_renda = "autonomo";
  else if (lower.includes("empresa") || lower.includes("simples") || lower.includes("lucro")) data.tipo_renda = "empresa";

  if (lower.includes("fgts")) data.usa_fgts = true;
  if (lower.includes("casado") || lower.includes("dois compradores") || lower.includes("comprador junto")) data.comprador_conjunto = true;

  return Object.keys(data).length > 0 ? data : null;
}

// Tenta extrair dados suficientes para simular
function trySimular(session, imovelInteresse) {
  const history = session.getHistory().map(m => m.content).join("\n");
  const lower = history.toLowerCase();

  // Renda
  let renda = 0;
  const rendaMatches = [...history.matchAll(/(?:renda|ganho|recebo)[^R\n]*?R?\$?\s*([\d.,]+)\s*(?:mil|k)?/gi)];
  for (const m of rendaMatches) {
    let val = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
    if (val < 500) val *= 1000; // ex: "10 mil" → 10000
    if (val > renda) renda = val;
  }
  // Tenta pegar números simples como "10 mil" ou "10000"
  if (renda === 0) {
    const simples = history.match(/\b(\d+)\s*mil\b/i);
    if (simples) renda = parseFloat(simples[1]) * 1000;
  }

  if (renda === 0) return null;

  // Tipo
  let tipo = "autonomo";
  if (lower.includes("clt") || lower.includes("carteira assinada")) tipo = "clt";
  else if (lower.includes("empresa") || lower.includes("simples nacional")) tipo = "empresa";

  // Idade
  let idade = 35; // padrão
  const nascMatch = history.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (nascMatch) {
    const anoNasc = parseInt(nascMatch[3]);
    idade = new Date().getFullYear() - anoNasc;
  } else {
    const idadeMatch = history.match(/(\d{2})\s*anos/i);
    if (idadeMatch) idade = parseInt(idadeMatch[1]);
  }

  // FGTS
  let fgts = 0;
  if (lower.includes("fgts")) {
    const fgtsMatch = history.match(/fgts[^R\n]*?R?\$?\s*([\d.,]+)/i);
    if (fgtsMatch) {
      fgts = parseFloat(fgtsMatch[1].replace(/\./g, "").replace(",", "."));
      if (fgts < 500) fgts *= 1000;
    }
  }

  // Imóvel de interesse
  let imovelValor = null;
  let imovelNome = null;
  if (imovelInteresse) {
    const imovel = catalog.find(i => i.nome.toLowerCase().includes(imovelInteresse.toLowerCase()));
    if (imovel) {
      // Valor estimado = entrada + financiamento típico (entrada é ~20% do valor)
      imovelValor = imovel.entrada / 0.20;
      imovelNome = imovel.nome;
    }
  }

  return simular({ renda, tipo, idade, fgts, imovelValor, imovelNome });
}

// Busca base64 do áudio
async function getAudioBase64(message) {
  try {
    const resp = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: { "apikey": EVOLUTION_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ message, convertToMp4: false })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.base64 || data?.data?.base64 || null;
  } catch (err) {
    console.error("Erro ao buscar base64:", err.message);
    return null;
  }
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
      const isAudio = !!(msg.audioMessage || msg.pttMessage);

      if (isAudio) {
        console.log(`[${phone}] 🎙️ Áudio recebido — transcrevendo...`);
        const base64 = await getAudioBase64({ key, message: msg });
        if (base64) userText = await transcribeBase64Audio(base64);
        if (!userText) {
          await sendWhatsAppMessage(phone, "Recebi seu áudio, mas não consegui entender. Pode digitar sua mensagem? 😊");
          return;
        }
        console.log(`[${phone}] 🎙️ Transcrição: "${userText}"`);
        await sendWhatsAppMessage(phone, `🎙️ _Entendi: "${userText}"_`);
      } else {
        userText = msg.conversation || msg.extendedTextMessage?.text || msg.text || null;
      }

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

    // Salvar lead
    const leadData = extractLeadData(session.getHistory());
    if (leadData) await upsertLead(phone, leadData);

  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

// Endpoint para Ricardo fazer simulação manualmente e enviar pelo bot
app.post("/simular/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const { renda, tipo, idade, fgts, imovel, nome_cliente } = req.body;

    const imovelObj = catalog.find(i => i.nome.toLowerCase().includes((imovel || "").toLowerCase()));
    const imovelValor = imovelObj ? imovelObj.entrada / 0.20 : null;

    const resultado = simular({
      renda: parseFloat(renda),
      tipo: tipo || "autonomo",
      idade: parseInt(idade) || 35,
      fgts: parseFloat(fgts) || 0,
      imovelValor,
      imovelNome: imovelObj?.nome
    });

    const texto = formatarSimulacao(resultado, nome_cliente);
    await sendWhatsAppMessage(phone, texto);
    await logMensagem(phone, "bot", texto);

    res.json({ ok: true, simulacao: resultado, mensagem: texto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/handoff/resolve/:phone", (req, res) => {
  const phone = req.params.phone;
  const session = sessionManager.get(phone);
  session.waitingForHuman = false;
  sessionManager.save(phone, session);
  res.json({ ok: true, message: `Bot reativado para ${phone}` });
});

app.get("/logs", async (req, res) => { res.json(await getResumo()); });
app.get("/logs/leads", async (req, res) => { res.json(await getLeads()); });
app.get("/logs/conversa/:phone", async (req, res) => { res.json(await getConversas(req.params.phone)); });
app.get("/status", (req, res) => { res.json({ status: "online", sessions: sessionManager.count(), uptime: process.uptime() }); });

app.listen(process.env.PORT || 8080, () => {
  console.log("🤖 Bot imobiliário OpenAI rodando na porta", process.env.PORT || 8080);
});
