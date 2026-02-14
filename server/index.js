/**
 * Cloudflare Worker entry point.
 * Routes WebSocket upgrades to GameRoom DO, everything else to static assets.
 */

export { GameRoom } from "./room.js";
export { RoomRegistry } from "./registry.js";

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

    // Admin API: inspect a room's DO state
    if (url.pathname === "/api/room" && request.method === "GET") {
      const roomId = url.searchParams.get("roomId");
      if (!roomId) {
        return new Response(JSON.stringify({ error: "Missing roomId" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);

      // Forward as a plain HTTP GET to the DO's /inspect path
      const inspectUrl = new URL(request.url);
      inspectUrl.pathname = "/inspect";
      return stub.fetch(new Request(inspectUrl, { method: "GET" }));
    }

    // Admin API: destroy a room completely
    if (url.pathname === "/api/room" && request.method === "DELETE") {
      const roomId = url.searchParams.get("roomId");
      if (!roomId) {
        return new Response(JSON.stringify({ error: "Missing roomId" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);

      return stub.fetch(new Request(new URL("/destroy", request.url), { method: "POST" }));
    }

    // Admin API: list all active rooms
    if (url.pathname === "/api/rooms" && request.method === "GET") {
      const regId = env.ROOM_REGISTRY.idFromName("global");
      const reg = env.ROOM_REGISTRY.get(regId);
      return reg.fetch(new Request(new URL("/list", request.url), { method: "GET" }));
    }

    // Admin page
    if (url.pathname === "/admin") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", url.origin), request));
    }

    // Everything else: static assets from public/
    return env.ASSETS.fetch(request);
  },
};
