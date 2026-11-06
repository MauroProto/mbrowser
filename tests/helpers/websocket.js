import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Purpose-built RFC6455 client for exact Host/Origin and malformed-frame regression tests. */
export async function connectWebSocket(base, { path = '/extension', origin, host, headers = {}, timeoutMs = 2000 } = {}) {
  const url = new URL(path, base);
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      headers: {
        connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': key,
        ...(origin === undefined ? {} : { origin }),
        ...(host === undefined ? {} : { host }), ...headers,
      },
    });
    const timer = setTimeout(() => request.destroy(new Error('Test WebSocket upgrade timed out')), timeoutMs);
    request.once('error', (error) => { clearTimeout(timer); reject(error); });
    request.once('response', (response) => {
      clearTimeout(timer);
      response.resume();
      const error = new Error(`WebSocket upgrade rejected (${response.statusCode})`);
      error.status = response.statusCode;
      reject(error);
    });
    request.once('upgrade', (response, socket, head) => {
      clearTimeout(timer);
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      if (response.headers['sec-websocket-accept'] !== accept) {
        socket.destroy(); reject(new Error('Invalid test WebSocket accept')); return;
      }
      resolve(new TestWebSocket(socket, head));
    });
    request.end();
  });
}

export class TestWebSocket {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.closedWaiters = [];
    this.closeInfo = null;
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('error', () => this.finishClose({ code: 1006, reason: 'Socket error' }));
    socket.on('end', () => this.finishClose({ code: 1006, reason: 'Socket ended' }));
    socket.on('close', () => this.finishClose({ code: 1006, reason: 'Socket closed' }));
    if (head.length) this.consume(head);
  }

  sendJson(value) { this.sendFrame(Buffer.from(JSON.stringify(value))); }

  sendFrame(value, { opcode = 1, masked = true, fin = true } = {}) {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const extra = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
    const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (masked ? 0x80 : 0) | (extra === 0 ? payload.length : extra === 2 ? 126 : 127);
    if (extra === 2) header.writeUInt16BE(payload.length, 2);
    if (extra === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
    let encoded = payload;
    if (masked) {
      const mask = randomBytes(4);
      mask.copy(header, 2 + extra);
      encoded = Buffer.allocUnsafe(payload.length);
      for (let index = 0; index < payload.length; index++) encoded[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, encoded]));
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > 20n * 1024n * 1024n) { this.destroy(); return; }
        length = Number(big); offset = 10;
      }
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(offset - 4, offset);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length >= 2 ? payload.subarray(2).toString('utf8') : '';
        this.finishClose({ code, reason });
        if (!this.socket.destroyed) { this.sendFrame(payload, { opcode: 8 }); this.socket.end(); }
      } else if (opcode === 9) {
        this.sendFrame(payload, { opcode: 10 });
      } else if (opcode === 1) {
        const text = payload.toString('utf8');
        let value;
        try { value = JSON.parse(text); } catch { value = text; }
        const index = this.waiters.findIndex((waiter) => waiter.predicate(value));
        if (index >= 0) {
          const [waiter] = this.waiters.splice(index, 1);
          clearTimeout(waiter.timer); waiter.resolve(value);
        } else this.messages.push(value);
      }
    }
  }

  nextJson({ predicate = () => true, timeoutMs = 2000 } = {}) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    if (this.closeInfo) return Promise.reject(new Error(`Test WebSocket already closed (${this.closeInfo.code})`));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error('Test WebSocket message timed out'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitClosed(timeoutMs = 2000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        this.closedWaiters = this.closedWaiters.filter((item) => item !== waiter);
        reject(new Error('Test WebSocket close timed out'));
      }, timeoutMs);
      this.closedWaiters.push(waiter);
    });
  }

  finishClose(info) {
    if (this.closeInfo) return;
    this.closeInfo = info;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer); waiter.reject(new Error(`Test WebSocket closed (${info.code})`));
    }
    for (const waiter of this.closedWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(info); }
  }

  destroy() {
    this.socket.destroy();
    this.finishClose({ code: 1006, reason: 'Test teardown' });
  }
}
