// Copies ui's tunnel build (npm run build:tunnel in codeflower-ui) into
// public/: the pairing page, the bootstrap, the service worker. Usage:
//   npm run vendor-ui -- ../ui/dist-tunnel
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const source = process.argv[2];
if (!source || !existsSync(join(source, 'hashes.json'))) {
  console.error('usage: npm run vendor-ui -- <codeflower-ui>/dist-tunnel (run npm run build:tunnel there first)');
  process.exit(1);
}
const target = new URL('../public/', import.meta.url).pathname;
rmSync(join(target, 'tunnel'), { recursive: true, force: true });
for (const name of ['p.html', 'm.html', 'sw.js', 'tunnel']) cpSync(join(source, name), join(target, name), { recursive: true });
// The hashes `codeflower tunnel verify` checks; codeflower-app embeds the same file.
cpSync(join(source, 'hashes.json'), new URL('../ui-hashes.json', import.meta.url).pathname);
const hashes = JSON.parse(readFileSync(join(source, 'hashes.json'), 'utf8'));
console.log(`copied ${Object.keys(hashes).length} files from ${source}`);
