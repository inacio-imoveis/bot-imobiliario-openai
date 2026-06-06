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
