// Docs: copy buttons, index search, phone index toggle.
(() => {
  const root = document.querySelector('.docs');
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    try { navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).catch(() => undefined); } catch (e) { /* copying is a convenience */ }
    const label = b.lastChild; b.classList.add('done'); label.textContent = 'Copied';
    clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('done'); label.textContent = 'Copy'; }, 1600);
  }));
  const q = document.getElementById('d-q');
  const none = document.querySelector('.d-none');
  if (q) {
    q.addEventListener('input', () => {
      const v = q.value.trim().toLowerCase();
      let any = false;
      document.querySelectorAll('.d-group').forEach((g) => {
        let hit = false;
        g.querySelectorAll('.d-it').forEach((it) => { const ok = !v || it.textContent.toLowerCase().includes(v); it.classList.toggle('hide', !ok); hit = hit || ok; });
        g.classList.toggle('hide', !hit); any = any || hit;
      });
      none.hidden = any;
    });
    document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); } });
  }
  const menu = document.getElementById('d-menu');
  if (menu) menu.addEventListener('click', () => { const open = root.classList.toggle('open'); menu.textContent = open ? 'Close' : 'Index'; menu.setAttribute('aria-expanded', String(open)); });
  // the sheet index follows the reading position
  const links = [...document.querySelectorAll('.d-toclist a')];
  const heads = links.map((a) => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
  const mark = () => { let k = 0; heads.forEach((h, i) => { if (h.getBoundingClientRect().top < 140) k = i; }); links.forEach((a, i) => a.classList.toggle('on', i === k)); };
  window.addEventListener('scroll', mark, { passive: true }); mark();
})();
