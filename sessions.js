const sessions = new Map();

class Session {
  constructor() {
    this.history = [];
    this.waitingForHuman = false;
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

  count() {
    return sessions.size;
  },
};
