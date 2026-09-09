import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'public', 'scripts', 'test']) {
  for (const file of await readdir(directory)) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0 || result.error) process.exit(1);
  }
}
console.log('JavaScript syntax checks passed.');
