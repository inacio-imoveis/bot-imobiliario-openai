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
    return {
      leadData: row.lead_data || {},
      simulacaoEnviada: !!row.simulacao_enviada,
      handoffAlertaEnviado: !!row.handoff_alerta_enviado,
      handoffImovelKey: row.handoff_imovel_key || null,
    };
  } catch (err) {
    console.error("Erro ao buscar estado da sessão:", err.message);
    return null;
  }
}

// Salvar estado da sessão (lead acumulado + flags anti-loop)
export async function saveSessionState(phone, state) {
  try {
    const dados = {
      lead_data: JSON.stringify(state.leadData || {}),
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
