// Sekme gezinmesi (sadece arayuz). app.js ve sunucu ile hicbir bagi yoktur:
// tum bolumler DOM'da kalir, sadece gorunurluk degisir; bu yuzden app.js'in
// render/polling/WebSocket akisi sekme degisse de aynen calismaya devam eder.
(() => {
  'use strict';
  const STORE_KEY = 'panelTab';
  const btns = Array.from(document.querySelectorAll('.tabBar .tabBtn'));
  const panels = Array.from(document.querySelectorAll('.tabPanel'));
  if (!btns.length || !panels.length) return;
  const names = btns.map((b) => b.dataset.tab);

  function saved() {
    try { return localStorage.getItem(STORE_KEY); } catch (_) { return null; }
  }
  function save(name) {
    try { localStorage.setItem(STORE_KEY, name); } catch (_) { /* depolama kapali olabilir */ }
  }

  function show(name, { scroll = true, focus = false } = {}) {
    if (!names.includes(name)) name = names[0];
    btns.forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    panels.forEach((p) => { p.hidden = p.dataset.tab !== name; });
    save(name);
    try { history.replaceState(null, '', '#' + name); } catch (_) { /* yoksay */ }
    if (scroll) window.scrollTo(0, 0);
    // Grafik gizliyken olculemez (app.js drawChart genisligi 0 ise cizmez);
    // sekme gorununce app.js'in mevcut resize dinleyicisi yeniden cizsin.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  btns.forEach((b, i) => {
    b.addEventListener('click', () => show(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % btns.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = btns.length - 1;
      if (j < 0) return;
      e.preventDefault();
      show(btns[j].dataset.tab, { scroll: false, focus: true });
    });
  });

  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (names.includes(h)) show(h, { scroll: false });
  });

  const fromHash = location.hash.replace('#', '');
  show(names.includes(fromHash) ? fromHash : (saved() || names[0]), { scroll: false });
})();

// Katlanir bolumler (sadece arayuz): acik/kapali durum tarayicida hatirlanir.
(() => {
  'use strict';
  document.querySelectorAll('details.fold[id]').forEach((d) => {
    const key = 'fold:' + d.id;
    try {
      const v = localStorage.getItem(key);
      if (v === 'open') d.open = true;
      else if (v === 'closed') d.open = false;
    } catch (_) { /* depolama kapali olabilir */ }
    d.addEventListener('toggle', () => {
      try { localStorage.setItem(key, d.open ? 'open' : 'closed'); } catch (_) { /* yoksay */ }
      // Grafik gibi olculen ogeler gorununce yeniden cizilsin.
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  });
})();
