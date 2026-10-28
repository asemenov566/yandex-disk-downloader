// Every browser check owns a new temporary profile and synthetic storage.
// Nothing is read from the installed browser or an existing download folder.
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function copyTestExtension(destination) {
  const source = fileURLToPath(new URL('../photo_downloader_smnv', import.meta.url));
  const paths = JSON.parse(await readFile(new URL('../scripts/runtime-files.json', import.meta.url), 'utf8'));
  if (!Array.isArray(paths) || !paths.length) throw new Error('Invalid runtime file list');
  const sourceRoot = await realpath(source);
  if ((await lstat(source)).isSymbolicLink()) throw new Error('Extension root must not be a link');
  for (const relative of paths) {
    if (typeof relative !== 'string' || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) {
      throw new Error('Unsafe runtime file path');
    }
    let current = source;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Runtime links are not permitted');
    }
    const resolved = await realpath(current);
    if (!resolved.startsWith(sourceRoot + path.sep) || !(await lstat(resolved)).isFile()) throw new Error('Runtime file leaves the source directory');
    const output = path.join(destination, ...relative.split('/'));
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(resolved, output);
  }
}

export async function createTestEnvironment(label) {
  if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid test workspace label');
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, 'photo-downloader-test-' + label + '-'));
  let context, extensionId;
  return {
    root,
    get extensionId() { return extensionId; },
    async launch(chromium, options = {}) {
      const { extensionPath, ...launchOptions } = options;
      const args = [...(launchOptions.args || []), '--enable-unsafe-extension-debugging'];
      const ignoreDefaultArgs = [...new Set([...(launchOptions.ignoreDefaultArgs || []), '--disable-extensions'])];
      context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
        ...launchOptions, args, ignoreDefaultArgs, offline: true
      });
      // Offline also covers service workers; routing blocks unexpected page requests.
      await context.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
      if (extensionPath) {
        const session = await context.browser().newBrowserCDPSession();
        ({ id: extensionId } = await session.send('Extensions.loadUnpacked', { path: extensionPath }));
        await session.detach();
      }
      return context;
    },
    async close() {
      try { await context?.close(); }
      finally {
        // Delete only the exact temporary directory created by this invocation.
        const resolved = await realpath(root);
        if (resolved !== root || path.dirname(resolved) !== parent) throw new Error('Test workspace path changed');
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  };
}
