import { parseVkLink, validCursor } from './vk.js';
import { vkPageRequest } from './vk-page.js';
import { waitFor } from './wait.js';

export async function handleVkRequest(message, browser = chrome, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const target = parseVkLink(message.link);
  if (!target || !['prepare', 'page', 'photo', 'recover'].includes(message.action) ||
      (message.cursor != null && !validCursor(message.cursor)) || (message.action === 'photo' && !message.cursor) ||
      (message.mediaType != null && !['photo', 'video'].includes(message.mediaType)) ||
      (message.recover != null && typeof message.recover !== 'boolean') ||
      (message.deferRecovery != null && typeof message.deferRecovery !== 'boolean') ||
      (message.startCmid != null && (!Number.isSafeInteger(message.startCmid) || message.startCmid < 0))) {
    throw new Error('Некорректный запрос диалога ВК.');
  }
  let tab;
  if (message.action === 'prepare' && !message.recover) {
    const tabs = await browser.tabs.query({ url: ['https://vk.ru/*', 'https://vk.com/*', 'https://www.vk.ru/*', 'https://www.vk.com/*'] });
    tab = tabs.filter(t => parseVkLink(t.url)?.peerId === target.peerId).sort((a, b) => Number(b.active) - Number(a.active))[0];
    if (!tab) tab = await browser.tabs.create({ url: target.publicUrl, active: true });
  } else {
    if (!Number.isInteger(message.tabId)) throw new Error('Нет вкладки ВК. Нажмите «Продолжить».');
    try { tab = await browser.tabs.get(message.tabId); }
    catch { return { ok: false, error: 'Вкладка ВК закрыта. Откройте диалог и нажмите «Продолжить».', vkSession: true }; }
  }
  if (parseVkLink(tab.url)?.peerId !== target.peerId) return { ok: false,
    error: 'Вкладка перешла на другую страницу. Откройте нужный диалог и нажмите «Продолжить».', vkSession: true };
  const tabId = tab.id;
  let recoveryAttempted = false;
  const fail = (error, extra = {}) => ({ ok: false, error, tabId, recoveryAttempted, ...extra });
  async function currentTab() {
    let current;
    try { current = await browser.tabs.get(tabId); }
    catch { throw fail('Вкладка ВК закрыта. Откройте диалог и нажмите «Продолжить».', { vkSession: true }); }
    if (parseVkLink(current.url)?.peerId !== target.peerId ||
        (current.pendingUrl && parseVkLink(current.pendingUrl)?.peerId !== target.peerId)) {
      throw fail('Вкладка перешла на другую страницу. Откройте нужный диалог и нажмите «Продолжить».', { vkSession: true });
    }
    return current;
  }
  async function execute(action, timeout = 35000) {
    await currentTab();
    const [result] = await waitFor(browser.scripting.executeScript({ target: { tabId }, world: 'MAIN',
      func: vkPageRequest, args: [{ action, peerId: target.peerId, cursor: message.cursor || null,
        mediaType: message.mediaType || 'photo', startCmid: message.startCmid }] }), { timeout });
    return result?.result || fail('Вкладка ВК не ответила.', { recoverable: true });
  }
  try {
    if (message.deferRecovery && message.action !== 'recover' && (tab.discarded || tab.frozen || tab.status === 'loading')) {
      await currentTab();
      return fail('ВК: вкладка ещё не готова.', { recoverable: true, reloadRequired: !!(tab.discarded || tab.frozen) });
    }
    if (message.recover || tab.discarded || tab.frozen) {
      await currentTab();
      recoveryAttempted = true;
      // Restore only this dialogue, without changing focus or pagination.
      await browser.tabs.reload(tabId);
      tab = await currentTab();
    }
    if (message.action === 'recover' || recoveryAttempted || tab.status === 'loading') {
      const deadline = now() + 20000;
      let ready;
      do {
        await sleep(500);
        tab = await currentTab();
        if (tab.status === 'loading' || tab.discarded || tab.frozen) continue;
        try { ready = await execute('ready', 2000); }
        catch (error) { if (error?.ok === false) throw error; }
        if (ready?.ok) break;
        if (ready && !ready.recoverable) return { ...ready, tabId, recoveryAttempted };
      } while (now() < deadline);
      if (!ready?.ok) return fail('ВК не восстановил диалог. Проверьте вход в аккаунт и нажмите «Продолжить».',
        { vkSession: true, recoverable: !recoveryAttempted });
      if (message.action === 'recover') return { ...ready, tabId, recoveryAttempted };
    }
    return { ...await execute(message.action), tabId, recoveryAttempted };
  } catch (error) {
    // Never return browser error text (it can contain page data).
    if (error?.ok === false) return error;
    return fail('Вкладка ВК не ответила. Не удалось выполнить запрос.', { recoverable: !recoveryAttempted, retryable: true });
  }
}
