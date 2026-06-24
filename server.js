import express from "express";
import { readFileSync } from "fs";
import OpenAI from "openai";
import { catalog } from "./imoveis.js";
import { imoveisSimulacao, simular, formatarSimulacao, LINK_AGENDA } from "./simulador.js";
import { sessionManager } from "./sessions.js";
import { sendWhatsAppMessage, sendWhatsAppImage, isBotMessageId, isWithinBotSendCooldown } from "./whatsapp.js";
import { buildSystemPrompt, MSG_CAROLINA_PERFIL } from "./prompt.js";
import { detectHandoffTrigger, formatHandoffAlert, formatLeadAlert, formatEstagioAlert } from "./handoff.js";
import { initDB, logMensagem, upsertLead, getConversas, getLeads, getResumo, getSessionState, saveSessionState, marcarSimulacaoEnviadaTimestamp, getLeadsParaFollowup1, getLeadsParaFollowup2, getLeadsParaFollowup3, getLeadsParaFollowup4, marcarFollowup1Enviado, marcarFollowup2Enviado, marcarFollowup3Enviado, marcarFollowup4Enviado, listarFaqs, criarFaq, atualizarFaq, excluirFaq, buscarFaqSimilar, registrarUsoFaq, listarUsosFaq } from "./db.js";
import { transcribeBase64Audio } from "./audio.js";
import { extractLeadComIA, podeSimular, camposFaltantes } from "./leadExtractor.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Gera embedding de um texto via OpenAI (usado na faq_base: cadastro e busca).
// Modelo pequeno e barato — suficiente pra comparar perguntas curtas de FAQ.
async function gerarEmbedding(texto) {
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texto,
  });
  return resp.data[0].embedding;
}

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

// Normaliza texto de ENTRADA do cliente para busca de keyword: minúsculas, remove
// acentos, e troca separadores (hífen, underscore, barra, pontos) por espaço.
// Os separadores importam porque leads vindos do site chegam como URL
// (ex: "...casa-2-quartos-monte-pascoal-goiania"), onde o nome do imóvel está colado
// por hífens — sem essa troca, "monte pascoal" (com espaço) nunca casaria com
// "monte-pascoal" (com hífen) e o lead do site não seria reconhecido.
function normalizarTexto(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-_/.]+/g, " ");
}

// names: keywords fortes (nome/bairro/empreendimento, identificam o imóvel sozinhas).
// weak:  keywords fracas/ambíguas (diferenciais genéricos como "mega quintal", ou
//        termos parciais como "carolina"/"penna") que aparecem em vários imóveis ou
//        em frases casuais — só valem se nenhuma keyword forte de outro imóvel casar.
// O match (findImovelByText) escolhe: forte ganha de fraca; entre iguais, a mais longa.
const PHOTO_KEYWORDS = [
  { key: "botanico",         names: ["botanico"] },
  { key: "della penna",      names: ["della penna"], weak: ["della", "penna"] },
  { key: "nacoes",           names: ["nacoes", "setor das nacoes"] },
  { key: "pilar dos sonhos", names: ["pilar dos sonhos", "setor pilar"], weak: ["noroeste", "pilar", "sonhos", "atacadao", "portal shopping"] },
  { key: "santa fe",         names: ["santa fe"] },
  { key: "nascer cidadao",   names: ["nascer cidadao", "maternidade nascer"], weak: ["maternidade", "nascer"] },
  { key: "buena vista",      names: ["buena vista", "buenavista"] },
  { key: "eldorado oeste",   names: ["eldorado oeste", "eldorado"], weak: ["vera cruz", "vera cruz 2"] },
  { key: "esquina",          names: ["casa de esquina", "casa esquina", "eldorado esquina"], weak: ["esquina", "mega quintal"] },
  { key: "monte pascoal",    names: ["monte pascoal", "montepascoal"], weak: ["shopping america"] },
  { key: "carolina parque",  names: ["carolina parque", "privilege mrv", "mrv carolina"], weak: ["carolina", "privilege"] },
];

// Busca imóvel do catálogo por menção no texto (sem exigir a palavra "foto").
// Coleta TODOS os matches e escolhe o mais específico: keyword forte tem prioridade
// sobre fraca; entre keywords do mesmo nível, a mais longa (mais específica) vence.
// Isso evita que termos genéricos ("mega quintal", "vera cruz") sequestrem um anúncio
// que também traz o nome do imóvel certo (ex: "Monte Pascoal com mega quintal").
function findImovelByText(text) {
  const lower = normalizarTexto(text);
  let melhor = null; // { key, strong, len }
  for (const k of PHOTO_KEYWORDS) {
    const fortes = k.names || [];
    const fracas = k.weak || [];
    const hitForte = fortes.filter(n => lower.includes(n)).sort((a, b) => b.length - a.length)[0];
    const hitFraca = fracas.filter(n => lower.includes(n)).sort((a, b) => b.length - a.length)[0];
    let cand = null;
    if (hitForte) cand = { key: k.key, strong: true, len: hitForte.length };
    else if (hitFraca) cand = { key: k.key, strong: false, len: hitFraca.length };
    if (!cand) continue;
    if (!melhor
        || (cand.strong && !melhor.strong)
        || (cand.strong === melhor.strong && cand.len > melhor.len)) {
      melhor = cand;
    }
  }
  if (!melhor) return null;
  return catalog.find(i => i.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(melhor.key));
}

// Keywords FORTES para a abertura focada na 1ª mensagem de TEXTO LIVRE (sem anúncio).
// Versão deliberadamente mais restrita que PHOTO_KEYWORDS: aqui o cliente ainda não
// está em contexto de imóvel, então só disparamos com menção inequívoca (nome/bairro).
// Palavras genéricas soltas ("esquina", "carolina", "mega quintal", "penna", "sonhos",
// "nascer", "maternidade", "shopping america") foram propositalmente OMITIDAS porque
// aparecem em frases casuais e causariam abertura focada errada. Quando o lead vem de
// anúncio (marcador [ANÚNCIO:...]), usamos findImovelByText (permissivo) em vez desta.
const STRONG_IMOVEL_KEYWORDS = [
  { key: "botanico",         names: ["botanico"] },
  { key: "della penna",      names: ["della penna"] },
  { key: "nacoes",           names: ["setor das nacoes"] },
  { key: "pilar dos sonhos", names: ["pilar dos sonhos", "setor pilar"] },
  { key: "santa fe",         names: ["santa fe"] },
  { key: "nascer cidadao",   names: ["nascer cidadao", "maternidade nascer"] },
  { key: "buena vista",      names: ["buena vista", "buenavista"] },
  { key: "eldorado oeste",   names: ["eldorado oeste", "eldorado", "vera cruz"] },
  { key: "esquina",          names: ["casa de esquina", "casa esquina", "eldorado esquina"] },
  { key: "monte pascoal",    names: ["monte pascoal", "montepascoal"] },
  { key: "carolina parque",  names: ["carolina parque", "privilege mrv", "mrv carolina"] },
];

function findImovelStrong(text) {
  const lower = normalizarTexto(text);
  for (const k of STRONG_IMOVEL_KEYWORDS) {
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
  buenavista: "buena vista",
  eldorado: "eldorado oeste",
  eldoradoesquina: "esquina",
  montepascoal: "monte pascoal",
  carolinaparque: "carolina parque",
};
function findCatalogByImovelKey(imovelKey) {
  const term = IMOVELKEY_TO_CATALOG[imovelKey];
  if (!term) return null;
  return catalog.find(i => i.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(term));
}

// Dado um item do catálogo, devolve a chave curta (buenavista, eldorado, etc.)
// usada pelo simulador/extrator. Reaproveita IMOVELKEY_TO_CATALOG para não
// duplicar mapeamento — fonte única de verdade.
function imovelKeyFromCatalog(item) {
  if (!item) return null;
  const nomeNorm = item.nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  for (const [key, term] of Object.entries(IMOVELKEY_TO_CATALOG)) {
    if (nomeNorm.includes(term)) return key;
  }
  return null;
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
    buenavista: ["buena vista", "buenavista"],
    eldorado: ["eldorado oeste", "eldorado", "vera cruz 2", "vera cruz"],
    eldoradoesquina: ["casa de esquina", "casa esquina", "mega quintal"],
    montepascoal: ["monte pascoal", "montepascoal", "shopping america", "shopping américa"],
    carolinaparque: ["carolina parque", "carolina", "privilege", "privilege mrv", "mrv carolina"],
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
    coletaIniciada: session.coletaIniciada,
    estagioAlertaEnviado: session.estagioAlertaEnviado,
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
      session.coletaIniciada = state.coletaIniciada || false;
      session.estagioAlertaEnviado = state.estagioAlertaEnviado || false;
      session.lastCrmSnapshot = state.lastCrmSnapshot || null;
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
// Só sincroniza com o CRM quando o conteúdo do lead muda de fato — evita criar um
// registro novo no CRM a cada extração quando o cliente não informou nada novo.
function salvarLead(phone, data, session) {
  const leadData = {};
  if (data.nome) leadData.nome = data.nome;
  if (data.renda) leadData.renda_mensal = String(data.renda);
  if (data.tipo) leadData.tipo_renda = data.tipo;
  if (data.imovelKey) leadData.imovel_interesse = imoveisSimulacao[data.imovelKey]?.nome;
  if (typeof data.comDependente === "boolean") leadData.dependentes = data.comDependente ? "sim" : "não";
  if (Object.keys(leadData).length > 0) {
    upsertLead(phone, leadData);
    if (data.nome) {
      const snapshot = JSON.stringify({
        nome: data.nome,
        imovelKey: data.imovelKey || null,
        renda: data.renda || null,
        tipo: data.tipo || null,
        comDependente: data.comDependente ?? null,
      });
      if (!session || session.lastCrmSnapshot !== snapshot) {
        enviarLeadAoCRM(phone, data).catch(e => console.error("[CRM]", e.message));
        if (session) session.lastCrmSnapshot = snapshot;
      }
    }
  }
}


// CRM — envia lead ao CRM imobiliário quando tiver nome + telefone
async function enviarLeadAoCRM(phone, leadData) {
  try {
    const CRM_URL = process.env.CRM_URL || "https://crm-imobiliario-production-90ec.up.railway.app";
    const nome = leadData.nome;
    if (!nome) return; // sem nome não envia
    // Formatar telefone: remover o "55" do prefixo brasileiro para exibição
    const foneDisplay = phone.replace(/^55/, "");
    const imovelNome = leadData.imovelKey
      ? (imoveisSimulacao[leadData.imovelKey]?.nome || leadData.imovelKey)
      : null;
    const obs = [
      leadData.renda ? `Renda: R$ ${Number(leadData.renda).toLocaleString("pt-BR")}` : null,
      leadData.tipo   ? `Tipo renda: ${leadData.tipo}` : null,
      leadData.comDependente !== undefined ? `Dependentes: ${leadData.comDependente ? "sim" : "não"}` : null,
      "Origem: WhatsApp Bot Ana"
    ].filter(Boolean).join(" | ");

    const payload = {
      nome,
      fone: foneDisplay,
      imovel: imovelNome || "Não informado",
      observacoes: obs
    };

    const resp = await fetch(`${CRM_URL}/api/leads/publico`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    console.log(`[CRM] Lead enviado: ${nome} (${foneDisplay}) →`, JSON.stringify(data));
  } catch (e) {
    console.error("[CRM] Erro ao enviar lead:", e.message);
  }
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

      if (key.fromMe === true) {
        // Toda mensagem enviada pela instância (Ana OU corretor digitando manualmente
        // no mesmo número) chega aqui como fromMe:true. Se o id NÃO está registrado
        // como mensagem da Ana, foi um humano que digitou direto no WhatsApp — o
        // corretor assumiu a conversa. Pausa a Ana automaticamente pra esse contato,
        // igual já acontece no handoff manual/automático.
        const phoneCorretor = key.remoteJid?.replace("@s.whatsapp.net", "").replace("@g.us", "");
        const pareceMensagemManual = !isBotMessageId(key.id) &&
          !(phoneCorretor && isWithinBotSendCooldown(phoneCorretor)); // 2ª camada: ignora eco recente da própria Ana mesmo sem id
        if (pareceMensagemManual) {
          if (phoneCorretor && !key.remoteJid?.includes("@g.us")) {
            const session = sessionManager.get(phoneCorretor);
            // Hidrata antes de salvar — senão uma sessão nova em memória (ex: após
            // restart) sobrescreveria leadData/flags já persistidos no banco com
            // valores em branco.
            if (!session._hydrated) await hydrateSession(phoneCorretor, session);
            if (!session.isWaitingForHuman()) {
              session.setWaitingForHuman(true);
              await saveSession(phoneCorretor, session);
              console.log(`[${phoneCorretor}] 🙋 Corretor assumiu a conversa manualmente — Ana pausada.`);
            }
          }
        }
        return;
      }

      if (isDuplicateMessage(key.id)) {
        console.log(`[webhook] Mensagem duplicada ignorada (id: ${key.id})`);
        return;
      }
      phone = key.remoteJid?.replace("@s.whatsapp.net", "").replace("@g.us", "");
      if (key.remoteJid?.includes("@g.us")) return;

      const msg = data.message || {};
      const isAudio = !!(msg.audioMessage || msg.pttMessage);
      const isDocument = !!msg.documentMessage;
      // imageMessage sem legenda (caption) também é tratada como possível anexo de
      // currículo (foto do currículo impresso/printado) — com legenda, o texto da
      // legenda já seria capturado normalmente como userText mais abaixo.
      const isImageNoCaption = !!msg.imageMessage && !msg.imageMessage?.caption;

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
      } else if (isDocument || isImageNoCaption) {
        // Antes, documentMessage/imageMessage sem texto chegavam aqui sem userText e
        // eram silenciosamente descartadas (return na checagem abaixo) — candidatos
        // mandando currículo em PDF/foto nunca recebiam resposta nem eram notificados.
        // Convertemos num texto sintético para a IA reconhecer o anexo e responder
        // conforme o fluxo de vaga de estágio (item 0 do prompt).
        const nomeArquivo = msg.documentMessage?.fileName || null;
        userText = isDocument
          ? `[ANEXO RECEBIDO: documento${nomeArquivo ? ` "${nomeArquivo}"` : ""} — provável currículo em PDF]`
          : `[ANEXO RECEBIDO: imagem sem legenda — provável foto de currículo]`;
        console.log(`[${phone}] 📎 Anexo recebido (${isDocument ? "documento" : "imagem"}), tratado como possível currículo.`);
      } else {
        userText =
          msg.conversation ||
          msg.extendedTextMessage?.text ||
          msg.text ||
          // Mensagens de botão/template vindas de anúncios (Instagram/Facebook Ads)
          msg.buttonsResponseMessage?.selectedDisplayText ||
          msg.templateButtonReplyMessage?.selectedDisplayText ||
          msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
          msg.listResponseMessage?.title ||
          // legenda de imagem/documento (quando enviado COM legenda)
          msg.imageMessage?.caption ||
          msg.documentMessage?.caption ||
          null;
        // Se era JSON de paramsJson, tenta extrair texto legível
        if (userText && userText.startsWith('{')) {
          try { const p = JSON.parse(userText); userText = p.id || p.name || p.display_text || userText; } catch {}
        }
        // Enriquecer userText com dados do link preview ou anúncio externo (Instagram/Facebook Ads)
        // quando o texto seja só uma URL ou vazio — assim a Ana consegue identificar o imóvel pelo título/descrição
        const ext = msg.extendedTextMessage;
        if (ext) {
          const previewTitle = ext.title || ext.contextInfo?.externalAdReply?.title || "";
          const previewDesc  = ext.description || ext.contextInfo?.externalAdReply?.body || "";
          const previewUrl   = ext.matchedText || ext.canonicalUrl || ext.contextInfo?.externalAdReply?.sourceUrl || "";
          const extra = [previewTitle, previewDesc, previewUrl].filter(Boolean).join(" | ");
          if (extra) {
            const isJustUrl = !userText || /^https?:\/\/\S+$/.test((userText || "").trim());
            if (isJustUrl) {
              userText = `[LINK COMPARTILHADO: ${extra}]`;
            } else {
              userText = `${userText} [contexto: ${extra}]`;
            }
            console.log(`[${phone}] 🔗 Link preview enriquecido: "${userText}"`);
          }
        }
        // Anúncio externo sem extendedTextMessage (ex: orderMessage / catalogMessage do Meta)
        const adReply = msg.contextInfo?.externalAdReply;
        if (!ext && adReply) {
          const adExtra = [adReply.title, adReply.body, adReply.sourceUrl].filter(Boolean).join(" | ");
          if (adExtra) {
            userText = userText ? `${userText} [anúncio: ${adExtra}]` : `[ANÚNCIO: ${adExtra}]`;
            console.log(`[${phone}] 📢 Anúncio externo detectado: "${userText}"`);
          }
        }
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

  // ── GATILHO DE SAUDAÇÃO INICIAL (Regra Alessandra) ───────────────────────
  // Se a sessão está no início (sem histórico de resposta da Ana ainda),
  // e o cliente enviou uma saudação genérica ou frase de interesse vinda de anúncio,
  // responde IMEDIATAMENTE com a apresentação da Ana sem passar pelo GPT.
  // Isso garante que nenhum lead vindo de anúncio fique sem resposta.
  const isFirstContact = session.getHistory().filter(m => m.role === "assistant").length === 0;
  if (isFirstContact) {
    const textLower = userText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    // ── NOVO: Detector de imóvel específico na primeira mensagem ──────────────
    // Se o cliente já mencionou um imóvel específico (ex: "Quanto fica Buena Vista?")
    // pula o menu genérico e vai direto para apresentação focada daquele imóvel.
    //
    // O quão permissivo é o match depende da ORIGEM da mensagem:
    // - Veio de anúncio/link do Meta (marcador [ANÚNCIO:...]/[LINK...]/[contexto:...]
    //   injetado no webhook): contexto confiável -> match permissivo (findImovelByText),
    //   aceita keywords do criativo como "mega quintal", "esquina", "carolina".
    // - Texto livre puro (cliente digitou do nada): match estrito (findImovelStrong),
    //   só nome/bairro inequívoco, pra não disparar abertura errada com palavra solta.
    const veioDeAnuncio = /\[(anuncio|anúncio|link compartilhado|contexto):/i.test(userText);
    const imovelMencionado = veioDeAnuncio
      ? findImovelByText(userText)
      : findImovelStrong(userText);
    if (imovelMencionado) {
      const keyCurta = imovelKeyFromCatalog(imovelMencionado);
      const isCarolinaParque = keyCurta === "carolinaparque";

      const rendaTexto = imovelMencionado.renda_minima 
        ? ` • Renda mínima: R$ ${imovelMencionado.renda_minima.toLocaleString("pt-BR")}`
        : "";
      const diferenciais = imovelMencionado.diferenciais.map(d => `  ✅ ${d}`).join("\n");

      let msgFocada;
      if (isCarolinaParque) {
        // Regra Carolina Parque (ver item correspondente no prompt.js):
        // NUNCA simulação automática nem valor fixo. Apresenta o imóvel e
        // coleta o perfil para o corretor confirmar a tabela. O texto do fecho
        // vem de MSG_CAROLINA_PERFIL (fonte única, compartilhada com o prompt).
        msgFocada =
          `Olá! 👋 Vi que você se interessou no *${imovelMencionado.nome}*!\n\n` +
          `📍 ${imovelMencionado.bairro} — ${imovelMencionado.referencia}\n\n` +
          `${diferenciais}\n\n` +
          `${imovelMencionado.descricao}\n\n` +
          `${MSG_CAROLINA_PERFIL} 😊`;
      } else {
        const entradaTexto = typeof imovelMencionado.entrada === "number"
          ? `R$ ${imovelMencionado.entrada.toLocaleString("pt-BR")}`
          : imovelMencionado.entrada;
        msgFocada =
          `Olá! 👋 Vi que você se interessou na *${imovelMencionado.nome}*!\n\n` +
          `📍 ${imovelMencionado.bairro} — ${imovelMencionado.referencia}\n` +
          `🔑 Entrada a partir de ${entradaTexto}${rendaTexto}\n\n` +
          `${diferenciais}\n\n` +
          `${imovelMencionado.descricao}\n\n` +
          `Quer que eu faça uma simulação personalizada das parcelas para seu perfil? 😊`;
      }

      await sendWhatsAppMessage(phone, msgFocada);
      await logMensagem(phone, "bot", msgFocada);
      session.addMessage("assistant", msgFocada);
      
      // Registra o imóvel no lead para contexto futuro
      const leadData = session.leadData || {};
      if (keyCurta) leadData.imovelKey = keyCurta;
      session.leadData = leadData;
      
      await saveSession(phone, session);
      console.log(`[${phone}] ✅ Imóvel detectado na 1ª mensagem: ${imovelMencionado.nome}${isCarolinaParque ? " (Carolina Parque — sem simulação)" : ""}`);
      return;
    }
    // ── FIM do detector de imóvel específico ───────────────────────────────────
    
    const saudacaoKeywords = [
      "tenho interesse", "quero mais informacoes", "gostaria de saber mais",
      "vi o anuncio", "ainda esta disponivel", "ainda disponivel",
      "ola", "oi", "bom dia", "boa tarde", "boa noite",
      "quero saber", "me interessa", "gostei", "vi o anuncio",
      "como podemos ajudar", "quero informacoes", "mais informacoes",
      "interessado", "interessada"
    ];
    const isSaudacao = saudacaoKeywords.some(k => textLower.includes(k));
    if (isSaudacao) {
      const msgSaudacao =
        "Olá! 😊 Seja bem-vindo(a) à Ricardo Inácio Imóveis.\n\n" +
        "Eu sou a Ana, assistente virtual.\n\n" +
        "Para te atender melhor, me diz:\n\n" +
        "*1️⃣* – Tenho interesse em *imóveis*\n" +
        "*2️⃣* – Tenho interesse na *vaga de estágio*";
      await sendWhatsAppMessage(phone, msgSaudacao);
      await logMensagem(phone, "bot", msgSaudacao);
      session.addMessage("assistant", msgSaudacao);
      await saveSession(phone, session);
      console.log(`[${phone}] ✅ Gatilho saudação inicial disparado (menu 1/2)`);
      return;
    }
  }
  // ── FIM DO GATILHO DE SAUDAÇÃO INICIAL ───────────────────────────────────

  // ── RESPOSTA AO MENU 1/2 ─────────────────────────────────────────────────
  {
    const histAssistant = session.getHistory().filter(m => m.role === "assistant");
    const lastBotMsg = histAssistant.length > 0 ? histAssistant[histAssistant.length - 1].content : "";
    const isMenuContext = lastBotMsg.includes("1️⃣") && lastBotMsg.includes("2️⃣");
    if (isMenuContext) {
      const textLowerMenu = userText.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      // Detecta a escolha "1" mesmo quando o cliente mandou outras mensagens junto
      // (o buffer/debounce pode combinar "Quanto fica as parcelas?\n1" num texto só).
      // \b1\b casa o dígito isolado em qualquer linha do texto combinado.
      const escolheu1 = /(^|\n|\s)1($|\n|\s|[.)º°]|$)/.test(textLowerMenu);
      const escolheu2 = /(^|\n|\s)2($|\n|\s|[.)º°]|$)/.test(textLowerMenu);
      const menuImovel = escolheu1 || /im[oó]vel|im[oó]veis|comprar|financiar|apartamento|casa/.test(textLowerMenu);
      const menuEstagio = escolheu2 || /est[aá]gio|vaga|curriculo|engenharia/.test(textLowerMenu);
      // Cliente já demonstrou interesse em valores/parcelas/simulação junto com a escolha
      const perguntouSimulacao = /parcela|quanto fica|quanto custa|quanto sai|financiamento|simula|valor|entrada|presta[cç]/.test(textLowerMenu);

      if (menuImovel) {
        const msgImovel = perguntouSimulacao
          ? "Perfeito! 😊 Pra te passar certinho os valores e as parcelas, primeiro me diz:\n\n" +
            "Qual foi o imóvel que você viu?"
          : "Ótimo! 😊 Vou te ajudar com informações sobre nossos imóveis.\n\n" +
            "Qual foi o imóvel que você viu?";
        await sendWhatsAppMessage(phone, msgImovel);
        await logMensagem(phone, "bot", msgImovel);
        session.addMessage("assistant", msgImovel);
        await saveSession(phone, session);
        console.log(`[${phone}] ✅ Menu → fluxo imóvel`);
        return;
      }

      if (menuEstagio) {
        const msgEstagio =
          "Ótimo! 😊 Vou te passar para o fluxo de seleção.\n\n" +
          "Você está cursando Engenharia Civil atualmente?";
        await sendWhatsAppMessage(phone, msgEstagio);
        await logMensagem(phone, "bot", msgEstagio);
        session.addMessage("assistant", msgEstagio);
        await saveSession(phone, session);
        console.log(`[${phone}] ✅ Menu → fluxo estágio`);
        return;
      }
    }
  }
  // ── FIM DA RESPOSTA AO MENU 1/2 ──────────────────────────────────────────

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

  // FAQ curada: busca se a última mensagem do cliente bate com alguma
  // pergunta já aprovada por você. Se bater, a resposta vira contexto
  // prioritário pra Ana — ela ainda escreve com o próprio tom, mas a
  // informação vem da base aprovada, não inventada.
  let faqContext = "";
  try {
    const embeddingPergunta = await gerarEmbedding(userText);
    const faqEncontrada = await buscarFaqSimilar(embeddingPergunta);
    if (faqEncontrada) {
      faqContext = `\n\nINFORMAÇÃO APROVADA PARA ESTA PERGUNTA (use como base, adapte o tom mas não mude o conteúdo):\n"${faqEncontrada.resposta}"`;
      // Não bloqueia a resposta se o log falhar — é auditoria, não crítico.
      registrarUsoFaq({
        faqId: faqEncontrada.id,
        phone,
        mensagemCliente: userText,
        score: faqEncontrada.score,
      }).catch(err => console.error("Erro ao registrar uso de FAQ:", err.message));
    }
  } catch (err) {
    console.error("Erro ao buscar FAQ (seguindo sem ela):", err.message);
  }

  // Imóvel ativo da sessão: se já sabemos qual imóvel o cliente está discutindo,
  // reforça isso explicitamente para a IA. Sem isso, uma mensagem curta e ambígua
  // (ex: "3 quartos") pode ser interpretada como pedido de outro imóvel do catálogo,
  // mesmo quando o cliente só está descrevendo o imóvel que já estava sendo discutido.
  let imovelAtivoContext = "";
  const imovelAtivo = session.leadData?.imovelKey ? findCatalogByImovelKey(session.leadData.imovelKey) : null;
  if (imovelAtivo) {
    imovelAtivoContext = `\n\nIMÓVEL ATIVO NESTA CONVERSA: "${imovelAtivo.nome}". O cliente já está conversando sobre esse imóvel. Se a próxima mensagem do cliente for curta, ambígua, ou puder ser uma característica/confirmação desse mesmo imóvel (ex: número de quartos, bairro, valor), trate como referência ao IMÓVEL ATIVO — não troque de imóvel sozinha. Só mude para outro imóvel do catálogo se o cliente mencionar claramente um nome, bairro ou referência diferente do imóvel ativo. Em caso de dúvida real, pergunte para confirmar em vez de assumir outro imóvel.`;
  }

  // Resposta da IA
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1000,
    messages: [
      { role: "system", content: buildSystemPrompt(catalog) + faqContext + imovelAtivoContext },
      ...session.getHistory()
    ],
  });

  const reply = response.choices[0].message.content;
  session.addMessage("assistant", reply);

  // Marca que a coleta de dados foi de fato iniciada pela Ana — usado como trava extra
  // para a simulação automática (ver podeSimular). "LGPD" só aparece no aviso de
  // privacidade obrigatório que precede a coleta dos 6 dados (item 7 do prompt), então é
  // um marcador confiável de que esse fluxo realmente começou nesta conversa.
  if (!session.coletaIniciada && reply.includes("LGPD")) {
    session.coletaIniciada = true;
  }

  // Notifica o time quando a Ana confirma recebimento de currículo da vaga de estágio
  // (item 0 do prompt) — mesma ideia do alerta de lead de imóvel, mas para candidatura.
  // "Recebemos seu currículo" é o trecho fixo da mensagem de confirmação definida no
  // prompt, usado aqui como marcador confiável. Dispara só uma vez por sessão.
  if (!session.estagioAlertaEnviado && reply.includes("Recebemos seu currículo")) {
    session.estagioAlertaEnviado = true;
    const TEAM_NUMBER = process.env.TEAM_PHONE_NUMBER;
    if (TEAM_NUMBER) {
      await sendWhatsAppMessage(TEAM_NUMBER, formatEstagioAlert(phone, session));
    }
  }

  await saveSession(phone, session);

  await sendWhatsAppMessage(phone, reply);
  await logMensagem(phone, "bot", reply);

  // Se a Ana transferiu para especialista por não identificar imóvel ou loop de perguntas,
  // seta waitingForHuman para o bot parar de responder completamente após essa mensagem.
  if (reply.includes("Vou te conectar com um de nossos especialistas")) {
    console.log(`[${phone}] 🔀 Transferência para especialista — bot pausado.`);
    session.setWaitingForHuman(true);
    await saveSession(phone, session);
    return;
  }

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
    salvarLead(phone, session.leadData, session);
    if (presoAposHandoff) session.extractAttemptsAfterHandoff += 1;

    // 1) Assim que houver dados suficientes, dispara a simulação — somente UMA vez por sessão
    if (!session.simulacaoEnviada && podeSimular(session.leadData, session.coletaIniciada)) {
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

      // Enviar lead ao CRM quando qualificado (passa pela mesma guarda de snapshot —
      // evita duplicar se a extração logo acima já enviou os mesmos dados nesta rodada)
      salvarLead(phone, session.leadData, session);

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

// Protege a gestão de FAQ (página + API) com uma chave simples — porque
// diferente de /logs (leitura), aqui dá pra EDITAR o que a Ana fala pros
// leads. A chave vem de variável de ambiente do Railway (FAQ_ADMIN_KEY),
// nunca hardcoded. Aceita via ?key= na URL ou header x-faq-key.
// Se FAQ_ADMIN_KEY não estiver configurada no Railway, o acesso fica aberto
// (mesmo padrão dos outros endpoints administrativos do projeto) — configure
// a variável assim que possível pra ativar a proteção.
function checarChaveFaq(req, res, next) {
  const chaveEsperada = process.env.FAQ_ADMIN_KEY;
  if (!chaveEsperada) return next(); // sem chave configurada, segue sem bloquear
  const chaveRecebida = req.query.key || req.headers["x-faq-key"];
  if (chaveRecebida !== chaveEsperada) {
    return res.status(401).json({ error: "Acesso negado. Informe a chave correta (?key=... ou header x-faq-key)." });
  }
  next();
}

app.get("/faq", checarChaveFaq, (req, res) => {
  const html = readFileSync("./faq.html", "utf8");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ── API da base de FAQ (consumida por faq.html) ─────────────────────────
app.get("/api/faq", checarChaveFaq, async (req, res) => {
  try {
    res.json(await listarFaqs());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/faq", checarChaveFaq, async (req, res) => {
  try {
    const { pergunta, resposta, categoria } = req.body;
    if (!pergunta || !resposta) {
      return res.status(400).json({ error: "pergunta e resposta são obrigatórios" });
    }
    const embedding = await gerarEmbedding(pergunta);
    const id = await criarFaq({ pergunta, resposta, categoria, embedding });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/faq/:id", checarChaveFaq, async (req, res) => {
  try {
    const { pergunta, resposta, categoria, ativo, perguntaMudou } = req.body;
    if (!pergunta || !resposta) {
      return res.status(400).json({ error: "pergunta e resposta são obrigatórios" });
    }
    // Só recalcula o embedding (custo extra de API) se a pergunta de fato mudou.
    const embedding = perguntaMudou ? await gerarEmbedding(pergunta) : null;
    await atualizarFaq(req.params.id, { pergunta, resposta, categoria, ativo, embedding });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/faq/:id", checarChaveFaq, async (req, res) => {
  try {
    await excluirFaq(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auditoria: últimos casos em que uma FAQ foi usada pra responder um lead,
// com o score de similaridade — útil pra calibrar o threshold com dados reais.
app.get("/api/faq/uso", checarChaveFaq, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    res.json(await listarUsosFaq(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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


