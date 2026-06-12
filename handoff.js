const HANDOFF_TRIGGERS = [
  /quero falar com (uma pessoa|um consultor|atendente|humano)/i,
  /me passa (o telefone|o contato|o número)/i,
  /falar com (ricardo|o dono|o corretor)/i,
  /atendimento humano/i,
  /não quero falar com (robô|bot)/i,
];

export function detectHandoffTrigger(text) {
  for (const pattern of HANDOFF_TRIGGERS) {
    if (pattern.test(text)) return text;
  }
  return null;
}

export function formatHandoffAlert(phone, session, trigger) {
  const history = session.getHistory().slice(-4);
  const preview = history
    .map(m => `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content}`)
    .join("\n");

  return `🚨 *Solicitação de atendimento humano*\n\nCliente: ${phone}\nMensagem: "${trigger}"\n\nÚltimas mensagens:\n${preview}\n\nResponda diretamente para este número.`;
}

// Alerta enviado quando a coleta de dados foi concluída (com ou sem simulação enviada)
export function formatLeadAlert(phone, session, { simulado, faltando = [] }) {
  const lead = session.leadData || {};
  const linhas = [
    `🚨 *Lead com dados coletados*`,
    ``,
    `Cliente: ${phone}`,
    lead.nome ? `Nome: ${lead.nome}` : null,
    lead.renda ? `Renda: R$ ${lead.renda}` : null,
    lead.idade ? `Idade: ${lead.idade}` : null,
    lead.tipo ? `Tipo de renda: ${lead.tipo}` : null,
    lead.imovelKey ? `Imóvel: ${lead.imovelKey}` : null,
    typeof lead.cotista === "boolean" ? `Cotista FGTS: ${lead.cotista ? "sim" : "não"}` : null,
    typeof lead.comDependente === "boolean" ? `Dependentes: ${lead.comDependente ? "sim" : "não"}` : null,
    ``,
    simulado
      ? `✅ Simulação enviada automaticamente ao cliente.`
      : `⚠️ Simulação NÃO enviada — faltou: ${faltando.join(", ") || "dados"}.\nO cliente já foi avisado que um consultor vai finalizar.`,
    ``,
    `Responda diretamente para este número.`,
  ].filter(Boolean);

  return linhas.join("\n");
}
