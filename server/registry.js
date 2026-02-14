/**
 * RoomRegistry Durable Object — tracks active room IDs.
 * Singleton (always accessed via idFromName("global")).
 * Rooms register on create/join, unregister on cleanup.
 */
export class RoomRegistry {
  constructor(state) {
    this.state = state;
    this.rooms = new Map(); // roomId → { phase, players, hostName, updatedAt }

    state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get("rooms");
      if (stored) this.rooms = new Map(Object.entries(stored));
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/list") {
      const entries = [];
      for (const [roomId, info] of this.rooms) {
        entries.push({ roomId, ...info });
      }
      return new Response(JSON.stringify(entries), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      const { roomId, phase, playerNames, hostName } = await request.json();
      this.rooms.set(roomId, {
        phase,
        playerNames: playerNames || {},
        hostName: hostName || null,
        updatedAt: Date.now(),
      });
      this.persist();
      return new Response("ok");
    }

    if (url.pathname === "/unregister" && request.method === "POST") {
      const { roomId } = await request.json();
      this.rooms.delete(roomId);
      this.persist();
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  }

  persist() {
    const obj = Object.fromEntries(this.rooms);
    this.state.storage.put("rooms", obj);
  }
}
