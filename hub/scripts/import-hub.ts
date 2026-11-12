// Imports another hub (the Tiffin order hub) into PosiNext Cloud: its database and its stores' online backups.
// Stop both hubs first (deploy/merge-tiffin.sh does). Safe to run again: nothing already here is copied twice.
//
//   node scripts/import-hub.ts --from /var/lib/tiffin-hub --to /var/lib/posinext-cloud [--dry-run]
//
// --dry-run imports into a copy of the PosiNext Cloud database and prints what would happen; nothing is changed.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hub } from '../src/hub.ts';
import { importHub, ImportConflict } from '../src/importHub.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const from = arg('--from'), to = arg('--to');
const dry = process.argv.includes('--dry-run');
if (!from || !to) { console.error('usage: node scripts/import-hub.ts --from <old hub data dir> --to <PosiNext Cloud data dir> [--dry-run]'); process.exit(2); }
const srcDb = join(from, 'hub.db');
if (!existsSync(srcDb)) { console.error(`No hub database at ${srcDb}.`); process.exit(2); }

// a dry run works on a copy of the target database
let targetDir = to;
let scratch: string | null = null;
if (dry) {
  scratch = mkdtempSync(join(tmpdir(), 'import-dry-'));
  if (existsSync(join(to, 'hub.db'))) {
    const live = new DatabaseSync(join(to, 'hub.db'), { readOnly: true });
    live.exec(`VACUUM INTO '${join(scratch, 'hub.db').replace(/'/g, "''")}'`); // a consistent copy, even with a WAL
    live.close();
  }
  targetDir = scratch;
}

const target = new Hub({ dbPath: join(targetDir, 'hub.db') }); // opening it brings its tables up to date
const source = new DatabaseSync(srcDb, { readOnly: true });
let code = 0;
try {
  const r = importHub(target.db, source);
  const rows = Object.entries(r.tables).map(([t, x]) => `  ${t.padEnd(14)} ${String(x.copied).padStart(7)} copied ${String(x.alreadyHere).padStart(7)} already here`);
  console.log(`${dry ? 'DRY RUN (nothing changed). ' : ''}Imported ${from} into ${to}:\n${rows.join('\n')}`);
  for (const x of r.renamed) console.log(`  ! ${x.kind} "${x.from}" was taken here: now "${x.to}" (its ordering page is /order/${x.to}; tell the shop)`);
  if (r.settingsKept.length) console.log(`  Hub settings kept as they are here (they differ in the old hub): ${r.settingsKept.join(', ')}`);
  console.log(`  UrbanPiper: ${{ none: 'no account in either hub', copied: "the old hub's account was copied", 'same-business': 'same business in both: kept this one', 'only-here': 'only this hub has an account' }[r.urbanpiper]}`);
  if (r.legacyWebhookToken) console.log("  The old hub's UrbanPiper webhook secret is still accepted. Run Hub settings > Set up order links once to move every webhook here.");

  // each store's online backups (files, not in the database)
  let copiedStores = 0;
  const srcBackups = join(from, 'backups');
  if (existsSync(srcBackups)) {
    for (const id of readdirSync(srcBackups)) {
      if (!r.storeIds.includes(id)) continue;
      const dest = join(targetDir, 'backups', id);
      if (existsSync(dest)) continue;
      if (!dry) cpSync(join(srcBackups, id), dest, { recursive: true });
      copiedStores++;
    }
  }
  console.log(`  Online backups: ${copiedStores} store folder(s) ${dry ? 'would be ' : ''}copied`);
} catch (e) {
  if (e instanceof ImportConflict) { console.error(`STOPPED, nothing imported: ${e.message}`); code = 3; }
  else { console.error(`FAILED, nothing imported: ${(e as Error).message}`); code = 1; }
} finally {
  source.close();
  target.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(code);
