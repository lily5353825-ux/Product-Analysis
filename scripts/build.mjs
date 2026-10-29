import { cp, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const path of ['index.html', 'styles.css', 'app.js', 'importer.js', 'dashboard-metrics.js']) {
  await access(new URL('../src/web/' + path, import.meta.url));
}
await mkdir(root + 'dist', { recursive: true });
await cp(root + 'src/web', root + 'dist', { recursive: true });
console.log('Static dashboard built in dist/');
