import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

export const NO_REPLY = Symbol('intentionally pending CDP reply');

/** Real loopback HTTP/WebSocket protocol peer; it is not Chrome and does not render pages. */
export async function startCDPServer({ onCommand, versionResponse, versionStatus = 200, browserPath = '/devtools/browser/fixture' } = {}) {
  const commands = [];
  const targets = new Map([
    ['fixture-target', { targetId: 'fixture-target', type: 'page', title: 'Local protocol fixture', url: 'http://127.0.0.1:9876/fixture' }],
    ['service-worker', { targetId: 'service-worker', type: 'service_worker', title: 'not a tab', url: 'chrome-extension://fixture/worker.js' }],
  ]);
  const sockets = new Set();
  const sessions = new Map();
  let created = 0;
  let attached = 0;
  let navigated = 0;
  const loaders = new Map();
  let wsUrl;
  const httpRequests = [];
  const server = http.createServer((request, response) => {
    httpRequests.push({ method: request.method, url: request.url, headers: request.headers });
    if (request.url !== '/json/version') { response.writeHead(404); response.end(); return; }
    response.writeHead(versionStatus, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(versionResponse || { webSocketDebuggerUrl: wsUrl, Browser: 'Chrome/fixture' }));
  });
  const wss = new WebSocketServer({ server, path: browserPath });
  const emit = (message, socket = [...sockets].at(-1)) => socket?.send(JSON.stringify(message));
  const defaultReply = (command, socket) => {
    const params = command.params || {};
    switch (command.method) {
      case 'Browser.getVersion': return { product: 'Chrome/fixture', protocolVersion: '1.3' };
      case 'Target.getTargets': return { targetInfos: [...targets.values()] };
      case 'Target.getTargetInfo': return { targetInfo: targets.get(params.targetId) };
      case 'Target.createTarget': {
        const targetId = `test-created-${++created}`;
        targets.set(targetId, { targetId, type: 'page', title: '', url: params.url });
        return { targetId };
      }
      case 'Target.attachToTarget': {
        const sessionId = `test-session-${++attached}`;
        sessions.set(sessionId, params.targetId);
        return { sessionId };
      }
      case 'Target.detachFromTarget': sessions.delete(params.sessionId); return {};
      case 'Target.closeTarget': return { success: targets.delete(params.targetId) };
      case 'Page.getFrameTree': {
        const id = sessions.get(command.sessionId);
        return { frameTree: { frame: { id: `main-frame-${id}`, loaderId: loaders.get(id) || `loader-${id}`, url: targets.get(id)?.url || 'about:blank' } } };
      }
      case 'Page.navigate': {
        const id = sessions.get(command.sessionId);
        const tab = targets.get(id);
        if (!tab) throw new Error('No such target');
        tab.url = params.url;
        const loaderId = `navigation-loader-${++navigated}`; loaders.set(id, loaderId);
        const frameId = `main-frame-${id}`;
        emit({ method: 'Page.frameNavigated', sessionId: command.sessionId, params: { frame: { id: frameId, loaderId, url: tab.url } } }, socket);
        return { frameId, loaderId };
      }
      case 'Runtime.evaluate': return { result: { type: 'number', value: 2 } };
      default: return {};
    }
  };
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('message', async (data) => {
      const command = JSON.parse(data.toString());
      commands.push(command);
      try {
        let result = await onCommand?.(command, { socket, emit, targets, sessions });
        if (result === NO_REPLY) return;
        if (result === undefined) result = defaultReply(command, socket);
        if (socket.readyState === 1) emit({ id: command.id, result }, socket);
      } catch (error) {
        if (socket.readyState === 1) emit({ id: command.id, error: { code: error.protocolCode || -32000, message: error.message } }, socket);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}${browserPath}`;
  let closing;
  return {
    origin, wsUrl, port, commands, targets, sessions, sockets, httpRequests, emit,
    close() {
      return closing ||= (async () => {
        for (const socket of sockets) socket.terminate();
        const websocketClosed = new Promise((resolve) => wss.close(resolve));
        const httpClosed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await Promise.all([websocketClosed, httpClosed]);
      })();
    },
  };
}
