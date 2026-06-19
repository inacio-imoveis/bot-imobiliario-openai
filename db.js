import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

// Criar tabelas se não existirem
export async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversas (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        direcao VARCHAR(10) NOT NULL, -- 'cliente' ou 'bot'
        mensagem TEXT NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        nome VARCHAR(200),
        data_nascimento VARCHAR(50),
        tipo_renda VARCHAR(100),
        compradores VARCHAR(200),
        dependentes VARCHAR(200),
        renda_mensal VARCHAR(100),
        imovel_interesse VARCHAR(200),
        agendou BOOLEAN DEFAULT FALSE,
        criado_em TIMESTAMP DEFAULT NOW(),
        atualizado_em TIMESTAMP DEFAULT NOW()
      );
    `);
    // Estado da sessão (lead acumulado + flags anti-loop), pra sobreviver a restarts/redeploys
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_data JSONB;`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS simulacao_enviada BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS handoff_alerta_enviado BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS handoff_imovel_key VARCHAR(50);`);
    // Follow-up de escassez/urgência pós-simulação (D+1 / D+3)
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS simulacao_enviada_em TIMESTAMP;`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup1_enviado BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup2_enviado BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup3_enviado BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup4_enviado BOOLEAN DEFAULT FALSE;`);
    // Base de FAQ curada manualmente: a Ana consulta isso ANTES de responder.
    // embedding fica como JSONB (array de floats) — sem pgvector por enquanto,
    // similaridade é calculada em Node (ver buscarFaqSimilar). Dá pra migrar
    // pra pgvector depois trocando só a query de busca.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS faq_base (
        id SERIAL PRIMARY KEY,
        pergunta TEXT NOT NULL,
        resposta TEXT NOT NULL,
        categoria VARCHAR(100),
        embedding JSONB,
        ativo BOOLEAN DEFAULT TRUE,
        criado_em TIMESTAMP DEFAULT NOW(),
        atualizado_em TIMESTAMP DEFAULT NOW()
      );
    `);
    // Rastro de uso: toda vez que uma FAQ é considerada "match" pra responder
    // um lead, registra aqui — com o score, pra você auditar e calibrar o
    // threshold com dados reais (não só palpite).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS faq_uso (
        id SERIAL PRIMARY KEY,
        faq_id INTEGER REFERENCES faq_base(id) ON DELETE SET NULL,
        phone VARCHAR(20) NOT NULL,
        mensagem_cliente TEXT NOT NULL,
        score NUMERIC(5,4),
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Banco de dados inicializado");
  } catch (err) {
    console.error("❌ Erro ao inicializar banco:", err.message);
  }
}

// Salvar mensagem no log
export async function logMensagem(phone, direcao, mensagem) {
  try {
    await pool.query(
      "INSERT INTO conversas (phone, direcao, mensagem) VALUES ($1, $2, $3)",
      [phone, direcao, mensagem]
    );
  } catch (err) {
    console.error("Erro ao salvar log:", err.message);
  }
}

// Salvar/atualizar lead
export async function upsertLead(phone, dados) {
  try {
    const existing = await pool.query("SELECT id FROM leads WHERE phone = $1", [phone]);
    if (existing.rows.length > 0) {
      const sets = Object.keys(dados).map((k, i) => `${k} = $${i + 2}`).join(", ");
      await pool.query(
        `UPDATE leads SET ${sets}, atualizado_em = NOW() WHERE phone = $1`,
        [phone, ...Object.values(dados)]
      );
    } else {
      const cols = ["phone", ...Object.keys(dados)].join(", ");
      const vals = Array.from({ length: Object.keys(dados).length + 1 }, (_, i) => `$${i + 1}`).join(", ");
      await pool.query(
        `INSERT INTO leads (${cols}) VALUES (${vals})`,
        [phone, ...Object.values(dados)]
      );
    }
  } catch (err) {
    console.error("Erro ao salvar lead:", err.message);
  }
}

// Buscar estado da sessão salvo (lead acumulado + flags anti-loop)
export async function getSessionState(phone) {
  try {
    const res = await pool.query(
      "SELECT lead_data, simulacao_enviada, handoff_alerta_enviado, handoff_imovel_key FROM leads WHERE phone = $1",
      [phone]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    const leadData = row.lead_data || {};
    // _meta carrega contadores de controle anti-loop dentro do mesmo JSONB,
    // sem precisar de colunas extras. Não faz parte dos dados do lead em si.
    const meta = leadData._meta || {};
    const { _meta, ...leadDataLimpo } = leadData;
    return {
      leadData: leadDataLimpo,
      simulacaoEnviada: !!row.simulacao_enviada,
      handoffAlertaEnviado: !!row.handoff_alerta_enviado,
      handoffImovelKey: row.handoff_imovel_key || null,
      extractAttemptsAfterHandoff: meta.extractAttemptsAfterHandoff || 0,
      lastExtractLen: meta.lastExtractLen || 0,
      coletaIniciada: meta.coletaIniciada || false,
    };
  } catch (err) {
    console.error("Erro ao buscar estado da sessão:", err.message);
    return null;
  }
}

// Salvar estado da sessão (lead acumulado + flags anti-loop)
export async function saveSessionState(phone, state) {
  try {
    const leadDataComMeta = {
      ...(state.leadData || {}),
      _meta: {
        extractAttemptsAfterHandoff: state.extractAttemptsAfterHandoff || 0,
        lastExtractLen: state.lastExtractLen || 0,
        coletaIniciada: state.coletaIniciada || false,
      },
    };
    const dados = {
      lead_data: JSON.stringify(leadDataComMeta),
      simulacao_enviada: !!state.simulacaoEnviada,
      handoff_alerta_enviado: !!state.handoffAlertaEnviado,
      handoff_imovel_key: state.handoffImovelKey || null,
    };
    const existing = await pool.query("SELECT id FROM leads WHERE phone = $1", [phone]);
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE leads SET lead_data = $2, simulacao_enviada = $3, handoff_alerta_enviado = $4, handoff_imovel_key = $5, atualizado_em = NOW() WHERE phone = $1`,
        [phone, dados.lead_data, dados.simulacao_enviada, dados.handoff_alerta_enviado, dados.handoff_imovel_key]
      );
    } else {
      await pool.query(
        `INSERT INTO leads (phone, lead_data, simulacao_enviada, handoff_alerta_enviado, handoff_imovel_key) VALUES ($1, $2, $3, $4, $5)`,
        [phone, dados.lead_data, dados.simulacao_enviada, dados.handoff_alerta_enviado, dados.handoff_imovel_key]
      );
    }
  } catch (err) {
    console.error("Erro ao salvar estado da sessão:", err.message);
  }
}

// Buscar conversas de um número
export async function getConversas(phone, limit = 50) {
  try {
    const res = await pool.query(
      "SELECT direcao, mensagem, criado_em FROM conversas WHERE phone = $1 ORDER BY criado_em DESC LIMIT $2",
      [phone, limit]
    );
    return res.rows;
  } catch (err) {
    console.error("Erro ao buscar conversas:", err.message);
    return [];
  }
}

// Buscar todos os leads
export async function getLeads() {
  try {
    const res = await pool.query("SELECT * FROM leads ORDER BY criado_em DESC");
    return res.rows;
  } catch (err) {
    console.error("Erro ao buscar leads:", err.message);
    return [];
  }
}

// Buscar resumo geral
export async function getResumo() {
  try {
    const total = await pool.query("SELECT COUNT(*) FROM conversas");
    const numeros = await pool.query("SELECT COUNT(DISTINCT phone) FROM conversas");
    const leads = await pool.query("SELECT COUNT(*) FROM leads");
    const agendados = await pool.query("SELECT COUNT(*) FROM leads WHERE agendou = TRUE");
    const hoje = await pool.query("SELECT COUNT(*) FROM conversas WHERE criado_em >= NOW() - INTERVAL '24 hours'");
    return {
      total_mensagens: parseInt(total.rows[0].count),
      numeros_unicos: parseInt(numeros.rows[0].count),
      total_leads: parseInt(leads.rows[0].count),
      agendados: parseInt(agendados.rows[0].count),
      mensagens_hoje: parseInt(hoje.rows[0].count),
    };
  } catch (err) {
    console.error("Erro ao buscar resumo:", err.message);
    return {};
  }
}

export { pool };

// ── FOLLOW-UP DE ESCASSEZ/URGÊNCIA (D+1 / D+3) ──────────────────────────────

// Marca o momento em que a simulação foi enviada (apenas na primeira vez)
export async function marcarSimulacaoEnviadaTimestamp(phone) {
  try {
    await pool.query(
      `UPDATE leads SET simulacao_enviada_em = NOW() WHERE phone = $1 AND simulacao_enviada_em IS NULL`,
      [phone]
    );
  } catch (err) {
    console.error("Erro ao marcar timestamp da simulação:", err.message);
  }
}

// Cascata de follow-up de escassez/urgência: D+1, D+7, D+14, D+30.
// Cada etapa só é enviada se a anterior já foi enviada e o lead NÃO respondeu
// (nenhuma mensagem do cliente) desde que a simulação foi enviada — qualquer
// resposta do lead cancela toda a cascata seguinte.

// D+1: 1 dia após a simulação, sem follow-up 1 ainda
export async function getLeadsParaFollowup1() {
  try {
    const res = await pool.query(`
      SELECT phone, nome, imovel_interesse FROM leads
      WHERE simulacao_enviada = TRUE
        AND simulacao_enviada_em IS NOT NULL
        AND simulacao_enviada_em <= NOW() - INTERVAL '1 day'
        AND (followup1_enviado IS NOT TRUE)
        AND NOT EXISTS (
          SELECT 1 FROM conversas
          WHERE conversas.phone = leads.phone
            AND conversas.direcao = 'cliente'
            AND conversas.criado_em > leads.simulacao_enviada_em
        )
    `);
    return res.rows;
  } catch (err) {
    console.error("Erro ao buscar leads para follow-up 1 (D+1):", err.message);
    return [];
  }
}

// D+7: 7 dias após a simulação, follow-up 1 já enviado, follow-up 2 ainda não
export async function getLeadsParaFollowup2() {
  try {
    const res = await pool.query(`
      SELECT phone, nome, imovel_interesse FROM leads
      WHERE simulacao_enviada = TRUE
        AND followup1_enviado = TRUE
        AND followup2_enviado IS NOT TRUE
        AND simulacao_enviada_em <= NOW() - INTERVAL '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM conversas
          WHERE conversas.phone = leads.phone
            AND conversas.direcao = 'cliente'
            AND conversas.criado_em > leads.simulacao_enviada_em
        )
    `);
    return res.rows;
  } catch (err) {
    console.error("Erro ao buscar leads para follow-up 2 (D+7):", err.message);
    return [];
  }
}

// D+14: 14 dias após a simulação, follow-up 2 já enviado, follow-up 3 ainda não
export async function getLeadsParaFollowup3() {
  try {
    const res = await pool.query(`
      SELECT phone, nome, imovel_interesse FROM leads
      WHERE simulacao_enviada = TRUE
        AND followup2_enviado = TRUE
        AND followup3_enviado IS NOT TRUE
        AND simulacao_enviada_em <= NOW() - INTERVAL '14 days'
        AND NOT EXISTS (
          SELECT 1 FROM conversas
          WHERE conversas.phone = leads.phone
            AND conversas.direcao = 'cliente'
            AND conversas.criado_em > leads.simulacao_enviada_em
        )
    `);
    return res.rows;
  } catch (err) {
    console.error("Erro ao buscar leads para follow-up 3 (D+14):", err.message);
    return [];
  }
}

// D+30: 30 dias após a simulação, follow-up 3 já enviado, follow-up 4 ainda não
export async function getLeadsParaFollowup4() {
  try {
    const res = await pool.query(`
      SELECT phone, nome, imovel_interesse FROM leads
      WHERE simulacao_enviada = TRUE
        AND followup3_enviado = TRUE
        AND followup4_enviado IS NOT TRUE
        AND simulacao_enviada_em <= NOW() - INTERVAL '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM conversas
          WHERE conversas.phone = leads.phone
            AND conversas.direcao = 'cliente'
            AND conversas.criado_em > leads.simulacao_enviada_em
        )
    `);
    return res.rows;
  } catch (err) {
    console.error("Erro ao buscar leads para follow-up 4 (D+30):", err.message);
    return [];
  }
}

export async function marcarFollowup1Enviado(phone) {
  try {
    await pool.query(`UPDATE leads SET followup1_enviado = TRUE WHERE phone = $1`, [phone]);
  } catch (err) {
    console.error("Erro ao marcar follow-up 1:", err.message);
  }
}

export async function marcarFollowup2Enviado(phone) {
  try {
    await pool.query(`UPDATE leads SET followup2_enviado = TRUE WHERE phone = $1`, [phone]);
  } catch (err) {
    console.error("Erro ao marcar follow-up 2:", err.message);
  }
}

export async function marcarFollowup3Enviado(phone) {
  try {
    await pool.query(`UPDATE leads SET followup3_enviado = TRUE WHERE phone = $1`, [phone]);
  } catch (err) {
    console.error("Erro ao marcar follow-up 3:", err.message);
  }
}

export async function marcarFollowup4Enviado(phone) {
  try {
    await pool.query(`UPDATE leads SET followup4_enviado = TRUE WHERE phone = $1`, [phone]);
  } catch (err) {
    console.error("Erro ao marcar follow-up 4:", err.message);
  }
}

// ── FAQ BASE (curada manualmente, consultada pela Ana antes de responder) ──

// Lista todas as FAQs (pra tela de gestão em faq.html)
export async function listarFaqs() {
  try {
    const res = await pool.query(
      `SELECT id, pergunta, resposta, categoria, ativo, criado_em, atualizado_em
       FROM faq_base ORDER BY criado_em DESC`
    );
    return res.rows;
  } catch (err) {
    console.error("Erro ao listar FAQs:", err.message);
    return [];
  }
}

// Cria uma FAQ nova. O embedding é calculado fora (em server.js, via OpenAI)
// e passado já pronto, pra esta função não depender da API da OpenAI.
export async function criarFaq({ pergunta, resposta, categoria, embedding }) {
  try {
    const res = await pool.query(
      `INSERT INTO faq_base (pergunta, resposta, categoria, embedding)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [pergunta, resposta, categoria || null, JSON.stringify(embedding)]
    );
    return res.rows[0].id;
  } catch (err) {
    console.error("Erro ao criar FAQ:", err.message);
    throw err;
  }
}

// Atualiza pergunta/resposta/categoria/ativo de uma FAQ existente.
// Se a pergunta mudou, o embedding novo deve ser passado também (recalculado em server.js).
export async function atualizarFaq(id, { pergunta, resposta, categoria, ativo, embedding }) {
  try {
    const sets = ["pergunta = $2", "resposta = $3", "categoria = $4", "ativo = $5", "atualizado_em = NOW()"];
    const vals = [id, pergunta, resposta, categoria || null, ativo !== false];
    if (embedding) {
      sets.push(`embedding = $${vals.length + 1}`);
      vals.push(JSON.stringify(embedding));
    }
    await pool.query(`UPDATE faq_base SET ${sets.join(", ")} WHERE id = $1`, vals);
  } catch (err) {
    console.error("Erro ao atualizar FAQ:", err.message);
    throw err;
  }
}

export async function excluirFaq(id) {
  try {
    await pool.query(`DELETE FROM faq_base WHERE id = $1`, [id]);
  } catch (err) {
    console.error("Erro ao excluir FAQ:", err.message);
    throw err;
  }
}

// Registra que uma FAQ foi usada pra responder um lead — auditoria/calibração.
export async function registrarUsoFaq({ faqId, phone, mensagemCliente, score }) {
  try {
    await pool.query(
      `INSERT INTO faq_uso (faq_id, phone, mensagem_cliente, score) VALUES ($1, $2, $3, $4)`,
      [faqId, phone, mensagemCliente, score]
    );
  } catch (err) {
    console.error("Erro ao registrar uso de FAQ:", err.message);
  }
}

// Lista os usos mais recentes, com a pergunta da FAQ — pra auditoria manual.
export async function listarUsosFaq(limit = 100) {
  try {
    const res = await pool.query(
      `SELECT u.id, u.phone, u.mensagem_cliente, u.score, u.criado_em,
              f.pergunta AS faq_pergunta, f.id AS faq_id
       FROM faq_uso u
       LEFT JOIN faq_base f ON f.id = u.faq_id
       ORDER BY u.criado_em DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error("Erro ao listar usos de FAQ:", err.message);
    return [];
  }
}

// Similaridade de cosseno entre dois vetores — usado pra achar a FAQ mais
// próxima da pergunta do lead. Sem pgvector: roda em memória no Node.
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Busca a FAQ ativa mais parecida com o embedding da mensagem do lead.
// Retorna null se nada passar do threshold (evita resposta forçada/errada).
export async function buscarFaqSimilar(embeddingPergunta, threshold = 0.82) {
  try {
    const res = await pool.query(
      `SELECT id, pergunta, resposta, categoria, embedding FROM faq_base WHERE ativo = TRUE`
    );
    let melhor = null;
    let melhorScore = 0;
    for (const row of res.rows) {
      if (!row.embedding) continue;
      const score = cosineSimilarity(embeddingPergunta, row.embedding);
      if (score > melhorScore) {
        melhorScore = score;
        melhor = row;
      }
    }
    if (melhor && melhorScore >= threshold) {
      return { ...melhor, score: melhorScore };
    }
    return null;
  } catch (err) {
    console.error("Erro ao buscar FAQ similar:", err.message);
    return null;
  }
}


