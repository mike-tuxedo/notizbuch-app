(function () {
  const root = document.documentElement;
  const KEY = 'nb-proto-theme';
  root.dataset.theme = localStorage.getItem(KEY) ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  const close = (el) => {
    el.hidden = true;
    document.querySelectorAll('[data-toggle="#' + el.id + '"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  };
  const closeAll = () => document.querySelectorAll('[data-pop]:not([hidden])').forEach(close);

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-theme-toggle]')) {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(KEY, root.dataset.theme);
      return;
    }
    const tab = e.target.closest('[role="tab"]');
    if (tab) {
      const box = tab.closest('[data-tabs]');
      box.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      box.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
      return;
    }
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const el = document.querySelector(tg.dataset.toggle);
      const wasOpen = !el.hidden;
      closeAll();
      if (!wasOpen) { el.hidden = false; tg.setAttribute('aria-expanded', 'true'); }
      return;
    }
    if (!e.target.closest('[data-pop]') || e.target.closest('[data-close]')) closeAll();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  let timer;
  window.toast = (msg, action) => {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.innerHTML = '<span></span>';
    t.firstChild.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = action;
      b.onclick = () => { t.remove(); window.toast('Wiederhergestellt'); };
      t.appendChild(b);
    }
    document.body.appendChild(t);
    clearTimeout(timer);
    timer = setTimeout(() => t.remove(), action ? 6000 : 2500);
  };
})();
