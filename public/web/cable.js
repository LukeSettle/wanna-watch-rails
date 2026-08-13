// Minimal ActionCable client speaking the same raw protocol the React Native
// app uses (see SocketContext.js in the WannaWatch repo).

class Cable {
  constructor(userId, onMessage) {
    this.userId = userId;
    this.onMessage = onMessage;
    this.subscriptions = new Set();
    this.closedByUser = false;
    this.connect();
  }

  connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.ws = new WebSocket(`${protocol}//${location.host}/cable?user_id=${this.userId}`);

    this.ws.onopen = () => {
      this.subscriptions.forEach((identifier) => {
        this.ws.send(JSON.stringify({ command: "subscribe", identifier }));
      });
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "ping" || data.type === "welcome" || data.type === "confirm_subscription") return;
      this.onMessage(data);
    };

    this.ws.onclose = () => {
      if (this.closedByUser) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };
  }

  identifierFor(channelParams) {
    return JSON.stringify(channelParams);
  }

  subscribe(channelParams) {
    const identifier = this.identifierFor(channelParams);
    if (this.subscriptions.has(identifier)) return;
    this.subscriptions.add(identifier);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ command: "subscribe", identifier }));
    }
  }

  unsubscribe(channelParams) {
    const identifier = this.identifierFor(channelParams);
    if (!this.subscriptions.has(identifier)) return;
    this.subscriptions.delete(identifier);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ command: "unsubscribe", identifier }));
    }
  }

  perform(channelParams, action, data = {}) {
    this.ws.send(JSON.stringify({
      command: "message",
      identifier: this.identifierFor(channelParams),
      data: JSON.stringify({ action, ...data }),
    }));
  }

  close() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.ws.close();
  }
}
