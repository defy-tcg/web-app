import {build} from 'esbuild';
import {mkdir, readdir, readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import path from 'node:path';

await mkdir('dist', {recursive: true});
for (const extension of await readdir('extensions')) {
 const directory = path.join('extensions', extension);
 const config = await readFile(path.join(directory, 'shopify.extension.toml'), 'utf8');
 let compressedTotal = 0;
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
  const bundle = await readFile(outfile);
  const compressed = gzipSync(bundle).byteLength;
  compressedTotal += compressed;
  console.log(`${extension}/${name}: ${bundle.byteLength} bytes, ${compressed} gzip bytes`);
 }
 // Shopify limits compressed JavaScript per extension, not raw bytes per module.
 // Summing separately compressed targets is conservative about shared runtime code.
 // https://shopify.dev/docs/apps/build/app-extensions/optimize-bundle-size
 if (compressedTotal > 64 * 1024) throw new Error(`${extension} exceeds the 64 KB compressed UI extension budget.`);
}
