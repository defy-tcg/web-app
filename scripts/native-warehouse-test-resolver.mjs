import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.NATIVE_SOURCE_ROOT;
if (!root) throw new Error('NATIVE_SOURCE_ROOT is required.');
// Test-only resolver for the repository's Next.js extensionless TypeScript
// imports. Production source and dependency versions remain unchanged.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(resolve(root, specifier.slice(2) + '.ts')).href, context);
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('next/')) return nextResolve(specifier + '.js', context);
      throw error;
    }
  },
});
