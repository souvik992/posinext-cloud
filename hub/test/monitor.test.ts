import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';
import { HostedOutlets } from '../src/hosted.ts';
import { Monitor } from '../src/monitor.ts';
import { exec } from '../src/db.ts';
import { cleanup } from './helpers.ts';

// Monitoring: a hosted outlet down over a minute and failing or stale backups are problems; alerts go to the webhook
// once (then every 6 hours), and again when resolved; /health/deep is 503 while any is open.
test('monitor: hosted outlet down, backups, alerts and /health/deep', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-monitor-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db') });
  const store = hub.createStore('spice-garden', 'Spice Garden');
  // a hosted outlet whose server is not running (no server bundle needed for this)
  const hosted = new HostedOutlets(hub, { serverEntry: join(dir, 'none.mjs'), dataRoot: dir });
  exec(hub.db, 'INSERT INTO hosted_outlet (store_id, port, host_key, enabled, created_at) VALUES (?, 5999, ?, 1, 0)', store.storeId, 'k'.repeat(43));
  let t = Date.parse('2026-11-07T10:00:00Z');
  const sent: string[] = [];
  const statusFile = join(dir, 'backup-status.json');
  const monitor = new Monitor(hub, {
    hosted,
    backupStatusFile: statusFile,
    webhook: 'https://hooks.example/abc',
    now: () => t,
    fetch: async (_url, init) => {
      sent.push(String(JSON.parse(String(init?.body)).text));
      return new Response('ok');
    },
  });
  try {
    // down for less than a minute: a restart, not yet a problem
    assert.deepEqual((await monitor.tick()).problems, []);
    t += 61_000;
    let r = await monitor.tick();
    assert.equal(r.ok, false);
    assert.deepEqual(r.hosted, { total: 1, running: 0, down: ['spice-garden'] });
    assert.match(r.problems[0]!, /Hosted outlet spice-garden is down/);
    assert.equal(sent.length, 1);
    await monitor.tick(); // still down: no repeat yet
    assert.equal(sent.length, 1);
    t += 6 * 3_600_000; // a reminder every 6 hours
    await monitor.tick();
    assert.equal(sent.length, 2);

    // /health/deep, for an uptime service
    const server = createHubServer(hub, { adminKey: 'admin-key', hosted, monitor });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const deep = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/health/deep`);
    assert.equal(deep.status, 503);
    assert.deepEqual(((await deep.json()) as { hosted: { down: string[] } }).hosted.down, ['spice-garden']);
    await new Promise<void>((res) => {
      server.close(() => res());
      server.closeAllConnections();
    });

    // switched off: resolved, and said so
    exec(hub.db, 'UPDATE hosted_outlet SET enabled = 0');
    r = await monitor.tick();
    assert.equal(r.ok, true);
    assert.match(sent.at(-1)!, /resolved: Hosted outlet spice-garden is down/);

    // backups: failed, then fine, then not run for over two hours
    writeFileSync(statusFile, JSON.stringify({ at: new Date(t).toISOString(), ok: false, outlets: 0, target: 'this server only', offsite: false, error: 'the copy to S3 failed' }));
    assert.match((await monitor.tick()).problems[0]!, /Backups failed: the copy to S3 failed/);
    writeFileSync(statusFile, JSON.stringify({ at: new Date(t).toISOString(), ok: true, outlets: 1, target: 's3://bucket', offsite: true, error: null }));
    assert.equal((await monitor.tick()).ok, true);
    t += 3 * 3_600_000;
    assert.match((await monitor.tick()).problems[0]!, /Backups have not run since/);
  } finally {
    hub.close();
    cleanup(dir);
  }
});
