// Private thread on the order card (not the general support chat).
window.createOrderChat = function ({ api, esc, fmtSize, fmtDate, readAsBase64, icons }) {
  let current = null;
  const MAX_BYTES = 8 * 1024 * 1024;

  async function refresh(view = current) {
    if (!view || view !== current) return;
    const request = ++view.request;
    try {
      const { messages } = await api(`/api/order/${view.id}/messages`);
      if (view !== current || request !== view.request) return;
      view.status.textContent = '';
      // Messages are immutable; polling need not rebuild the list or move the scroll position.
      if (view.messages?.length === messages.length && view.messages.at(-1)?.id === messages.at(-1)?.id) return;
      const atEnd = !view.messages || view.box.scrollTop + view.box.clientHeight >= view.box.scrollHeight - 20;
      view.messages = messages;
      view.list.innerHTML = messages.length ? messages.map((m) => {
        const mine = m.from === 'user';
        const file = m.attachment;
        const download = file ? `<button type="button" class="deal-download" data-message="${Number(m.id)}" aria-label="Скачать ${esc(file.name)}">📎 ${esc(file.name)} · ${fmtSize(file.size)} ↓</button>` : '';
        return `<div class="msg ${mine ? 'me' : 'them'}"><div class="msg-bubble">${esc(m.text)}${download}</div><div class="msg-time">${mine ? 'Клиент' : 'Оператор'} · ${fmtDate(m.at)}</div></div>`;
      }).join('') : '<div class="chat-empty">Здесь пока нет сообщений. Можно написать оператору или прикрепить файл.</div>';
      if (atEnd) view.box.scrollTop = view.box.scrollHeight;
    } catch {
      if (view === current && request === view.request) view.status.textContent = 'Не удалось загрузить переписку. Пробуем снова…';
    }
  }

  function show(root, id, demoOperator) {
    if (!root) return;
    root.classList.toggle('hidden', !id);
    if (!id) { current = null; root.replaceChildren(); return; }
    if (current?.id === id && current.root === root) return;
    root.innerHTML = `
      <div class="card-title">Диалог сделки #${Number(id)}</div>
      <div class="f-hint">Не отправляйте код карты или его фото до запроса оператора.</div>
      <div class="chat-box"><div class="chat-list" role="log" aria-label="Сообщения сделки"></div></div>
      <div class="f-hint" data-sync role="status">Загружаем переписку…</div>
      <form>
        ${demoOperator ? '<label class="deal-role"><input type="checkbox" data-operator> Ответить как оператор (демо)</label>' : ''}
        <div class="chat-input">
          <button type="button" class="btn btn-ghost btn-sm" data-pick aria-label="Прикрепить файл" title="Прикрепить файл">📎</button>
          <input type="file" hidden accept="image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf">
          <textarea rows="1" maxlength="2000" placeholder="Сообщение или подпись…" aria-label="Текст сообщения"></textarea>
          <button type="submit" class="btn btn-primary btn-sm" aria-label="Отправить сообщение" disabled>${icons.send}</button>
        </div>
        <div class="deal-picked" hidden><span></span><button type="button" aria-label="Убрать вложение">✕</button></div>
        <div class="f-hint">JPG, PNG, WebP или PDF · до 8 МБ на файл</div>
        <div class="f-err" role="alert"></div>
      </form>`;
    const find = (selector) => root.querySelector(selector);
    const view = current = { id, root, box: find('.chat-box'), list: find('.chat-list'), status: find('[data-sync]'), request: 0 };
    const form = find('form'), input = find('textarea'), picker = find('[type=file]');
    const picked = find('.deal-picked'), send = find('[type=submit]'), error = find('.f-err');
    let sending = false;
    function update() {
      const file = picker.files[0];
      picked.hidden = !file;
      picked.querySelector('span').textContent = file ? `${file.name} · ${fmtSize(file.size)}` : '';
      send.disabled = sending || !(input.value.trim() || file);
    }
    find('[data-pick]').onclick = () => picker.click();
    picked.querySelector('button').onclick = () => { picker.value = ''; error.textContent = ''; update(); };
    input.oninput = update;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!send.disabled) send.click(); }
    };
    picker.onchange = () => {
      const file = picker.files[0];
      error.textContent = '';
      if (file && (!file.size || file.size > MAX_BYTES)) error.textContent = 'Выберите непустой файл размером до 8 МБ.';
      else if (file && !/\.(jpe?g|png|webp|pdf)$/i.test(file.name) && !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) error.textContent = 'Выберите JPG, PNG, WebP или PDF.';
      if (error.textContent) picker.value = '';
      update();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = input.value.trim(), file = picker.files[0];
      if (sending || (!text && !file)) return;
      const prefix = find('[data-operator]')?.checked ? '/api/admin/order' : '/api/order';
      sending = true;
      for (const control of form.elements) control.disabled = true;
      error.textContent = '';
      try {
        const body = { text };
        if (file) body.attachment = { name: file.name, data: await readAsBase64(file) };
        await api(`${prefix}/${id}/messages`, { method: 'POST', body, timeoutMs: 120000 });
        if (current !== view) return;
        input.value = picker.value = '';
        await refresh(view);
        view.box.scrollTop = view.box.scrollHeight;
      } catch (err) {
        error.textContent = err.message || 'Не удалось отправить. Вложение сохранено в форме.';
      } finally {
        sending = false;
        for (const control of form.elements) control.disabled = false;
        update();
      }
    };
    view.list.onclick = async (e) => {
      const button = e.target.closest('[data-message]');
      if (!button) return;
      const message = view.messages.find((m) => m.id === Number(button.dataset.message));
      if (!message?.attachment) return;
      button.disabled = true;
      error.textContent = '';
      try {
        const blob = await api(`/api/order/${id}/messages/${message.id}/attachment`, { binary: true, timeoutMs: 120000 });
        if (view !== current) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = message.attachment.name;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (err) { error.textContent = err.message || 'Не удалось скачать файл.'; }
      finally { button.disabled = false; }
    };
    refresh(view);
  }
  return { show, refresh };
};
