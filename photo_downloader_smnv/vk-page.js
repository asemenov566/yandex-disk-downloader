// Serialized by chrome.scripting into the authorized VK tab's MAIN world.
// Keep self-contained. The web token never leaves this function/page.
export async function vkPageRequest(request) {
  const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
  const url = new URL(location.href);
  let peer = url.pathname.match(/^\/im\/convo\/(-?\d+)\/?$/)?.[1];
  if (!peer && /^\/im\/?$/.test(url.pathname)) {
    const sel = url.searchParams.get('sel') || '';
    if (/^-?\d+$/.test(sel)) peer = sel;
    else if (/^c\d+$/.test(sel)) peer = String(2000000000 + Number(sel.slice(1)));
  }
  if (url.protocol !== 'https:' || !['vk.ru', 'vk.com', 'www.vk.ru', 'www.vk.com'].includes(url.hostname) ||
      !peer || Number(peer) !== request.peerId) return fail('Откройте нужный диалог ВК и нажмите «Продолжить».', { vkSession: true });
  const session = window.vk;
  if (!session?.id || session.webToken?.is_anonym || !session.webToken?.access_token) {
    return fail('Войдите в ВК в этой вкладке и нажмите «Продолжить».', { vkSession: true, recoverable: true });
  }
  const title = document.querySelector('.ConvoHeader__title .ConvoTitle__author, .ConvoHeader .ConvoTitle__author, .ConvoHeader__title, .im-page--title-main')?.textContent?.trim();
  if (['prepare', 'ready'].includes(request.action) && !title) return fail('Не удалось прочитать название диалога. Дождитесь его открытия и нажмите «Продолжить».', { vkSession: true, recoverable: true });
  if (request.action === 'ready' || request.action === 'prepare') return { ok: true, value: { title } };
  if (!['prepare', 'page', 'photo'].includes(request.action)) return fail('Неизвестная операция ВК.');
  const mediaType = request.mediaType || 'photo';
  if (!['photo', 'video'].includes(mediaType)) return fail('Неизвестный тип вложений ВК.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  async function call(method, values) {
    const body = new URLSearchParams({ ...values, access_token: session.webToken.access_token });
    const response = await fetch('https://web.api.vk.ru/method/' + method + '?v=5.289&client_id=6287487', {
      method: 'POST', credentials: 'include', body, signal: controller.signal
    });
    if (!response.ok) throw fail('ВК (' + method + '): HTTP ' + response.status, { status: response.status, recoverable: response.status === 401,
      vkSession: response.status === 401, retryable: response.status === 429 || response.status >= 500 });
    const data = await response.json();
    if (data.error) {
      const code = Number(data.error.error_code);
      // Never return API error_msg/request_params, which can echo credentials.
      throw fail([5, 15, 27, 28].includes(code) ? 'ВК: доступ к диалогу недоступен (код ' + code + '). Обновите вкладку и проверьте вход.' :
        'ВК (' + method + '): ошибка API ' + code + '. Повторите позже.', {
          vkSession: [5, 15, 27, 28].includes(code), recoverable: [5, 27, 28].includes(code), retryable: [1, 6, 9, 10, 29].includes(code), apiCode: code
        });
    }
    return data.response;
  }
  try {
    let startCmid = request.startCmid;
    if (!request.cursor && !Number.isSafeInteger(startCmid)) {
      // The messenger starts attachment pagination from lastCmid(history).
      // Obtain it independently of the photo panel or the user's scroll position.
      const history = await call('messages.getHistory', { peer_id: String(request.peerId), count: '1', offset: '0', extended: '0', group_id: '0' });
      if (!Array.isArray(history?.items)) return fail('ВК не вернул начальную позицию диалога.');
      if (!history.items.length) return { ok: true, value: { items: [], startCmid: 0 } };
      startCmid = history.items[0].conversation_message_id;
      if (!Number.isSafeInteger(startCmid) || startCmid <= 0) return fail('ВК не вернул номер последнего сообщения диалога.');
    }
    if (!request.cursor && startCmid === 0) return { ok: true, value: { items: [], startCmid } };
    const params = { peer_id: String(request.peerId), attachment_types: mediaType, extended: '0', group_id: '0',
      offset: request.cursor && request.action !== 'photo' ? '1' : '0', count: '30' };
    if (request.cursor) {
      params.cmid = String(request.cursor.cmid);
      params.attachment_position = String(request.cursor.position);
    } else params.cmid = String(startCmid);
    const data = await call('messages.getHistoryAttachments', params);
    if (!Array.isArray(data?.items)) return fail('ВК вернул ответ без списка вложений.');
    const size = s => s && ({ type: s.type, width: s.width, height: s.height, url: s.url });
    return { ok: true, value: { ...(Number.isSafeInteger(startCmid) ? { startCmid } : {}), items: data.items.map(item => ({ cmid: item.cmid, position: item.position, date: item.date,
      attachment: { type: item.attachment?.type, ...(mediaType === 'photo' ? { photo: item.attachment?.photo && {
        id: item.attachment.photo.id, owner_id: item.attachment.photo.owner_id, date: item.attachment.photo.date,
        access_key: /^[a-f0-9]{1,128}$/i.test(item.attachment.photo.access_key || '') ? item.attachment.photo.access_key : undefined,
        orig_photo: size(item.attachment.photo.orig_photo), sizes: item.attachment.photo.sizes?.map(size)
      } } : { video: item.attachment?.video && {
        id: item.attachment.video.id, owner_id: item.attachment.video.owner_id, title: item.attachment.video.title, date: item.attachment.video.date,
        files: { ...Object.fromEntries(Object.entries(item.attachment.video.files || {}).filter(([key, value]) => /^mp4_\d+$/.test(key) && typeof value === 'string')),
          ...(item.attachment.video.files?.external ? { external: true } : {}) }
      } }) }
    })) } };
  } catch (error) {
    return error?.ok === false ? error : fail('ВК не ответил за 30 секунд или соединение прервано.', { retryable: true, recoverable: true });
  } finally { clearTimeout(timer); }
}
