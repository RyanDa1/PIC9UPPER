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

  const requestState = () => {
    channel.postMessage({ type: "NEED_STATE" });
  };

  channel.onmessage = (e) => {
    if (e.data?.type === "STATE" && e.data?.session) {
      gameManager.setSession(e.data.session);
    }
    if (e.data?.type === "NEED_STATE") {
      broadcast(); // Respond with our state if we have one
    }
  };

  return {
    broadcast,
    requestState,
    init: () => {
      gameManager.subscribe(broadcast);
      requestState(); // Ask for state on load (another tab may have session)
    },
  };
}
