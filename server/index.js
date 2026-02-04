/**
 * Cloudflare Worker entry point.
 * Routes WebSocket upgrades to GameRoom DO, everything else to static assets.
 */

export { GameRoom } from "./room.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // WebSocket endpoint: /ws?roomId=XXX
    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("roomId");
      if (!roomId) {
        return new Response("Missing roomId", { status: 400 });
      }

      // Deterministic DO ID from room name
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);

      // Forward the request (including upgrade headers) to the DO
      return stub.fetch(request);
    }

    // Everything else: static assets from public/
    return env.ASSETS.fetch(request);
  },
};
