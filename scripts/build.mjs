import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const target = join(root, 'dist');
await rm(target, { recursive: true, force: true });
await cp(join(root, 'web'), target, { recursive: true });
await mkdir(join(target, 'vendor'), { recursive: true });
for (const [pkg, file, output] of [
  ['pdf-lib', 'pdf-lib.min.js', 'pdf-lib.js'],
  ['@pdf-lib/fontkit', 'fontkit.umd.min.js', 'fontkit.js'],
]) {
  const packageRoot = dirname(require.resolve(pkg + '/package.json'));
  await cp(join(packageRoot, 'dist', file), join(target, 'vendor', output));
}
await cp(join(dirname(require.resolve('pdf-lib/package.json')), 'LICENSE.md'), join(target, 'vendor', 'pdf-lib-LICENSE.md'));
