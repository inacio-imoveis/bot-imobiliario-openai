import express from "express";
import { readFileSync } from "fs";
import OpenAI from "openai";
import { catalog } from "./imoveis.js";
import { imoveisSimulacao, simular, formatarSimulacao, LINK_AGENDA } from "./simulador.js";
import { sessionManager } from "./sessions.js";
import { sendWhatsAppMessage, sendWhatsAppImage } from "./whatsapp.js";
import { buildSystemPrompt } from "./prompt.js";
import { detectHandoffTrigger, formatHandoffAlert, formatLeadAlert } from "./handoff.js";
import { initDB, logMensagem, upsertLead, getConversas, getLeads, getResumo, getSessionState, saveSessionState, marcarSimulacaoEnviadaTimestamp, getLeadsParaFollowup1, getLeadsParaFollowup2, getLeadsParaFollowup3, getLeadsParaFollowup4, marcarFollowup1Enviado, marcarFollowup2Enviado, marcarFollowup3Enviado, marcarFollowup4Enviado } from "./db.js";
import { transcribeBase64Audio } from "./audio.js";
import { extractLeadComIA, podeSimular, camposFaltantes } from "./leadExtractor.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

initDB();

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || "https://evolution-api-production-8ffe.up.railway.app";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "ed44cb6b57f549bd2e1a9fad756fefd59387fd2962b5748d6939099742ff8640";
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || "bot-ricardo";

// ── DEDUPLICAÇÃO DE WEBHOOK ─────────────────────────────────────────────────
// A Evolution API pode reenviar o mesmo evento MESSAGES_UPSERT mais de uma vez
// (ex: update de status, retry). Sem isso, o bot processa a mesma mensagem
// duas vezes e manda respostas/fotos duplicadas.
const processedMessageIds = new Set();
const MESSAGE_ID_TTL_MS = 10 * 60 * 1000; // 10 minutos
function isDuplicateMessage(id) {
  if (!id) return false;
  if (processedMessageIds.has(id)) return true;
  processedMessageIds.add(id);
  setTimeout(() => processedMessageIds.delete(id), MESSAGE_ID_TTL_MS);
  return false;
}

// ── DETECTORES ──────────────────────────────────────────────────────────────

const PHOTO_KEYWORDS = [
  { key: "botanico",         names: ["botanico"] },
  { key: "della penna",      names: ["della penna", "della", "penna"] },
  { key: "nacoes",           names: ["nacoes", "setor das nacoes"] },
  { key: "pilar dos sonhos", names: ["noroeste", "pilar", "pilar dos sonhos", "sonhos", "atacadao", "portal shopping"] },
  { key: "santa fe",         names: ["santa fe"] },
  { key: "nascer cidadao",   names: ["nascer cidadao", "maternidade", "nascer"] },
];

// Busca imóvel do catálogo por menção no texto (sem exigir a palavra "foto")
function findImovelByText(text) {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const k of PHOTO_KEYWORDS) {
    if (k.names.some(n => lower.includes(n))) {
      return catalog.find(i => i.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(k.key));
    }
  }
  return null;
}

function detectPhotoRequest(text) {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const isFotoRequest = lower.includes("foto") || lower.includes("imagem") || lower.includes("pic") || lower.includes("ver") || lower.includes("manda") || lower.includes("mostra");
  if (!isFotoRequest) return null;
  const found = findImovelByText(text);
  if (found) return found;
  if (lower.includes("foto") || lower.includes("imagem")) return "ASK";
  return null;
}

// Cliente respondeu afirmativamente (ex: "quero", "sim", "pode") sem repetir a palavra "foto"
function isAffirmativeReply(text) {
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  return /^(sim|s|quero|isso|pode|manda|claro|com certeza|positivo|uhum|aham|ok|certo|exato|com certeza|gostaria|bora|vamos|por favor|quero sim|sim quero|isso mesmo|pode sim|pode mandar)\b/.test(lower);
}

// A última mensagem da Ana ofereceu mostrar fotos? (pergunta tipo "quer ver as fotos?")
function ofereceuFotos(text) {
  if (!text) return false;
  const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return lower.includes("foto") && (lower.includes("?") || lower.includes("vou te enviar") || lower.includes("vou enviar"));
}

// Mapeia imovelKey do histórico para item do catálogo
const IMOVELKEY_TO_CATALOG = {
  pilar: "pilar dos sonhos",
  botanico: "botanico",
  della: "della penna",
  nacoes: "nacoes",
  santafe: "santa fe",
  nascer: "nascer cidadao",
};
function findCatalogByImovelKey(imovelKey) {
  const term = IMOVELKEY_TO_CATALOG[imovelKey];
  if (!term) return null;
  return catalog.find(i => i.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(term));
}

// Extrai dados do lead do histórico da sessão
function extractLeadFromHistory(messages) {
  // Considera APENAS mensagens do cliente — nunca as respostas da Ana
  const history = messages.filter(m => m.role === "user").map(m => m.content).join("\n");
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
  // Número solto (ex: "8000") — remove datas para não confundir com ano de nascimento
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
    nascer: ["nascer cidadao", "nascer cidadão", "maternidade", "nascer"],
  };
  for (const [key, terms] of Object.entries(imovelKeys)) {
    if (terms.some(t => lower.includes(t))) { data.imovelKey = key; break; }
  }

  return data;
}

// Salva a sessão em memória e persiste o estado do lead no banco (sobrevive a restarts)
async function saveSession(phone, session) {
  sessionManager.save(phone, session);
  await saveSessionState(phone, {
    leadData: session.leadData,
    simulacaoEnviada: session.simulacaoEnviada,
    handoffAlertaEnviado: session.handoffAlertaEnviado,
    handoffImovelKey: session.handoffImovelKey,
    extractAttemptsAfterHandoff: session.extractAttemptsAfterHandoff,
    lastExtractLen: session.lastExtractLen,
  });
}

// Carrega estado salvo (leadData/flags) e reconstrói histórico recente a partir do banco,
// para sessões novas em memória (ex: depois de um restart/redeploy do Railway)
async function hydrateSession(phone, session) {
  session._hydrated = true;
  try {
    const state = await getSessionState(phone);
    if (state) {
      session.leadData = state.leadData || {};
      session.simulacaoEnviada = state.simulacaoEnviada;
      session.handoffAlertaEnviado = state.handoffAlertaEnviado;
      session.handoffImovelKey = state.handoffImovelKey;
      session.extractAttemptsAfterHandoff = state.extractAttemptsAfterHandoff || 0;
      session.lastExtractLen = state.lastExtractLen || 0;
    }

    if (session.history.length === 0) {
      const conversas = await getConversas(phone, 20);
      const historico = conversas
        .slice()
        .reverse()
        .map(c => ({ role: c.direcao === "cliente" ? "user" : "assistant", content: c.mensagem }));
      session.history = historico.slice(-20);
    }
  } catch (err) {
    console.error(`[${phone}] Erro ao carregar estado da sessão:`, err.message);
  }
}

// Salvar dados no banco a partir do leadData acumulado da sessão
function salvarLead(phone, data) {
  const leadData = {};
  if (data.nome) leadData.nome = data.nome;
  if (data.renda) leadData.renda_mensal = String(data.renda);
  if (data.tipo) leadData.tipo_renda = data.tipo;
  if (data.imovelKey) leadData.imovel_interesse = imoveisSimulacao[data.imovelKey]?.nome;
  if (typeof data.comDependente === "boolean") leadData.dependentes = data.comDependente ? "sim" : "não";
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
      if (isDuplicateMessage(key.id)) {
        console.log(`[webhook] Mensagem duplicada ignorada (id: ${key.id})`);
        return;
      }
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

    // ── AGRUPADOR DE MENSAGENS ──
    // Junta mensagens enviadas em sequência rápida e processa UMA vez só
    bufferMessage(phone, userText);

  } catch (err) {
    console.error("Erro no webhook:", err.message);
  }
});

// ── BUFFER / DEBOUNCE ─────────────────────────────────────────────────────────
const msgBuffers = new Map(); // phone -> { texts: [], timer }
const DEBOUNCE_MS = 6000;
const phoneQueues = new Map(); // phone -> Promise (fila sequencial de handleMessage por telefone)

function bufferMessage(phone, text) {
  let buf = msgBuffers.get(phone);
  if (!buf) {
    buf = { texts: [], timer: null };
    msgBuffers.set(phone, buf);
  }
  buf.texts.push(text);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    const combined = buf.texts.join("\n");
    msgBuffers.delete(phone);
    // Encadeia na fila do telefone — garante que handleMessage nunca rode
    // concorrentemente para o mesmo número, mesmo se o anterior ainda estiver processando.
    const prev = phoneQueues.get(phone) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => handleMessage(phone, combined))
      .catch(err => console.error(`[${phone}] Erro:`, err.message));
    phoneQueues.set(phone, next);
  }, DEBOUNCE_MS);
}

async function handleMessage(phone, userText) {
  console.log(`[${phone}] → ${userText}`);

  await logMensagem(phone, "cliente", userText);

  const session = sessionManager.get(phone);

  // Sessão nova em memória (ex: após restart/redeploy) — recupera estado salvo no banco
  if (!session._hydrated) {
    await hydrateSession(phone, session);
  }

  if (session.isWaitingForHuman()) {
    console.log(`[${phone}] Em espera de atendente — bot pausado.`);
    return;
  }

  session.addMessage("user", userText);

  // Cliente demonstrou interesse em OUTRO imóvel depois de já ter passado pelo
  // ciclo de simulação/alerta — reabre o ciclo pra esse novo imóvel
  if (session.handoffAlertaEnviado) {
    const novoKey = extractLeadFromHistory([{ role: "user", content: userText }]).imovelKey;
    if (novoKey && novoKey !== session.handoffImovelKey) {
      console.log(`[${phone}] 🔄 Novo interesse detectado (${novoKey}) — reabrindo ciclo de simulação/alerta.`);
      session.handoffAlertaEnviado = false;
      session.simulacaoEnviada = false;
      session.handoffImovelKey = null;
      session.extractAttemptsAfterHandoff = 0;
      session.leadData.imovelKey = novoKey;
    }
  }

  // Handoff manual
  const handoffRequest = detectHandoffTrigger(userText);
  if (handoffRequest) {
    session.setWaitingForHuman(true);
    await saveSession(phone, session);
    const msg = "Entendido! 🙋 Vou chamar um consultor agora. Aguarde um momento.";
    await sendWhatsAppMessage(phone, msg);
    await logMensagem(phone, "bot", msg);
    const TEAM_NUMBER = process.env.TEAM_PHONE_NUMBER;
    if (TEAM_NUMBER) await sendWhatsAppMessage(TEAM_NUMBER, formatHandoffAlert(phone, session, handoffRequest));
    return;
  }

  // Fotos
  let imovelComFotos = null;
  if (session.awaitingPhotoChoice) {
    const found = findImovelByText(userText);
    if (found) {
      session.awaitingPhotoChoice = false;
      session.photoChoiceAttempts = 0;
      imovelComFotos = found;
      await saveSession(phone, session);
    } else {
      // Não reconheceu o imóvel — pergunta de novo (até 2x), depois cai no fluxo normal da IA
      session.photoChoiceAttempts = (session.photoChoiceAttempts || 0) + 1;
      if (session.photoChoiceAttempts <= 2) {
        const nomes = catalog.filter(i => i.fotos?.length > 0).map(i => `• ${i.nome}`).join("\n");
        const msgAsk = `Não encontrei esse imóvel na nossa lista 🙏 Pode me dizer o nome certinho?\n\n${nomes}`;
        await sendWhatsAppMessage(phone, msgAsk);
        await logMensagem(phone, "bot", msgAsk);
        session.addMessage("assistant", msgAsk);
        await saveSession(phone, session);
        return;
      } else {
        session.awaitingPhotoChoice = false;
        session.photoChoiceAttempts = 0;
        await saveSession(phone, session);
      }
    }
  }
  if (!imovelComFotos) imovelComFotos = detectPhotoRequest(userText);

  // Cliente respondeu "quero"/"sim"/etc a uma oferta de fotos da Ana (sem repetir "foto")
  if (!imovelComFotos && isAffirmativeReply(userText)) {
    const lastBot = [...session.getHistory()].reverse().find(m => m.role === "assistant");
    if (lastBot && ofereceuFotos(lastBot.content)) {
      const doTexto = findImovelByText(lastBot.content);
      const leadData = extractLeadFromHistory(session.getHistory());
      const doHistorico = leadData.imovelKey ? findCatalogByImovelKey(leadData.imovelKey) : null;
      imovelComFotos = doTexto || doHistorico || "ASK";
    }
  }

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
      session.awaitingPhotoChoice = true;
      await saveSession(phone, session);
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
    await saveSession(phone, session);
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
  await saveSession(phone, session);

  await sendWhatsAppMessage(phone, reply);
  await logMensagem(phone, "bot", reply);

  // ── EXTRAÇÃO DE LEAD + SIMULAÇÃO AUTOMÁTICA ──────────────────────────────
  // Detecta se a IA acabou de coletar (ou tentou coletar) todos os dados
  const frasesColeta = reply.toLowerCase().includes("anotei tudo") ||
                       reply.toLowerCase().includes("aguarde") ||
                       reply.toLowerCase().includes("alguns instantes") ||
                       reply.toLowerCase().includes("nossa equipe vai retornar");

  // Só processa enquanto ainda houver algo pendente (simulação e/ou alerta da equipe).
  // Depois que ambos acontecerem uma vez, não roda mais nada aqui — evita loop e custo extra de IA.
  const MAX_EXTRACT_ATTEMPTS_AFTER_HANDOFF = 3;
  const presoAposHandoff = session.handoffAlertaEnviado && !session.simulacaoEnviada;
  const limiteAtingido = presoAposHandoff && session.extractAttemptsAfterHandoff >= MAX_EXTRACT_ATTEMPTS_AFTER_HANDOFF;

  // Lead "preso" sem dado completo (nunca chegou no handoff): o histórico é truncado em
  // 20 mensagens, então depois de ~10 trocas sem progresso o tamanho fica estável em 20.
  // Se já extraímos com esse mesmo tamanho de histórico e nada mudou, não vale repetir a
  // chamada de IA — evita custo extra sem novidade.
  const historicoMudou = session.getHistory().length !== session.lastExtractLen;

  if ((!session.simulacaoEnviada || !session.handoffAlertaEnviado) && !limiteAtingido && historicoMudou) {
    // Atualiza os dados do lead de forma incremental (sobrevive ao corte do histórico)
    session.leadData = await extractLeadComIA(openai, session.getHistory(), session.leadData);
    session.lastExtractLen = session.getHistory().length;
    salvarLead(phone, session.leadData);
    if (presoAposHandoff) session.extractAttemptsAfterHandoff += 1;

    // 1) Assim que houver dados suficientes, dispara a simulação — somente UMA vez por sessão
    if (!session.simulacaoEnviada && podeSimular(session.leadData)) {
      console.log(`[${phone}] 🧮 Calculando simulação automática...`, session.leadData);
      await new Promise(r => setTimeout(r, 2000)); // pequena pausa dramática

      try {
        const resultado = simular({
          renda: session.leadData.renda,
          cotista: session.leadData.cotista || false,
          comDependente: session.leadData.comDependente || false,
          idade: session.leadData.idade || 35,
          fgts: 0,
          imovelKey: session.leadData.imovelKey,
        });

        const textoSim = formatarSimulacao(resultado, session.leadData.nome || "");
        await sendWhatsAppMessage(phone, textoSim);
        await logMensagem(phone, "bot", textoSim);
        session.addMessage("assistant", "[Simulação enviada automaticamente]");
        session.simulacaoEnviada = true;
        await upsertLead(phone, { agendou: true });
        await marcarSimulacaoEnviadaTimestamp(phone);
      } catch (simErr) {
        console.error(`[${phone}] Erro na simulação:`, simErr.message);
      }
    }

    // 2) Quando a IA sinaliza que terminou a coleta, fecha o ciclo — UMA vez por sessão,
    //    mesmo que a IA repita "anotei tudo"/"aguarde" em mensagens seguintes.
    if (frasesColeta && !session.handoffAlertaEnviado) {
      const faltando = camposFaltantes(session.leadData);

      if (!session.simulacaoEnviada) {
        // Dados insuficientes para simular — avisa o cliente em vez de deixá-lo sem resposta
        const msgFallback = "Só um instante — vou confirmar alguns dados com nossa equipe e já te retorno com a simulação completa por aqui mesmo! 😊";
        await sendWhatsAppMessage(phone, msgFallback);
        await logMensagem(phone, "bot", msgFallback);
        session.addMessage("assistant", msgFallback);
      }

      session.setWaitingForHuman(true);
      session.handoffAlertaEnviado = true;
      session.handoffImovelKey = session.leadData.imovelKey || null;

      const TEAM_NUMBER = process.env.TEAM_PHONE_NUMBER;
      if (TEAM_NUMBER) {
        const alertMsg = formatLeadAlert(phone, session, { simulado: session.simulacaoEnviada, faltando });
        await sendWhatsAppMessage(TEAM_NUMBER, alertMsg);
      }
    }

    await saveSession(phone, session);
  }
}

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

// ── CASCATA DE FOLLOW-UP DE ESCASSEZ/URGÊNCIA (D+1 / D+7 / D+14 / D+30) ──────
// Reforça o senso de urgência para leads que receberam a simulação mas ainda
// não avançaram. Cada etapa só é enviada se o lead NÃO respondeu nada desde a
// simulação (qualquer resposta cancela as próximas etapas). Roda a cada 30 min.

function buildFollowup1(nome, imovel) {
  const primeiroNome = (nome || "").split(" ")[0] || "tudo bem";
  return `Oi ${primeiroNome}! Passando aqui rapidinho 😊\n\n` +
    `Vi que você recebeu a simulação da *${imovel}* — ficou alguma dúvida sobre os valores ou sobre a forma de pagamento?\n\n` +
    `Essa é uma casa pronta e única no nosso catálogo, não queria que você perdesse a chance por falta de informação. Posso te ajudar a agendar a visita agora? 📅\n` +
    `${LINK_AGENDA}`;
}

function buildFollowup2(nome, imovel) {
  const primeiroNome = (nome || "").split(" ")[0] || "tudo bem";
  return `${primeiroNome}, só um aviso: temos tido bastante procura pela *${imovel}* essa semana.\n\n` +
    `Como ela é uma unidade só (não tem outra igual disponível), se você ainda tem interesse, recomendo agendar a visita hoje pra garantir prioridade.\n\n` +
    `📅 ${LINK_AGENDA}\n\n` +
    `Se preferir, me diga e posso te mostrar outras opções parecidas! 😊`;
}

function buildFollowup3(nome, imovel) {
  const primeiroNome = (nome || "").split(" ")[0] || "tudo bem";
  return `Oi ${primeiroNome}! Faz um tempinho que conversamos sobre a *${imovel}*. 😊\n\n` +
    `Ainda tem interesse? Se mudou de ideia ou está procurando algo diferente (outro bairro, valor de entrada, número de quartos), me conta que eu te mostro outras opções do nosso catálogo.\n\n` +
    `E se quiser seguir com essa, é só me chamar pra agendar a visita: 📅 ${LINK_AGENDA}`;
}

function buildFollowup4(nome, imovel) {
  const primeiroNome = (nome || "").split(" ")[0] || "tudo bem";
  return `${primeiroNome}, essa é só uma última mensagem da minha parte sobre a *${imovel}*. 🙂\n\n` +
    `Se ainda fizer sentido pra você, me chama que eu vejo a disponibilidade e agendamos a visita: 📅 ${LINK_AGENDA}\n\n` +
    `Se não for mais o momento, sem problema — qualquer hora que precisar de algo é só falar comigo aqui. 😊`;
}

async function runFollowupJob() {
  try {
    const leads1 = await getLeadsParaFollowup1();
    for (const lead of leads1) {
      const session = sessionManager.get(lead.phone);
      if (session.isWaitingForHuman()) continue; // já em atendimento humano — não interromper
      const msg = buildFollowup1(lead.nome, lead.imovel_interesse || "casa que você simulou");
      await sendWhatsAppMessage(lead.phone, msg);
      await logMensagem(lead.phone, "bot", msg);
      session.addMessage("assistant", "[Follow-up D+1 enviado]");
      await marcarFollowup1Enviado(lead.phone);
      console.log(`[${lead.phone}] 📤 Follow-up D+1 enviado`);
      await new Promise(r => setTimeout(r, 1000));
    }

    const leads2 = await getLeadsParaFollowup2();
    for (const lead of leads2) {
      const session = sessionManager.get(lead.phone);
      if (session.isWaitingForHuman()) continue;
      const msg = buildFollowup2(lead.nome, lead.imovel_interesse || "casa que você simulou");
      await sendWhatsAppMessage(lead.phone, msg);
      await logMensagem(lead.phone, "bot", msg);
      session.addMessage("assistant", "[Follow-up D+7 enviado]");
      await marcarFollowup2Enviado(lead.phone);
      console.log(`[${lead.phone}] 📤 Follow-up D+7 enviado`);
      await new Promise(r => setTimeout(r, 1000));
    }

    const leads3 = await getLeadsParaFollowup3();
    for (const lead of leads3) {
      const session = sessionManager.get(lead.phone);
      if (session.isWaitingForHuman()) continue;
      const msg = buildFollowup3(lead.nome, lead.imovel_interesse || "casa que você simulou");
      await sendWhatsAppMessage(lead.phone, msg);
      await logMensagem(lead.phone, "bot", msg);
      session.addMessage("assistant", "[Follow-up D+14 enviado]");
      await marcarFollowup3Enviado(lead.phone);
      console.log(`[${lead.phone}] 📤 Follow-up D+14 enviado`);
      await new Promise(r => setTimeout(r, 1000));
    }

    const leads4 = await getLeadsParaFollowup4();
    for (const lead of leads4) {
      const session = sessionManager.get(lead.phone);
      if (session.isWaitingForHuman()) continue;
      const msg = buildFollowup4(lead.nome, lead.imovel_interesse || "casa que você simulou");
      await sendWhatsAppMessage(lead.phone, msg);
      await logMensagem(lead.phone, "bot", msg);
      session.addMessage("assistant", "[Follow-up D+30 enviado]");
      await marcarFollowup4Enviado(lead.phone);
      console.log(`[${lead.phone}] 📤 Follow-up D+30 enviado`);
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error("Erro no job de follow-up:", err.message);
  }
}

setInterval(runFollowupJob, 30 * 60 * 1000); // a cada 30 minutos
setTimeout(runFollowupJob, 60 * 1000); // primeira execução após 1 minuto

