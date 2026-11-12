// Writes ready-to-paste cloud-init files (Oracle Cloud and AWS) with the PosiNext Cloud admin key to %USERPROFILE%\.dinepos\cloud\.
// The key is made once and reused on later runs (delete admin-key.txt for a new one). It stays out of the repo.
// Usage: node hub/deploy/make-cloud-init.ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(homedir(), '.dinepos', 'cloud');
const keyFile = join(outDir, 'admin-key.txt');

mkdirSync(outDir, { recursive: true });
const existing = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '';
const key = existing || randomBytes(24).toString('base64url');
if (!existing) writeFileSync(keyFile, `${key}\n`);
for (const name of ['oracle-cloud-init.yaml', 'aws-cloud-init.yaml']) {
  const file = join(outDir, name);
  // the setting itself (the file's header comment also names the placeholder)
  const text = readFileSync(join(here, name), 'utf8').replace('HUB_ADMIN_KEY=__HUB_ADMIN_KEY__', `HUB_ADMIN_KEY=${key}`);
  if (!text.includes(`HUB_ADMIN_KEY=${key}`)) throw new Error(`${name} has no HUB_ADMIN_KEY=__HUB_ADMIN_KEY__ line`);
  writeFileSync(file, text);
  console.log(`Cloud-init file: ${file}`);
}
console.log(`Admin key (${existing ? 'the one made before' : 'new'}, also in ${keyFile}): ${key}`);
