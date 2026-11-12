import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A small WebSocket server side (RFC 6455), so the cloud keeps zero runtime dependencies. Text and binary messages,
 * fragments, ping/pong and close. Clients must mask their frames (browsers and Node clients do); the server never does.
 * Used for the outlet tunnel (P6-02) and for devices' live streams carried through it.
 */
export class WsConn extends EventEmitter {
  closed = false;
  private readonly socket: Duplex;
  private readonly maxMessage: number;
  private buf: Buffer = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private fragOp = 0;
  private fragSize = 0;

  constructor(socket: Duplex, maxMessage: number) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    socket.on('data', (d: Buffer) => this.feed(d));
    socket.on('close', () => this.finish(1006, 'connection lost'));
    socket.on('error', () => socket.destroy());
  }

  send(text: string): void {
    if (!this.closed) this.frame(0x1, Buffer.from(text, 'utf8'));
  }

  ping(): void {
    if (!this.closed) this.frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const r = Buffer.from(reason.slice(0, 120), 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.frame(0x8, payload);
    this.socket.end();
    this.finish(code, reason);
  }

  /** Bytes queued and not yet sent (a slow device). */
  get buffered(): number {
    return (this.socket as unknown as { writableLength?: number }).writableLength ?? 0;
  }

  feed(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if ((b1 & 0x80) === 0) return this.close(1002, 'frames must be masked');
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) return this.close(1009, 'message too big');
        len = Number(big);
        off = 10;
      }
      if (len > this.maxMessage || this.fragSize + len > this.maxMessage) return this.close(1009, 'message too big');
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        return this.close(code === 1005 || code === 1006 ? 1000 : code);
      }
      if (op === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (op === 0xa) {
        this.emit('pong');
        continue;
      }
      if (op === 0x0) {
        this.frags.push(payload);
        this.fragSize += payload.length;
        if (fin) this.message(this.fragOp, Buffer.concat(this.frags));
        continue;
      }
      if (op === 0x1 || op === 0x2) {
        if (fin) this.message(op, payload);
        else {
          this.frags = [payload];
          this.fragOp = op;
          this.fragSize = payload.length;
        }
        continue;
      }
      return this.close(1002, 'unknown frame');
    }
  }

  private message(op: number, data: Buffer): void {
    this.frags = [];
    this.fragSize = 0;
    this.emit('message', op === 0x1 ? data.toString('utf8') : data);
  }

  private frame(op: number, payload: Buffer): void {
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = n;
    else if (n < 65536) {
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    try {
      this.socket.write(Buffer.concat([head, payload]));
    } catch {
      this.socket.destroy();
    }
  }

  /** Once, whichever side closed first. */
  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }
}

/** Completes the WebSocket handshake, or refuses it with an HTTP status. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, maxMessage: number): WsConn | null {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    refuseUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const conn = new WsConn(socket, maxMessage);
  if (head.length) conn.feed(head);
  return conn;
}

export function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}
