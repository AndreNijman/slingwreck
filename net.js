// Client networking. One websocket, JSON frames, and deliberately no automatic
// reconnect: P6.2 will make resume an explicit reconstruction from blueprint,
// seed, and shot log instead of a retry loop that hides a dropped round.

const RELAY_FALLBACK =
  'https://slingwreck-relay.tung-tung-tung-sahur.workers.dev';

function trimBase(value) { return String(value).replace(/\/+$/, ''); }

export function relayBase() {
  const override = new URLSearchParams(location.search).get('relay');
  if (override) return trimBase(override);
  if (window.SLINGWRECK_RELAY_URL) return trimBase(window.SLINGWRECK_RELAY_URL);
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1' ||
      location.hostname === '[::1]' || location.hostname === '::1') {
    return trimBase(location.origin);
  }
  return RELAY_FALLBACK;
}

export function lobbyListUrl() {
  return `${relayBase().replace(/^ws/, 'http')}/lobbies`;
}

export function createNet(handlers = {}) {
  let socket = null;
  let connectionGuard = 0;
  let connectionState = 'idle';
  let connectionReason = '';

  function setState(state, reason = '') {
    connectionState = state;
    connectionReason = reason;
    handlers.onState?.({ state, reason });
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function open(action, room, options = {}) {
    close('superseded');
    const base = relayBase().replace(/^http/, 'ws');
    const url = new URL(`${base}/ws`);
    url.searchParams.set('room', room);
    const ws = new WebSocket(url.toString());
    socket = ws;
    setState('connecting');
    let failed = false;
    connectionGuard = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close(1000, 'connection timeout');
    }, 12_000);

    ws.onopen = () => {
      if (socket !== ws) return;
      clearTimeout(connectionGuard);
      connectionGuard = 0;
      setState('handshaking');
      send({
        t: action,
        room,
        name: options.name || 'Wrecker',
        password: options.password || ''
      });
      handlers.onOpen?.();
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'welcome') setState('connected');
      handlers.onMessage?.(message);
    };
    ws.onerror = () => {
      if (socket !== ws) return;
      failed = true;
      setState('error', 'connection failed');
    };
    ws.onclose = (event) => {
      clearTimeout(connectionGuard);
      connectionGuard = 0;
      if (socket !== ws) return;
      socket = null;
      const reason = connectionReason || event.reason ||
        (failed ? 'connection failed' : 'connection closed');
      setState(failed ? 'error' : 'closed', reason);
      handlers.onClose?.(reason);
    };
  }

  function close(reason = '') {
    if (!socket) {
      if (connectionState !== 'idle') setState('closed', reason);
      return;
    }
    const ws = socket;
    socket = null;
    clearTimeout(connectionGuard);
    connectionGuard = 0;
    setState('closing', reason);
    ws.onclose = null;
    ws.close(1000, reason.slice(0, 123));
    setState('closed', reason);
  }

  return {
    open,
    send,
    close,
    connected: () => connectionState === 'connected' &&
      socket?.readyState === WebSocket.OPEN,
    state: () => connectionState,
    status: () => ({ state: connectionState, reason: connectionReason })
  };
}

export async function fetchLobbies() {
  try {
    const response = await fetch(lobbyListUrl(), { cache: 'no-store' });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.lobbies) ? data.lobbies : [];
  } catch {
    return [];
  }
}
