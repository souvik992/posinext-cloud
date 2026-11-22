import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { clientIp } from '../src/http.ts';

const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

test('rate limits see each visitor: behind Caddy (loopback) the forwarded address; a direct visitor cannot choose it', () => {
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7', 'Caddy on this machine: the visitor it saw');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '198.51.100.1, 203.0.113.7')), '203.0.113.7', 'the last address is the one Caddy added');
  assert.equal(clientIp(req('127.0.0.1')), '127.0.0.1', 'no header: the connection');
  assert.equal(clientIp(req('203.0.113.9', '1.2.3.4')), '203.0.113.9', 'a direct connection: the header is ignored');
});
