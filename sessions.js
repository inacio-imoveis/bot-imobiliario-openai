const sessions = new Map();

// Tempo máximo que o bot fica pausado esperando atendente humano (1 hora)
const HANDOFF_TIMEOUT_MS = 60 * 60 * 1000;

class Session {
  constructor() {
    this.history = [];
    this.waitingForHuman = false;
    this.handoffAt = null;
    this.createdAt = Date.now();

    // Dados do lead acumulados progressivamente (não dependem do histórico truncado)
    this.leadData = {};
    // true quando a simulação já foi enviada ao cliente — evita reenvio em loop
    this.simulacaoEnviada = false;
    // true quando já alertamos o time sobre esse lead (coleta concluída) — evita spam
    this.handoffAlertaEnviado = false;
    // tamanho do histórico na última extração de dados via IA — evita extrações repetidas sem novidade
    this.lastExtractLen = 0;
    // imóvel para o qual o último alerta/handoff foi disparado — usado para reabrir o ciclo
    // se o cliente demonstrar interesse em outro imóvel depois
    this.handoffImovelKey = null;
    // quantas vezes extractLeadComIA rodou depois do handoffAlertaEnviado sem completar a simulação
    // (limita custo de IA em leads "presos" por dado faltante)
    this.extractAttemptsAfterHandoff = 0;
    // true depois de tentar carregar o estado salvo no banco (uma vez por processo)
    this._hydrated = false;
    // tentativas de identificar o imóvel quando awaitingPhotoChoice está ativo
    this.photoChoiceAttempts = 0;
  }

  addMessage(role, content) {
    this.history.push({ role, content });
    if (this.history.length > 20) {
      this.history = this.history.slice(-20);
    }
  }

  getHistory() {
    return this.history;
  }

  setWaitingForHuman(value) {
    this.waitingForHuman = value;
    this.handoffAt = value ? Date.now() : null;
  }

  // Verifica se ainda está em espera — expira automaticamente após 1h
  isWaitingForHuman() {
    if (!this.waitingForHuman) return false;
    if (this.handoffAt && Date.now() - this.handoffAt > HANDOFF_TIMEOUT_MS) {
      this.waitingForHuman = false;
      this.handoffAt = null;
      return false;
    }
    return true;
  }
}

export const sessionManager = {
  get(phone) {
    if (!sessions.has(phone)) {
      sessions.set(phone, new Session());
    }
    return sessions.get(phone);
  },

  save(phone, session) {
    sessions.set(phone, session);
  },

  reset(phone) {
    sessions.delete(phone);
  },

  resetAll() {
    const n = sessions.size;
    sessions.clear();
    return n;
  },

  count() {
    return sessions.size;
  },
};
