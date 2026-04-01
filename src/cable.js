// Minimal ActionCable client using Node's built-in WebSocket (Node 21+)
export function connectCable(server, token) {
  if (typeof globalThis.WebSocket === "undefined") {
    return Promise.reject(new Error("WebSocket not available (requires Node 21+)"));
  }

  return new Promise((resolve, reject) => {
    const wsUrl = server
      .replace(/^http/, "ws")
      .replace(/\/$/, "") + `/cable`;

    // Pass token as subprotocol — not logged in server/proxy access logs
    const ws = new WebSocket(wsUrl, [`actioncable-v1-json`, `token.${token}`]);

    const cable = {
      ws,
      subscriptions: new Map(),
      subscribe(roomName, onMessage) {
        this._send({
          command: "subscribe",
          identifier: JSON.stringify({ channel: "RoomChannel", room_id: roomName, format: "json" }),
        });
        this.subscriptions.set(roomName, onMessage);
      },
      _send(data) {
        ws.send(JSON.stringify(data));
      },
    };

    ws.addEventListener("open", () => resolve(cable));
    ws.addEventListener("error", (e) => reject(new Error("WebSocket error")));

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "ping" || msg.type === "welcome" || msg.type === "confirm_subscription") return;
        if (msg.identifier) {
          const id = JSON.parse(msg.identifier);
          const handler = cable.subscriptions.get(id.room_id);
          if (handler) handler(msg.message);
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.addEventListener("close", () => {
      console.error("WebSocket closed, falling back to polling");
    });

    setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
  });
}
