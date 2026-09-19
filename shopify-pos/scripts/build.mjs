import {build} from 'esbuild';
import {mkdir, readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';

await mkdir('dist', {recursive: true});
for (const extension of await readdir('extensions')) {
 const directory = path.join('extensions', extension);
 const config = await readFile(path.join(directory, 'shopify.extension.toml'), 'utf8');
 for (const match of config.matchAll(/^module\s*=\s*"([^"]+)"/gm)) {
  const name = path.basename(match[1]).replace(/\.[jt]sx?$/, '');
  const outfile = `dist/${extension}/${name}.js`;
  await build({
    entryPoints: [path.join(directory, match[1])],
    outfile,
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
  });
  const {size} = await stat(outfile);
  if (size > 64 * 1024) throw new Error(`${name} exceeds Shopify's 64 KB UI extension limit.`);
  console.log(`${extension}/${name}: ${size} bytes`);
 }
}
