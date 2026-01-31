/**
 * Multi-tab sync via BroadcastChannel for local testing.
 * Each tab = one player. State syncs across tabs on same origin.
 */

const CHANNEL = "pic9upper-sync";

export function createSync(gameManager) {
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;

  if (!channel) {
    return { broadcast: () => {}, requestState: () => {}, init: () => {} };
  }

  const broadcast = () => {
    const session = gameManager.getSession();
    if (session) {
      channel.postMessage({ type: "STATE", session });
    }
  };

  const requestState = (sessionId) => {
    channel.postMessage({ type: "NEED_STATE", sessionId });
  };

  channel.onmessage = (e) => {
    if (e.data?.type === "STATE" && e.data?.session) {
      gameManager.setSession(e.data.session);
    }
    if (e.data?.type === "NEED_STATE") {
      const session = gameManager.getSession();
      if (session) {
        const wanted = e.data?.sessionId;
        if (!wanted || session.id === wanted) channel.postMessage({ type: "STATE", session });
      }
    }
  };

  return {
    broadcast,
    requestState,
    init: (sessionId) => {
      gameManager.subscribe(broadcast);
      requestState(sessionId); // Ask for state (optionally for specific room)
    },
  };
}
