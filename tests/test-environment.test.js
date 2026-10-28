import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createTestEnvironment } from './test-environment.mjs';

test('browser checks force an isolated offline profile and clean up their own workspace', async () => {
  const workspace = await createTestEnvironment('isolation');
  let profile, options, routePattern, closed = false;
  const context = {
    route: async pattern => { routePattern = pattern; },
    close: async () => { closed = true; }
  };
  try {
    await workspace.launch({ launchPersistentContext: async (directory, settings) => {
      profile = directory; options = settings; return context;
    } }, { offline: false });
    assert.equal(profile, path.join(workspace.root, 'profile'));
    assert.equal(options.offline, true);
    assert(routePattern.test('https://example.test/'));
    assert(routePattern.test('http://example.test/'));
    assert(!routePattern.test('chrome-extension://test/app.html'));
    await access(workspace.root);
  } finally { await workspace.close(); }
  assert(closed);
  await assert.rejects(access(workspace.root), { code: 'ENOENT' });
});

test('a browser launch failure still removes only the temporary test workspace', async () => {
  const workspace = await createTestEnvironment('launch-failure');
  try {
    await assert.rejects(workspace.launch({ launchPersistentContext: async () => {
      throw new Error('Synthetic launch failure');
    } }), /Synthetic launch failure/);
  } finally { await workspace.close(); }
  await assert.rejects(access(workspace.root), { code: 'ENOENT' });
});
