const sessions = new Map();

// Tempo máximo que o bot fica pausado esperando atendente humano (1 hora)
const HANDOFF_TIMEOUT_MS = 60 * 60 * 1000;

class Session {
  constructor() {
    this.history = [];
    this.waitingForHuman = false;
    this.handoffAt = null;
    this.createdAt = Date.now();
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
