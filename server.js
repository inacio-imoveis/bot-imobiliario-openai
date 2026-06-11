import express from "express";
import { readFileSync } from "fs";
import OpenAI from "openai";
import { catalog } from "./imoveis.js";
import { imoveisSimulacao, simular, formatarSimulacao } from "./simulador.js";
import { sessionManager } from "./sessions.js";
import { sendWhatsAppMessage, sendWhatsAppImage } from "./whatsapp.js";
import { buildSystemPrompt } from "./prompt.js";
import { detectHandoffTrigger, formatHandoffAlert } from "./handoff.js";
import { initDB, logMensagem, upsertLead, getConversas, getLeads, getResumo } from "./db.js";
import { transcribeBase64Audio } from "./audio.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

initDB();

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "https://evolution-api-production-8ffe.up.railway.app";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "ed44cb6b57f549bd2e1a9fad756fefd59387fd2962b5748d6939099742ff8640";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "bot-ricardo";

// ── DETECTORES ──────────────────────────────────────────────────────────────

function detectPhotoRequest(text) {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const keywords = [
    { key: "botanico",         names: ["botanico"] },
    { key: "della penna",      names: ["della penna", "della", "penna"] },
    { key: "nacoes",           names: ["nacoes", "setor das nacoes"] },
    { key: "pilar dos sonhos", names: ["noroeste", "pilar", "pilar dos sonhos", "sonhos", "atacadao", "portal shopping"] },
    { key: "carolina",         names: ["carolina", "carolina parque", "joao braz"] },
    { key: "monte pascoal",    names: ["monte pascoal", "pascoal"] },
    { key: "santa fe",         names: ["santa fe"] },
  ];
  const isFotoRequest = lower.includes("foto") || lower.includes("imagem") || lower.includes("pic") || lower.includes("ver") || lower.includes("manda") || lower.includes("mostra");
  if (!isFotoRequest) return null;
  for (const k of keywords) {
    if (k.names.some(n => lower.includes(n))) {
      return catalog.find(i => i.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(k.key));
    }
  }
  // Pediu foto mas não disse qual imóvel
  if (lower.includes("foto") || lower.includes("imagem")) return "ASK";
  return null;
}

// Mapeia imovelKey do histórico para item do catálogo
const IMOVELKEY_TO_CATALOG = {
  pilar: "pilar dos sonhos",
  botanico: "botanico",
  della: "della penna",
  nacoes: "nacoes",
  santafe: "santa fe",
};
function findCatalogByImovelKey(imovelKey) {
  const term = IMOVELKEY_TO_CATALOG[imovelKey];
  if (!term) return null;
  return catalog.find(i => i.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(term));
}

// Extrai dados do lead do histórico da sessão
function extractLeadFromHistory(messages) {
  const history = messages.map(m => m.content).join("\n");
  const lower = history.toLowerCase();
  const data = {};

  // Nome
  const nomeMatch = history.match(/(?:nome completo|nome)[:\s*]+([A-Za-zÀ-ú\s]{5,60})/i);
  if (nomeMatch) data.nome = nomeMatch[1].trim();

  // Data de nascimento / idade
  const nascMatch = history.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (nascMatch) {
    data.data_nascimento = nascMatch[0];
    data.idade = new Date().getFullYear() - parseInt(nascMatch[3]);
  } else {
    const anoMatch = history.match(/\b(19\d{2}|20[0-1]\d)\b/);
    if (anoMatch) data.idade = new Date().getFullYear() - parseInt(anoMatch[1]);
  }

  // Renda — pega o maior valor mencionado
  let renda = 0;
  const rendaPatterns = [
    /r\$\s*([\d.,]+)\s*(?:mil)?/gi,
    /(\d+)\s*mil/gi,
    /renda[^0-9]*(\d[\d.,]*)/gi,
  ];
  for (const pat of rendaPatterns) {
    for (const m of [...history.matchAll(pat)]) {
      let val = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
      if (m[0].toLowerCase().includes("mil") && val < 500) val *= 1000;
      if (val >= 1500 && val <= 20000 && val > renda) renda = val;
    }
  }
  // Número solto (ex: "8000" ou "8.000") — remove datas antes para não confundir com ano de nascimento
  const semDatas = history.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, " ").replace(/\b(19\d{2}|20[0-2]\d)\b/g, " ");
  for (const m of [...semDatas.matchAll(/\b(\d{1,2}\.?\d{3})\b/g)]) {
    const val = parseFloat(m[1].replace(/\./g, ""));
    if (val >= 1500 && val <= 20000 && val > renda) renda = val;
  }
  if (renda > 0) data.renda = renda;

  // Tipo de renda
  if (lower.includes("clt") || lower.includes("carteira assinada")) data.tipo = "clt";
  else if (lower.includes("empresa") || lower.includes("simples nacional") || lower.includes("lucro presumido")) data.tipo = "empresa";
  else if (lower.includes("mei") || lower.includes("autônomo") || lower.includes("autonomo") || lower.includes("informal") || lower.includes("renda própria") || lower.includes("renda propria")) data.tipo = "autonomo";

  // Cotista FGTS
  data.cotista = lower.includes("fgts") && (lower.includes("cotista") || lower.includes("tenho fgts") || lower.includes("sim") || lower.includes("usar fgts"));

  // Dependentes
  data.comDependente = lower.includes("filho") || lower.includes("dependente") || lower.includes("criança");

  // Imóvel de interesse
  const imovelKeys = {
    pilar: ["pilar", "noroeste", "atacadao"],
    botanico: ["botanico", "botânico"],
    della: ["della penna", "della", "penna", "eternit"],
    nacoes: ["nacoes", "nações", "setor das nações"],
    santafe: ["santa fe", "santa fé"],
  };
  for (const [key, terms] of Object.entries(imovelKeys)) {
    if (terms.some(t => lower.includes(t))) { data.imovelKey = key; break; }
  }

  return data;
}

// Verifica se tem dados suficientes para simular
function podeSimular(data) {
  return data.renda > 0 && data.imovelKey && imoveisSimulacao[data.imovelKey];
}

// Salvar dados no banco
function salvarLead(phone, data) {
  const leadData = {};
  if (data.nome) leadData.nome = data.nome;
  if (data.data_nascimento) leadData.data_nascimento = data.data_nascimento;
  if (data.renda) leadData.renda_mensal = String(data.renda);
  if (data.tipo) leadData.tipo_renda = data.tipo;
  if (data.imovelKey) leadData.imovel_interesse = imoveisSimulacao[data.imovelKey]?.nome;
  if (Object.keys(leadData).length > 0) upsertLead(phone, leadData);
}

// ── ÁUDIO ────────────────────────────────────────────────────────────────────

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

// ── WEBHOOK ───────────────────────────────────────────────────────────────────

app.get("/webhook", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

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

    if (session.isWaitingForHuman()) {
      console.log(`[${phone}] Em espera de atendente — bot pausado.`);
      return;
    }

    session.addMessage("user", userText);

    // Handoff manual
    const handoffRequest = detectHandoffTrigger(userText);
    if (handoffRequest) {
      session.setWaitingForHuman(true);
      sessionManager.save(phone, session);
      const msg = "Entendido! 🙋 Vou chamar um consultor agora. Aguarde um momento.";
      await sendWhatsAppMessage(phone, msg);
      await logMensagem(phone, "bot", msg);
      const TEAM_NUMBER = process.env.TEAM_PHONE_NUMBER;
      if (TEAM_NUMBER) await sendWhatsAppMessage(TEAM_NUMBER, formatHandoffAlert(phone, session, handoffRequest));
      return;
    }

    // Fotos
    let imovelComFotos = detectPhotoRequest(userText);
    if (imovelComFotos === "ASK") {
      // Tentar usar o imóvel já mencionado na conversa
      const leadData = extractLeadFromHistory(session.getHistory());
      const doHistorico = leadData.imovelKey ? findCatalogByImovelKey(leadData.imovelKey) : null;
      if (doHistorico) {
        imovelComFotos = doHistorico;
      } else {
        const nomes = catalog.filter(i => i.fotos?.length > 0).map(i => `• ${i.nome}`).join("\n");
        const msgAsk = `De qual imóvel você quer ver as fotos? 😊\n\n${nomes}`;
        await sendWhatsAppMessage(phone, msgAsk);
        await logMensagem(phone, "bot", msgAsk);
        session.addMessage("assistant", msgAsk);
        sessionManager.save(phone, session);
        return;
      }
    }
    if (imovelComFotos) {
      if (imovelComFotos.fotos?.length > 0) {
        const msg1 = `📸 Veja as fotos do *${imovelComFotos.nome}*:`;
        await sendWhatsAppMessage(phone, msg1);
        await logMensagem(phone, "bot", msg1);
        for (const foto of imovelComFotos.fotos) {
          await sendWhatsAppImage(phone, foto);
          await new Promise(r => setTimeout(r, 800));
        }
        const msg2 = `Gostou? 😍 Veja mais no nosso site e siga nosso instagram:\n🔗 https://ricardoinacioimoveis.com.br/#imoveis @ricardoinacioimoveis\nOu posso agendar uma visita pra você conhecer pessoalmente! 🏠`;
        await sendWhatsAppMessage(phone, msg2);
        await logMensagem(phone, "bot", msg2);
        session.addMessage("assistant", `[Enviou ${imovelComFotos.fotos.length} fotos do ${imovelComFotos.nome}]`);
      } else {
        const msg = `Ainda não tenho fotos disponíveis, mas você pode ver no nosso site 👇\n🔗 https://ricardoinacioimoveis.com.br/#imoveis\n\nOu posso agendar uma visita! 🏠😊`;
        await sendWhatsAppMessage(phone, msg);
        await logMensagem(phone, "bot", msg);
        session.addMessage("assistant", `[Sem fotos do ${imovelComFotos.nome}]`);
      }
      sessionManager.save(phone, session);
      await upsertLead(phone, { imovel_interesse: imovelComFotos.nome });
      return;
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

    // ── SIMULAÇÃO AUTOMÁTICA ─────────────────────────────────────────────────
    // Dispara assim que houver dados suficientes (renda + imóvel), independente da frase da IA
    const frasesColeta = reply.toLowerCase().includes("anotei tudo") ||
                         reply.toLowerCase().includes("aguarde") ||
                         reply.toLowerCase().includes("alguns instantes") ||
                         reply.toLowerCase().includes("nossa equipe vai retornar");

    const leadDataCheck = extractLeadFromHistory(session.getHistory());
    const coletouDados = frasesColeta || (podeSimular(leadDataCheck) && !session.simulacaoEnviada);

    if (coletouDados && !session.simulacaoEnviada) {
      const leadData = extractLeadFromHistory(session.getHistory());
      salvarLead(phone, leadData);

      if (podeSimular(leadData)) {
        session.simulacaoEnviada = true;
        console.log(`[${phone}] 🧮 Calculando simulação automática...`, leadData);
        await new Promise(r => setTimeout(r, 2000)); // pequena pausa dramática

        try {
          const resultado = simular({
            renda: leadData.renda,
            cotista: leadData.cotista || false,
            comDependente: leadData.comDependente || false,
            idade: leadData.idade || 35,
            fgts: 0,
            imovelKey: leadData.imovelKey,
          });

          const textoSim = formatarSimulacao(resultado, leadData.nome || "");
          await sendWhatsAppMessage(phone, textoSim);
          await logMensagem(phone, "bot", textoSim);
          session.addMessage("assistant", "[Simulação enviada automaticamente]");
          sessionManager.save(phone, session);
          await upsertLead(phone, { agendou: true });
        } catch (simErr) {
          console.error(`[${phone}] Erro na simulação:`, simErr.message);
        }
      }

      // Handoff automático após coleta
      session.setWaitingForHuman(true);
      sessionManager.save(phone, session);
      const TEAM_NUMBER = process.env.TEAM_PHONE_NUMBER;
      if (TEAM_NUMBER) {
        const leadData2 = extractLeadFromHistory(session.getHistory());
        const alertMsg = formatHandoffAlert(phone, session, "dados_coletados");
        await sendWhatsAppMessage(TEAM_NUMBER, alertMsg);
      }
    }

  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────

app.get("/painel", (req, res) => {
  const html = readFileSync("./painel.html", "utf8");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.post("/simular/:phone", async (req, res) => {
  try {
    const { phone } = req.params;
    const { texto_customizado, nome_cliente } = req.body;
    const phone55 = phone.startsWith("55") ? phone : `55${phone}`;
    await sendWhatsAppMessage(phone55, texto_customizado);
    await logMensagem(phone55, "bot", texto_customizado);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function resolveHandoff(phone) {
  const session = sessionManager.get(phone);
  session.setWaitingForHuman(false);
  sessionManager.save(phone, session);
}

app.post("/handoff/resolve/:phone", (req, res) => {
  resolveHandoff(req.params.phone);
  res.json({ ok: true, message: `Bot reativado para ${req.params.phone}` });
});

// Versão GET — funciona direto pelo navegador
app.get("/handoff/resolve/:phone", (req, res) => {
  resolveHandoff(req.params.phone);
  res.json({ ok: true, message: `Bot reativado para ${req.params.phone}` });
});

// Reset total de sessões — funciona direto pelo navegador
app.get("/reset-sessoes", (req, res) => {
  const n = sessionManager.resetAll();
  res.json({ ok: true, message: `${n} sessões zeradas. Bot respondendo todos do zero.` });
});

app.get("/logs", async (req, res) => { res.json(await getResumo()); });
app.get("/logs/leads", async (req, res) => { res.json(await getLeads()); });
app.get("/logs/conversa/:phone", async (req, res) => { res.json(await getConversas(req.params.phone)); });
app.get("/status", (req, res) => { res.json({ status: "online", sessions: sessionManager.count(), uptime: process.uptime() }); });

app.listen(process.env.PORT || 8080, () => {
  console.log("🤖 Bot imobiliário OpenAI rodando na porta", process.env.PORT || 8080);
});
