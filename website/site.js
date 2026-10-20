// UI DNA · drawing set. One long track of sheets scrolled sideways, rulers and a helix that read
// the track position, a page that measures itself, and the interactive drawings on each sheet.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  const HQ = matchMedia('(min-width: 960px) and (min-height: 600px)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isH = () => HQ.matches;
  const track = $('#track');
  const sheets = $$('.sheet', track);
  const unit = (sheet) => (isH() ? sheet.getBoundingClientRect().height / 776 : 1);
  const LOGO = '<svg viewBox="0 0 22 22" aria-hidden="true"><path d="M7 3.5c0 4.5 8 3 8 7.5s-8 3-8 7.5" fill="none" stroke="#121211" stroke-width="1.6"/><path d="M15 3.5c0 4.5-8 3-8 7.5s8 3 8 7.5" fill="none" stroke="#2244ff" stroke-width="1.6"/></svg>';

  // ─── Fixture A miniature ───
  const FIG = '<svg viewBox="0 0 520 400" aria-hidden="true"><rect width="520" height="400" rx="16" fill="#e7edff"/><g fill="none" stroke="#2f5bea" stroke-width="3" stroke-linecap="round"><path d="M120 120 L260 200"/><path d="M260 200 L400 110"/><path d="M260 200 L300 300"/><path d="M120 120 L160 280"/><path d="M160 280 L300 300"/></g><g fill="#ffffff" stroke="#dfe3ec"><rect x="70" y="90" width="100" height="60" rx="10"/><rect x="350" y="80" width="100" height="60" rx="10"/><rect x="110" y="250" width="100" height="60" rx="10"/></g><rect x="210" y="170" width="100" height="60" rx="10" fill="#2f5bea"/><rect x="250" y="270" width="100" height="60" rx="10" fill="#1f9d6a"/><g fill="#c8d0e0"><rect x="84" y="106" width="60" height="6" rx="3"/><rect x="84" y="120" width="40" height="6" rx="3"/><rect x="364" y="96" width="60" height="6" rx="3"/><rect x="124" y="266" width="60" height="6" rx="3"/></g><g fill="#ffffff" opacity=".9"><rect x="224" y="186" width="60" height="6" rx="3"/><rect x="224" y="200" width="44" height="6" rx="3"/><rect x="264" y="286" width="60" height="6" rx="3"/></g></svg>';
  const CARDS = [['#2f5bea', 'Capture quickly', 'Jot down a thought in a second. Lumen files it where it belongs and keeps it searchable.'], ['#1f9d6a', 'Link naturally', 'Mention a note and the link is made. Backlinks show you what connects to what.'], ['#d98a1f', 'Review calmly', 'A daily digest surfaces the notes that matter today, so nothing important is lost.']];
  function mini(kind) {
    const st = kind === 'styles';
    const a = (k, s) => ` data-k="${k}"` + (st && s ? ` data-st="${s}"` : '');
    const fig = kind === 'rebuild' ? '<span class="m-ph">illustration.svg<br>asset not authorized<br>labeled placeholder</span>' : FIG;
    const cards = CARDS.map(([c, t, b], i) => `<span class="m-card bx"${a('card' + (i + 1), i === 0 ? 'r 12 · pad 24' : '')}><span class="m-ic" style="background: ${c}"></span><span class="m-ct">${t}</span><span class="m-cb">${b}</span></span>`).join('');
    return `<div class="m"><div class="m-header bx"${a('header')}><div class="m-nav"><span class="m-brand bx"${a('brand', '20 · 700')}><i></i>Lumen</span><span class="m-menu bx"${a('menu', '15 · 500')}><span class="m-link">Features</span><span class="m-link">Pricing</span><span class="m-link">FAQ</span><span class="m-cta bx"${a('cta', 'r 999')}>Get started</span></span><span class="m-toggle bx"${a('toggle')}><i></i><i></i><i></i></span></div></div><div class="m-hero"><div class="m-copy"><span class="m-eyebrow bx"${a('eyebrow', '13 · 600')}>Now in public beta</span><span class="m-h1 bx"${a('h1', '48/52.8 · 700')}>Notes that think with you</span><span class="m-lead bx"${a('lead', '18 · #5b6474')}>Lumen keeps your ideas connected. Write, link and revisit, and let structure appear on its own.</span><span class="m-actions"><span class="m-btn m-btn-p bx"${a('btnp', '#2f5bea · r 12')}>Start writing</span><span class="m-btn m-btn-s bx"${a('btns')}>See how it works</span></span></div><span class="m-figure bx"${a('figure', 'img')}>${fig}</span></div><div class="m-features"><span class="m-h2 bx"${a('h2', '32/38.4 · 700')}>Everything in one place</span><span class="m-grid"${a('grid', 'gap 24')}>${cards}</span></div></div>`;
  }
  $$('.mini[data-mini]').forEach((el) => { el.innerHTML = mini(el.dataset.mini); });

  // ─── Title blocks ───
  sheets.forEach((s) => {
    const tb = document.createElement('div');
    tb.className = 'tb';
    tb.setAttribute('aria-hidden', 'true');
    tb.innerHTML = `<div>${LOGO}<span class="tb-n">${s.dataset.n}</span></div><div><span>Sheet</span><b>${s.dataset.n} / 09</b></div><div><span>Title</span><b>${s.dataset.name}</b></div><div><span>Rev · scale</span><b>0.3.0 · <span data-scale>1.00</span></b></div>`;
    s.appendChild(tb);
  });

  // ─── Leaders: a shoulder from the callout, then a straight line to a dot on the target ───
  function lead(sheet) {
    const svg = $(':scope > svg.ink', sheet);
    if (!svg) return;
    const sr = sheet.getBoundingClientRect();
    if (!sr.width) return;
    const s = unit(sheet);
    let out = '';
    $$('[data-lead]', sheet).forEach((co) => {
      if (!co.offsetParent || getComputedStyle(co).display === 'none') return;
      const t = $(co.dataset.lead, sheet);
      if (!t) return;
      const cr = co.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      const [ax, ay] = (co.dataset.at || '.5,.5').split(',').map(Number);
      const tx = tr.left + tr.width * ax - sr.left;
      const ty = tr.top + tr.height * ay - sr.top;
      const tone = co.dataset.tone || 'ink';
      const hot = co.classList.contains('hot') ? ' hot' : '';
      let d;
      if (co.classList.contains('bal')) {
        const cx = cr.left + cr.width / 2 - sr.left;
        const cy = cr.top + cr.height / 2 - sr.top;
        const len = Math.hypot(tx - cx, ty - cy) || 1;
        d = `M${cx + ((tx - cx) / len) * cr.width / 2} ${cy + ((ty - cy) / len) * cr.height / 2}L${tx} ${ty}`;
      } else {
        const left = tx < cr.left - sr.left;
        const sx = left ? cr.left - sr.left : cr.right - sr.left;
        const sy = cr.top - sr.top + Math.min(cr.height / 2, 14 * s);
        d = `M${sx} ${sy}h${(left ? -1 : 1) * 18 * s}L${tx} ${ty}`;
      }
      out += `<path pathLength="1" class="t-${tone}${hot}" d="${d}"/><circle class="t-${tone}" cx="${tx}" cy="${ty}" r="${2.6 * s}"/>`;
    });
    svg.innerHTML = out;
  }
  const leadAll = () => sheets.forEach(lead);
  function relead(sheet, ms) {
    const end = performance.now() + ms;
    const step = () => { lead(sheet); if (performance.now() < end) requestAnimationFrame(step); };
    step();
  }

  // ─── Track motion ───
  let target = null;
  let anim = 0;
  const maxX = () => track.scrollWidth - track.clientWidth;
  function glide() {
    anim = 0;
    if (target === null) return;
    const cur = track.scrollLeft;
    const d = target - cur;
    if (Math.abs(d) < 1 || reduce) { track.scrollLeft = target; target = null; return; }
    let step = d * 0.16;
    if (Math.abs(step) < 1) step = Math.sign(d);
    track.scrollLeft = cur + step;
    anim = requestAnimationFrame(glide);
  }
  function goX(x) {
    target = clamp(x, 0, maxX());
    if (!anim) anim = requestAnimationFrame(glide);
  }
  function current() {
    if (isH()) {
      const x = track.scrollLeft + track.clientWidth * 0.4;
      let i = 0;
      sheets.forEach((s, k) => { if (s.offsetLeft <= x) i = k; });
      return i;
    }
    const y = window.scrollY + innerHeight * 0.4;
    let i = 0;
    sheets.forEach((s, k) => { if (s.offsetTop <= y) i = k; });
    return i;
  }
  function goSheet(i) {
    i = clamp(i, 0, sheets.length - 1);
    if (isH()) goX(sheets[i].offsetLeft);
    else sheets[i].scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  }
  $('#app').addEventListener('wheel', (e) => {
    if (!isH() || e.ctrlKey) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { target = null; return; }
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? track.clientWidth : 1;
    goX((target ?? track.scrollLeft) + e.deltaY * k * 1.15);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    if (e.key === 'x' || e.key === 'X') { xray(); return; }
    if (!isH()) return;
    const onControl = /^(BUTTON|A)$/.test(el.tagName) || el.getAttribute('role') === 'button';
    const base = target ?? track.scrollLeft;
    const i = current();
    const keys = {
      ArrowRight: () => goX(base + 160), ArrowDown: () => goX(base + 160),
      ArrowLeft: () => goX(base - 160), ArrowUp: () => goX(base - 160),
      PageDown: () => goSheet(i + 1), PageUp: () => goSheet(i - 1),
      Home: () => goX(0), End: () => goX(maxX()),
    };
    if (e.key === ' ' && !onControl) { e.preventDefault(); goSheet(e.shiftKey ? i - 1 : i + 1); return; }
    if (keys[e.key] && !(onControl && el.closest('svg'))) { e.preventDefault(); keys[e.key](); }
  });
  $$('[data-go]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    goSheet(sheets.findIndex((s) => s.id === a.dataset.go));
  }));

  // ─── Locus bar ───
  const loci = $('#loci');
  const win = $('#win');
  loci.innerHTML = sheets.map((s, i) => `<button type="button" data-i="${i}" aria-label="Sheet ${s.dataset.n}, ${s.dataset.name}"><b>${s.dataset.n}</b><span>${s.dataset.name}</span></button>`).join('');
  $$('button', loci).forEach((b) => b.addEventListener('click', () => goSheet(Number(b.dataset.i))));
  function placeWin() {
    if (!isH()) return;
    const W = loci.clientWidth;
    const sw = track.scrollWidth || 1;
    win.style.left = (track.scrollLeft / sw) * W + 'px';
    win.style.width = Math.max(24, (track.clientWidth / sw) * W) + 'px';
  }
  let dragFrom = null;
  win.addEventListener('pointerdown', (e) => { dragFrom = { x: e.clientX, left: track.scrollLeft }; win.setPointerCapture(e.pointerId); win.classList.add('drag'); target = null; });
  win.addEventListener('pointermove', (e) => { if (!dragFrom) return; track.scrollLeft = dragFrom.left + (e.clientX - dragFrom.x) * (track.scrollWidth / loci.clientWidth); });
  const endDrag = () => { dragFrom = null; win.classList.remove('drag'); };
  win.addEventListener('pointerup', endDrag);
  win.addEventListener('pointercancel', endDrag);
  let lastCur = -1;
  function markCurrent() {
    const i = current();
    if (i === lastCur) return;
    lastCur = i;
    $$('button', loci).forEach((b, k) => b.setAttribute('aria-current', k === i ? 'true' : 'false'));
  }

  // ─── Rulers ───
  const rx = $('#rx');
  const ry = $('#ry');
  let mouse = null;
  function fit(c) {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }
  let RX = null;
  let RY = null;
  function drawRulers() {
    if (!isH() || !RX) return;
    const tr = track.getBoundingClientRect();
    const x0 = track.scrollLeft;
    { const { ctx, w, h } = RX;
      ctx.clearRect(0, 0, w, h);
      ctx.font = '500 8.5px "Martian Mono", monospace';
      ctx.fillStyle = '#706d65';
      ctx.strokeStyle = '#121211';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let v = Math.floor(x0 / 10) * 10; v <= x0 + w; v += 10) {
        const x = Math.round(v - x0) + 0.5;
        const len = v % 100 === 0 ? h : v % 50 === 0 ? h * 0.42 : h * 0.22;
        ctx.moveTo(x, h - len); ctx.lineTo(x, h);
        if (v % 100 === 0) ctx.fillText(String(v), x + 3, 9);
      }
      ctx.stroke();
      ctx.fillStyle = '#2244ff';
      sheets.forEach((s) => {
        const x = s.offsetLeft - x0;
        if (x < -60 || x > w) return;
        ctx.fillRect(Math.round(x), 0, 2, h);
        ctx.fillText('S' + s.dataset.n, x + 5, 19);
      });
      if (mouse && mouse.x >= tr.left && mouse.x <= tr.right) {
        const x = mouse.x - tr.left;
        const label = fmt(x0 + x);
        const tw = ctx.measureText(label).width + 8;
        ctx.fillStyle = '#2244ff';
        ctx.fillRect(Math.round(x), 0, 1, h);
        ctx.fillRect(x + 1, 0, tw, 12);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, x + 5, 9);
      }
    }
    { const { ctx, w, h } = RY;
      ctx.clearRect(0, 0, w, h);
      ctx.font = '500 8.5px "Martian Mono", monospace';
      ctx.fillStyle = '#706d65';
      ctx.strokeStyle = '#121211';
      ctx.beginPath();
      for (let v = 0; v <= h; v += 10) {
        const y = Math.round(v) + 0.5;
        const len = v % 100 === 0 ? w : v % 50 === 0 ? w * 0.42 : w * 0.22;
        ctx.moveTo(w - len, y); ctx.lineTo(w, y);
        if (v % 100 === 0 && v > 0) { ctx.save(); ctx.translate(9, y + 3); ctx.rotate(-Math.PI / 2); ctx.fillText(String(v), 0, 0); ctx.restore(); }
      }
      ctx.stroke();
      if (mouse && mouse.y >= tr.top && mouse.y <= tr.bottom) {
        const y = mouse.y - tr.top;
        ctx.fillStyle = '#2244ff';
        ctx.fillRect(0, Math.round(y), w, 1);
        const label = fmt(y);
        const tw = ctx.measureText(label).width + 8;
        ctx.fillRect(0, y + 1, 12, tw);
        ctx.save(); ctx.translate(9, y + tw - 3); ctx.rotate(-Math.PI / 2); ctx.fillStyle = '#ffffff'; ctx.fillText(label, 0, 0); ctx.restore();
      }
    }
  }

  // ─── Helix along the dock: rungs sit at fixed track positions, coloured by provenance kind ───
  const hc = $('#helix');
  let HX = null;
  let spin = 0;
  let lastScroll = 0;
  const KIND_COLOR = { m: '#2244ff', o: '#0b855a', i: '#b06a00', u: '#a29e94' };
  const KIND_TEXT = {
    m: ['#2f5bea', '48px', 'gap 24', 'r 12', '600px', '0.66%', '#1b1f2a', '32/38.4', '960px', '71 nodes', '1100px', '24px'],
    o: ['[open]', ':hover', ':focus', '73/73', 'click', 'aria-expanded'],
    i: ['SiteHeader', 'FeatureCard', 'primary', 'hero'],
    u: ['iframe', 'shadow root', 'inline svg'],
  };
  const kindOf = (n) => { const h = ((n * 2654435761) >>> 0) % 100; return h < 56 ? 'm' : h < 76 ? 'o' : h < 90 ? 'i' : 'u'; };
  function drawHelix(time) {
    if (!HX) return;
    const { ctx, w, h } = HX;
    const x0 = isH() ? track.scrollLeft : window.scrollY;
    const mid = h * 0.58;
    const R = h * 0.29;
    const P = 300;
    const ph = (X) => (X / P) * Math.PI * 2 + spin + (reduce ? 0 : time * 0.00028);
    ctx.clearRect(0, 0, w, h);
    const strand = (s, front) => {
      ctx.beginPath();
      let pen = false;
      for (let x = -4; x <= w + 4; x += 3) {
        const a = ph(x0 + x) + s * Math.PI;
        const y = mid + R * Math.sin(a);
        const isFront = Math.cos(a) >= 0;
        if (isFront === front) { if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y); }
        else pen = false;
      }
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(18,18,17,.22)';
    ctx.lineWidth = 1;
    strand(0, false); strand(1, false);
    const STEP = 20;
    ctx.font = '500 8.5px "Martian Mono", monospace';
    for (let X = Math.floor(x0 / STEP) * STEP; X <= x0 + w; X += STEP) {
      const n = X / STEP;
      const x = X - x0;
      const a = ph(X);
      const ya = mid + R * Math.sin(a);
      const yb = mid - R * Math.sin(a);
      const k = kindOf(n);
      ctx.strokeStyle = KIND_COLOR[k];
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(a));
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, ya); ctx.lineTo(x, yb); ctx.stroke();
      if (n % 9 === 0 && Math.abs(Math.sin(a)) > 0.45) {
        const list = KIND_TEXT[k];
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = KIND_COLOR[k];
        ctx.fillText(list[Math.abs(n) % list.length], x + 4, Math.min(ya, yb) - 5);
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#121211';
    ctx.lineWidth = 2;
    strand(0, true);
    ctx.strokeStyle = '#2244ff';
    strand(1, true);
  }
  let helixVisible = true;
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (document.hidden || !helixVisible || now - lastFrame < 33) return;
    lastFrame = now;
    const sl = isH() ? track.scrollLeft : 0;
    spin += (sl - lastScroll) * 0.0025;
    lastScroll = sl;
    if (isH()) drawHelix(now);
  }

  // ─── 01 Specimen: the wordmark measures itself ───
  // numbers count up the first time they are shown, then simply track the measurement
  const goal = {};
  function count(k, v, d, suffix = '') {
    const els = $$(`[data-m="${k}"]`);
    const show = (x) => els.forEach((el) => { el.textContent = fmt(x, d) + suffix; });
    const first = !(k in goal);
    goal[k] = v;
    if (!first) { if (!goal[k + ':run']) show(v); return; }
    if (reduce) { show(v); return; }
    goal[k + ':run'] = true;
    const t0 = performance.now();
    const tick = (now) => { const t = Math.min(1, (now - t0) / 1200); show(goal[k] * (1 - Math.pow(1 - t, 3))); if (t < 1) requestAnimationFrame(tick); else goal[k + ':run'] = false; };
    requestAnimationFrame(tick);
  }
  const metricCanvas = document.createElement('canvas').getContext('2d');
  function measureSpecimen() {
    const sheet = $('#specimen');
    const wm = $('#wm');
    if (!isH()) return;
    const sr = sheet.getBoundingClientRect();
    const s = unit(sheet);
    const glyphs = $$('.gl:not(.gap)', wm);
    const a = glyphs[0].getBoundingClientRect();
    const b = glyphs[glyphs.length - 1].getBoundingClientRect();
    const left = a.left - sr.left;
    const width = b.right - a.left;
    const base = $('#wm-bl').getBoundingClientRect().top - sr.top;
    const cs = getComputedStyle(wm);
    const fs = parseFloat(cs.fontSize);
    metricCanvas.font = `800 ${fs}px Archivo`;
    try { metricCanvas.fontStretch = 'extra-expanded'; } catch (e) { /* older canvases ignore stretch */ }
    const m = metricCanvas.measureText('H');
    const cap = m.actualBoundingBoxAscent || fs * 0.72;
    count('wm-w', width, 1);
    count('wm-y', base, 1);
    count('wm-ch', cap, 1, ' px · cap');
    count('wm-fs', fs, 1);
    Object.assign($('#wm-dim').style, { left: left + 'px', width: width + 'px', top: base - cap - 34 * s + 'px' });
    $('#wm-base').style.top = base + 'px';
    $('#wm-cap').style.top = base - cap + 'px';
    Object.assign($('#wm-caph').style, { left: b.right - sr.left + 18 * s + 'px', top: base - cap + 'px', height: cap + 'px' });
    const n = glyphs[3].getBoundingClientRect();
    Object.assign($('#gl-n-probe').style, { left: n.left - sr.left + n.width * 0.52 + 'px', top: base - cap * 0.5 + 'px' });
    sheet._base = base;
  }
  $$('#wm .gl:not(.gap)').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      if (!isH()) return;
      const sheet = $('#specimen');
      const sr = sheet.getBoundingClientRect();
      const r = g.getBoundingClientRect();
      const s = unit(sheet);
      const dim = $('#gl-dim');
      Object.assign(dim.style, { left: r.left - sr.left + 'px', width: r.width + 'px', top: (sheet._base || 0) + 14 * s + 'px' });
      $('span', dim).textContent = `${g.dataset.g} · ${fmt(r.width, 1)} px advance`;
      dim.classList.add('on');
    });
    g.addEventListener('mouseleave', () => $('#gl-dim').classList.remove('on'));
  });

  // ─── 02 Capture: exploded view ───
  const iso = $('#iso');
  const capture = $('#capture');
  $$('[data-vw]', capture).forEach((b) => {
    if (b.tagName !== 'BUTTON') return;
    b.addEventListener('click', () => {
      const vw = b.dataset.vw;
      $$('button[data-vw]', capture).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      iso.dataset.vw = vw;
      $$('.mini', iso).forEach((m) => { m.classList.toggle('ph', vw === '390'); m.classList.toggle('tb768', vw === '768'); });
      $('.vw-note', capture).textContent = `${vw} px · full page png`;
      relead(capture, 650);
    });
  });
  $('#explode').addEventListener('input', (e) => {
    iso.style.setProperty('--gap', `calc(${(Number(e.target.value) * 0.84).toFixed(1)} * var(--s))`);
    relead(capture, 520);
  });
  $$('.iso-labels .co', capture).forEach((co) => {
    const lyr = $(`.lyr[data-layer="${co.dataset.layer}"]`, iso);
    co.addEventListener('mouseenter', () => { lyr.classList.add('hot'); co.classList.add('hot'); relead(capture, 480); });
    co.addEventListener('mouseleave', () => { lyr.classList.remove('hot'); co.classList.remove('hot'); relead(capture, 480); });
  });

  // ─── 03 Explore: state diagram and detail view ───
  const STATES = [
    { bub: 'A', label: 'hover · a.button', sub: '"Start writing"', edge: 'pointerenter', trig: 'pointerenter on the primary button', before: '<span class="x-btn">Start writing</span>', after: '<span class="x-btn hov">Start writing</span>', diff: [['background', '#2f5bea', '#2448bf']] },
    { bub: 'B', label: 'focus-visible · a', sub: '"Features"', edge: 'Tab', trig: 'Tab from the start of the document', before: '<span class="x-link">Features</span>', after: '<span class="x-link foc">Features</span>', diff: [['outline', 'none', '2px solid #2f5bea'], ['outline-offset', '0', '2px']] },
    { bub: 'C', label: 'details[open]', sub: '"Is there a free plan?"', edge: 'click', trig: 'click on the summary', before: '<div class="x-acc"><b>Is there a free plan? <span>+</span></b></div>', after: '<div class="x-acc"><b>Is there a free plan? <span>−</span></b><p>Yes. The free plan includes unlimited notes on one device.</p></div>', diff: [['open', 'false', 'true'], ['panel', 'display none', 'block'], ['marker', '+', '−']] },
    { bub: 'D', label: 'menu · 390 px', sub: 'button.toggle', edge: 'click · 390', trig: 'click on the menu toggle at 390 px', before: '<div class="x-bar">Lumen <i></i></div>', after: '<div><div class="x-bar">Lumen <i></i></div><div class="x-menu"><span>Features</span><span>Pricing</span><span>FAQ</span><span>Get started</span></div></div>', diff: [['aria-expanded', 'false', 'true'], ['nav', 'display none', 'flex']] },
    { bub: 'E', skip: true, label: 'submit · form', sub: '"Join the beta"', edge: 'would POST', trig: 'pressing Join would submit the form', before: '<div class="x-form"><span>you@example.com</span><b>Join</b></div>', reason: 'Submitting sends a POST. UI DNA never writes to the server, so the action is recorded as a side effect and not performed.' },
    { bub: 'F', skip: true, label: 'a[href] · external', sub: '"Changelog ↗"', edge: 'leaves origin', trig: 'following the link would leave the origin', before: '<span class="x-link">Changelog ↗</span>', reason: 'The link leaves 127.0.0.1. Crawls and clicks stay on the origin being scanned.' },
  ];
  let stateSel = 2;
  const graph = $('#graph');
  function drawGraph() {
    const NX = 330;
    const NW = 214;
    const NH = 54;
    const ys = [26, 112, 198, 284, 438, 524];
    const spine = 236;
    let g = '<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8z" fill="#121211"/></marker><marker id="ahr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L8 4L0 8z" fill="#e2401f"/></marker></defs>';
    g += `<path class="g-edge" d="M176 284H${spine}"/><path class="g-edge" d="M${spine} ${ys[0] + NH / 2}V${ys[3] + NH / 2}"/><path class="g-edge skip" d="M${spine} 284V${ys[5] + NH / 2}"/>`;
    g += `<line x1="${spine - 30}" y1="384" x2="556" y2="384" stroke="#bfbaac" stroke-dasharray="2 4"/><text class="g-elab" x="${spine + 8}" y="378">recorded · reverted</text><text class="g-elab" x="${spine + 8}" y="400" fill="#e2401f" style="fill: #e2401f">skipped · with reasons</text>`;
    STATES.forEach((st, i) => {
      const y = ys[i];
      const cy = y + NH / 2;
      g += `<path class="g-edge${st.skip ? ' skip' : ''}" d="M${spine} ${cy}H${NX - 2}" marker-end="url(#${st.skip ? 'ahr' : 'ah'})"/>`;
      g += `<text class="g-elab" x="${spine + 8}" y="${cy - 6}"${st.skip ? ' style="fill: #e2401f"' : ''}>${st.edge}</text>`;
      if (st.skip) g += `<text x="${NX - 22}" y="${cy + 4}" style="fill: #e2401f; font-size: 12px; font-weight: 700">✕</text>`;
      g += `<g class="g-node${st.skip ? ' skip' : ''}${i === stateSel ? ' on' : ''}" data-i="${i}" tabindex="0" role="button" aria-pressed="${i === stateSel}" aria-label="${st.label}, ${st.skip ? 'skipped' : 'recorded'}"><rect x="${NX}" y="${y}" width="${NW}" height="${NH}"/><circle class="bub" cx="${NX + 22}" cy="${cy}" r="11"/><text class="bubt" x="${NX + 22}" y="${cy + 3.5}">${st.bub}</text><text x="${NX + 42}" y="${cy - 3}">${st.label}</text><text class="sub" x="${NX + 42}" y="${cy + 13}">${st.sub}</text></g>`;
      if (!st.skip) g += `<text class="g-tag" x="${NX + NW}" y="${y + NH + 11}" text-anchor="end">↺ reverted</text>`;
    });
    g += `<g class="g-node base"><rect x="16" y="254" width="160" height="60"/><text x="32" y="280">base state</text><text class="sub" x="32" y="298">1280 px · 71 nodes</text></g>`;
    g += `<text class="g-elab" x="16" y="244">snapshot before every action</text><text class="g-elab" x="16" y="334">restore after every action</text>`;
    graph.innerHTML = g;
    $$('.g-node[data-i]', graph).forEach((n) => {
      const pick = () => { stateSel = Number(n.dataset.i); drawGraph(); renderDetail(); $(`.g-node[data-i="${stateSel}"]`, graph).focus({ preventScroll: true }); };
      n.addEventListener('click', pick);
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(); } });
    });
  }
  function renderDetail() {
    const st = STATES[stateSel];
    const pair = st.skip
      ? `<div data-l="element">${st.before}</div><div class="blocked" data-l="not performed"><p style="margin: 0; font: 500 calc(10.5 * var(--s))/1.5 var(--mono); color: var(--red)">${st.reason}</p></div>`
      : `<div data-l="before">${st.before}</div><div class="after" data-l="after">${st.after}</div>`;
    const diff = st.diff ? `<ul class="d-diff">${st.diff.map(([p, a, b]) => `<li><span>${p}</span><b>${a} → <i>${b}</i></b></li>`).join('')}</ul>` : '';
    $('#detail').innerHTML = `<div class="d-head"><span class="d-bub">${st.bub}</span><p class="lab"><b>Detail ${st.bub}</b> · ${st.skip ? 'skipped' : 'transition'} · example record</p></div><p class="d-title">${st.label}</p><p class="d-trig">${st.trig}</p><div class="d-pair">${pair}</div>${diff}<p class="d-foot${st.skip ? ' red' : ''}">${st.skip ? '✕ not performed · reason recorded' : '↺ reverted · state restored'}</p>`;
  }
  drawGraph();
  renderDetail();

  // ─── 04 Measure: parts list with balloons ───
  const BOM = [
    { k: 'btnp', side: 'l', d: 'color/primary', v: '#2f5bea', sw: '#2f5bea', kind: 'm', src: 'computed-style', where: 'a.button' },
    { k: 'cta', side: 'r', d: 'color/primary-hover', v: '#2448bf', sw: '#2448bf', kind: 'o', src: ':hover transition', where: 'a.button:hover' },
    { k: 'h1', side: 'l', d: 'color/text', v: '#1b1f2a', sw: '#1b1f2a', kind: 'm', src: 'computed-style', where: 'body, h1, h2' },
    { k: 'lead', side: 'l', d: 'color/muted', v: '#5b6474', sw: '#5b6474', kind: 'm', src: 'computed-style', where: 'p.lead' },
    { k: 'eyebrow', side: 'l', d: 'type/eyebrow', v: '13 · 600 · caps', kind: 'm', src: 'computed-style', where: 'span.eyebrow' },
    { k: 'h2', side: 'l', d: 'type/heading', v: '32 / 38.4 · 700', kind: 'm', src: 'computed-style', where: 'h2' },
    { k: 'figure', side: 'r', d: 'asset/illustration', v: 'illustration.svg', kind: 'u', src: 'not authorized', where: 'img' },
    { k: 'grid', side: 'b', d: 'space/gap', v: '24 px', kind: 'm', src: 'layout', where: '.grid' },
    { k: 'card2', side: 'b', d: 'radius/card', v: '12 px', kind: 'm', src: 'computed-style', where: 'article.card' },
    { k: 'card3', side: 'b', d: 'component/card', v: '3 instances', kind: 'm', src: 'fingerprint', where: 'article.card' },
    { k: 'menu', side: 't', d: 'breakpoint', v: '768 · 1024 px', kind: 'm', src: 'stylesheet', where: '@media' },
  ];
  const KIND = { m: ['k-m', 'measured'], o: ['k-o', 'observed'], i: ['k-i', 'inferred'], u: ['k-u', 'unknown'] };
  const measure = $('#measure');
  $('#bom tbody').innerHTML = BOM.map((r, i) => `<tr data-i="${i}"><td><span>${i + 1}</span></td><td>${r.d}<span class="where">${r.where}</span></td><td><span class="val">${r.sw ? `<i style="background: ${r.sw}"></i>` : ''}${r.v}</span></td><td><span class="k ${KIND[r.kind][0]}">${KIND[r.kind][1]}</span><span class="src">${r.src}</span></td></tr>`).join('');
  const balloons = $('#balloons');
  balloons.innerHTML = BOM.map((r, i) => `<button type="button" class="bal" data-i="${i}" data-lead='#mea-frame [data-k="${r.k}"]' data-at=".5,.5" aria-label="Item ${i + 1}, ${r.d}">${i + 1}</button>`).join('');
  function placeBalloons() {
    if (!isH()) return;
    const fig = $('.mea-fig', measure);
    const fr = fig.getBoundingClientRect();
    const frame = $('#mea-frame').getBoundingClientRect();
    const s = unit(measure);
    const sides = { l: [], r: [], b: [], t: [] };
    BOM.forEach((r, i) => {
      const t = $(`#mea-frame [data-k="${r.k}"]`).getBoundingClientRect();
      sides[r.side].push({ i, x: t.left + t.width / 2 - fr.left, y: t.top + t.height / 2 - fr.top });
    });
    const spread = (list, key, min, lo, hi) => {
      list.sort((p, q) => p[key] - q[key]);
      let prev = lo - min;
      list.forEach((p) => { p[key] = Math.max(p[key], prev + min); prev = p[key]; });
      const over = prev - hi;
      if (over > 0) list.forEach((p) => { p[key] -= over; });
    };
    const gap = 30 * s;
    spread(sides.l, 'y', gap, frame.top - fr.top + 12 * s, frame.bottom - fr.top - 12 * s);
    spread(sides.r, 'y', gap, frame.top - fr.top + 12 * s, frame.bottom - fr.top - 12 * s);
    spread(sides.b, 'x', gap, frame.left - fr.left + 12 * s, frame.right - fr.left - 12 * s);
    spread(sides.t, 'x', gap, frame.left - fr.left + 12 * s, frame.right - fr.left - 12 * s);
    const put = (p, x, y) => { const b = $(`.bal[data-i="${p.i}"]`, balloons); b.style.left = x + 'px'; b.style.top = y + 'px'; };
    sides.l.forEach((p) => put(p, frame.left - fr.left - 28 * s, p.y));
    sides.r.forEach((p) => put(p, frame.right - fr.left + 28 * s, p.y));
    sides.b.forEach((p) => put(p, p.x, frame.bottom - fr.top + 30 * s));
    sides.t.forEach((p) => put(p, p.x, frame.top - fr.top - 26 * s));
  }
  function hotItem(i, on) {
    const r = BOM[i];
    $(`#bom tr[data-i="${i}"]`).classList.toggle('hot', on);
    $(`.bal[data-i="${i}"]`, balloons).classList.toggle('hot', on);
    const t = $(`#mea-frame [data-k="${r.k}"]`);
    if (t) t.classList.toggle('hot', on);
    lead(measure);
  }
  $$('#bom tbody tr').forEach((tr) => { tr.addEventListener('mouseenter', () => hotItem(Number(tr.dataset.i), true)); tr.addEventListener('mouseleave', () => hotItem(Number(tr.dataset.i), false)); });
  $$('.bal', balloons).forEach((b) => {
    const i = Number(b.dataset.i);
    b.addEventListener('mouseenter', () => hotItem(i, true));
    b.addEventListener('mouseleave', () => hotItem(i, false));
    b.addEventListener('focus', () => hotItem(i, true));
    b.addEventListener('blur', () => hotItem(i, false));
  });

  // ─── 05 Breakpoints: Fixture B, resized by hand ───
  const ORDERS = [
    { id: 'ORD-1001', c: 'Merrow', st: 'Pending', t: 64.9, n: 2, d: 'Oct 02' },
    { id: 'ORD-1002', c: 'Ostrander', st: 'Shipped', t: 186.25, n: 5, d: 'Oct 03' },
    { id: 'ORD-1004', c: 'Halden Co', st: 'Shipped', t: 412, n: 9, d: 'Oct 05' },
    { id: 'ORD-1007', c: 'Brightwell', st: 'Pending', t: 298.4, n: 4, d: 'Oct 08' },
    { id: 'ORD-1009', c: 'Halden Co', st: 'Refunded', t: 120, n: 1, d: 'Oct 09' },
    { id: 'ORD-1011', c: 'Pell & Saye', st: 'Shipped', t: 57.5, n: 1, d: 'Oct 11' },
  ];
  const BPS = [600, 960, 1100];
  const fbState = { W: 1180, q: '', f: 'all', sort: 'none', last: 'base' };
  const fb = $('#fb');
  const bpFrame = $('#bp-frame');
  const bpRange = $('#bp-range');
  $('#bp-ruler').innerHTML = [200, 400, 800, 1000, 1200, 1400].map((v) => `<span style="left: calc(${v} * var(--k))">${v}</span>`).join('')
    + [390, 768, 1280].map((v) => `<span class="scan" style="left: calc(${v} * var(--k))"><em>${v} scanned</em></span>`).join('')
    + BPS.map((v) => `<span class="bpm" data-bp="${v}" style="left: calc(${v} * var(--k))"><em>${v}</em></span>`).join('');
  function renderFB() {
    const { W } = fbState;
    bpFrame.style.setProperty('--W', W);
    if (!isH()) fb.style.setProperty('--vfit', bpFrame.clientWidth / W + 'px');
    $('#bp-w').parentElement.style.setProperty('--W', W);
    fb.classList.toggle('lt1100', W < 1100);
    fb.classList.toggle('lt960', W < 960);
    fb.classList.toggle('lt600', W < 600);
    $$('.bpm', $('#bp-ruler')).forEach((m) => m.classList.toggle('hit', Math.abs(W - Number(m.dataset.bp)) <= 30));
    const layout = W >= 1100 ? 'sidebar, 6 columns' : W >= 960 ? 'icon rail, 5 columns' : W >= 600 ? 'no rail, 4 columns' : 'cards';
    $('#bp-w').textContent = `${W} px · ${layout}`;
    const q = fbState.q.trim().toLowerCase();
    let rows = ORDERS.filter((o) => (fbState.f === 'all' || o.st === fbState.f) && (!q || `${o.id} ${o.c}`.toLowerCase().includes(q)));
    if (fbState.sort !== 'none') rows = rows.slice().sort((a, b) => (fbState.sort === 'desc' ? b.t - a.t : a.t - b.t));
    $('#fb-count').textContent = `${rows.length} of ${ORDERS.length} orders`;
    const money = (t) => '$' + t.toFixed(2);
    const table = $('#fb-table');
    if (W < 600) {
      table.className = 'fb-cards';
      table.innerHTML = rows.length ? rows.map((o) => `<div class="fb-card" role="row"><span role="cell">${o.c}</span><b role="cell">${money(o.t)}</b><span class="id" role="cell">${o.id}</span><span role="cell" style="text-align: right"><span class="fb-st ${o.st}">${o.st}</span></span></div>`).join('') : '<p class="fb-empty">No orders match.</p>';
    } else {
      const cols = W >= 1100 ? ['Order', 'Customer', 'Status', 'Items', 'Placed', 'Total'] : W >= 960 ? ['Order', 'Customer', 'Status', 'Items', 'Total'] : ['Order', 'Customer', 'Status', 'Total'];
      const tmpl = { Order: '1fr', Customer: '1.3fr', Status: '1fr', Items: '.6fr', Placed: '.8fr', Total: '.9fr' };
      table.className = 'fb-table';
      table.style.setProperty('--cols', cols.map((c) => tmpl[c]).join(' '));
      const cell = (o, c) => ({ Order: `<span class="id">${o.id}</span>`, Customer: o.c, Status: `<span class="fb-st ${o.st}">${o.st}</span>`, Items: o.n, Placed: o.d, Total: money(o.t) })[c];
      table.innerHTML = `<div class="fb-tr th" role="row">${cols.map((c) => `<span role="columnheader"${c === 'Total' || c === 'Items' ? ' class="num"' : ''}>${c}</span>`).join('')}</div>`
        + (rows.length ? rows.map((o) => `<div class="fb-tr" role="row">${cols.map((c) => `<span role="cell"${c === 'Total' || c === 'Items' ? ' class="num"' : ''}>${cell(o, c)}</span>`).join('')}</div>`).join('') : '<p class="fb-empty">No orders match. The empty state is recorded too.</p>');
    }
    let rule = 'base · 6 items · identity by order id';
    if (fbState.last === 'search' && q) rule = `search · "${fbState.q.trim()}" · ${rows.length} kept · matches id and customer`;
    else if (fbState.last === 'filter' && fbState.f !== 'all') rule = `filter · status = ${fbState.f} · ${rows.length} kept`;
    else if (fbState.last === 'sort' && fbState.sort !== 'none') rule = `sort · total · ${fbState.sort === 'desc' ? 'descending' : 'ascending'} · numeric`;
    else if (fbState.last === 'reset') rule = 'reset · back to the 6 base items';
    $('#bp-rule').textContent = rule;
    $('#fb-sort').textContent = `Total ${fbState.sort === 'desc' ? '↓' : fbState.sort === 'asc' ? '↑' : '↕'}`;
    $('#fb-sort').setAttribute('aria-pressed', fbState.sort === 'none' ? 'false' : 'true');
    $$('.fb-chips button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.f === fbState.f ? 'true' : 'false'));
    $('#fb-sel').value = fbState.f;
  }
  const setW = (w) => { fbState.W = Math.round(clamp(w, 320, 1440)); bpRange.value = fbState.W; renderFB(); };
  bpRange.addEventListener('input', () => setW(Number(bpRange.value)));
  const kpx = () => $('#bp-ruler').getBoundingClientRect().width / 1440;
  let bpDrag = false;
  const handle = $('.bp-handle');
  handle.addEventListener('pointerdown', (e) => { bpDrag = true; handle.setPointerCapture(e.pointerId); e.preventDefault(); });
  handle.addEventListener('pointermove', (e) => { if (bpDrag) setW((e.clientX - bpFrame.getBoundingClientRect().left) / kpx()); });
  handle.addEventListener('pointerup', () => { bpDrag = false; });
  handle.addEventListener('pointercancel', () => { bpDrag = false; });
  $('#fb-q').addEventListener('input', (e) => { fbState.q = e.target.value; fbState.last = e.target.value.trim() ? 'search' : 'reset'; renderFB(); });
  $$('.fb-chips button').forEach((b) => b.addEventListener('click', () => { fbState.f = b.dataset.f; fbState.last = b.dataset.f === 'all' ? 'reset' : 'filter'; renderFB(); }));
  $('#fb-sel').addEventListener('change', (e) => { fbState.f = e.target.value; fbState.last = e.target.value === 'all' ? 'reset' : 'filter'; renderFB(); });
  $('#fb-sort').addEventListener('click', () => { const was = fbState.sort; fbState.sort = was === 'none' ? 'desc' : was === 'desc' ? 'asc' : 'none'; fbState.last = was === 'asc' ? 'reset' : 'sort'; renderFB(); });
  if (!isH()) { fbState.W = 390; bpRange.value = 390; }
  renderFB();

  // ─── 06 Generate: split and revision clouds ───
  const gen = $('#generate');
  const genFrame = $('#gen-frame');
  $('#split').addEventListener('input', (e) => genFrame.style.setProperty('--split', e.target.value + '%'));
  function cloud(x, y, w, h, r) {
    const pts = [];
    const along = (x1, y1, x2, y2) => { const len = Math.hypot(x2 - x1, y2 - y1); const n = Math.max(2, Math.round(len / (r * 1.6))); for (let i = 0; i < n; i += 1) pts.push([x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]); };
    along(x, y, x + w, y); along(x + w, y, x + w, y + h); along(x + w, y + h, x, y + h); along(x, y + h, x, y);
    pts.push(pts[0]);
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i += 1) { const [px, py] = pts[i - 1]; const [qx, qy] = pts[i]; const c = Math.hypot(qx - px, qy - py) * 0.62; d += `A${c.toFixed(1)} ${c.toFixed(1)} 0 0 1 ${qx.toFixed(1)} ${qy.toFixed(1)}`; }
    return d;
  }
  function drawClouds() {
    const svg = $('#clouds');
    const fr = genFrame.getBoundingClientRect();
    if (!fr.width) return;
    const s = fr.width / 560;
    const R = [['header', 1], ['grid', 2], ['figure', 3]];
    svg.innerHTML = R.map(([k, n]) => {
      const t = $(`.lay.a [data-k="${k}"]`, genFrame).getBoundingClientRect();
      const pad = 7 * s;
      const x = Math.max(4, t.left - fr.left - pad);
      const y = Math.max(4, t.top - fr.top - pad);
      const w = Math.min(fr.width - 8, t.width + pad * 2);
      const h = Math.min(fr.height - y - 4, t.height + pad * 2);
      const tx = x + 14 * s;
      const ty = y + 2;
      return `<g data-rev="${n}"><path d="${cloud(x, y, w, h, 7 * s)}"/><path class="tri" d="M${tx} ${ty - 11 * s}L${tx + 10 * s} ${ty + 7 * s}H${tx - 10 * s}Z"/><text x="${tx}" y="${ty + 4 * s}" style="font-size: ${9 * s}px">${n}</text></g>`;
    }).join('');
  }
  $$('.revs tbody tr').forEach((tr) => {
    const on = (v) => { tr.classList.toggle('hot', v); const g = $(`#clouds g[data-rev="${tr.dataset.rev}"]`); if (g) g.classList.toggle('hot', v); };
    tr.addEventListener('mouseenter', () => on(true));
    tr.addEventListener('mouseleave', () => on(false));
  });

  // ─── 07 Verify: five attempts ───
  const ATT = [
    { n: '01', label: 'baseline', base: 21, reg: 0, res: 0, trans: '73/73', change: 'baseline' },
    { n: '02', label: 'color changed', base: 21, reg: 14, res: 0, trans: '73/73', change: 'primary color changed' },
    { n: '03', label: 'reverted', base: 21, reg: 0, res: 14, trans: '73/73', change: 'color reverted' },
    { n: '04', label: 'clicks swallowed', base: 21, reg: 24, res: 0, trans: '62/73', change: 'a script swallows clicks' },
    { n: '05', label: 'reverted', base: 21, reg: 0, res: 24, trans: '73/73', change: 'script removed' },
  ];
  let attSel = 3;
  function drawPlot() {
    const L = 54; const Rr = 704; const T = 26; const B = 392;
    const X = (i) => L + ((i + 0.5) * (Rr - L)) / 5;
    const Y = (v) => B - (v / 50) * (B - T);
    let g = '';
    for (let v = 0; v <= 50; v += 5) g += `<line class="p-grid" x1="${L}" x2="${Rr}" y1="${Y(v)}" y2="${Y(v)}"${v % 10 ? ' style="opacity: .5"' : ''}/>`;
    for (let i = 0; i <= 50; i += 1) { const x = L + (i * (Rr - L)) / 50; g += `<line class="p-grid" x1="${x}" x2="${x}" y1="${T}" y2="${B}" style="opacity: ${i % 10 ? 0.45 : 1}"/>`; }
    for (let v = 0; v <= 50; v += 10) g += `<text class="p-tick" x="${L - 10}" y="${Y(v) + 3.5}" text-anchor="end">${v}</text>`;
    g += `<text class="p-lab" x="${L - 40}" y="${T - 10}">findings</text>`;
    g += `<path class="p-axis" d="M${L} ${T}V${B}H${Rr}"/>`;
    g += `<line class="p-base" x1="${L}" x2="${Rr}" y1="${Y(21)}" y2="${Y(21)}"/><text class="p-note" x="${L + 12}" y="${Y(21) + 18}" style="fill: #b06a00">21 · one unauthorized image · by design</text>`;
    const pts = ATT.map((a, i) => [X(i), Y(a.base + a.reg)]);
    g += `<path class="p-fill" d="M${X(0)} ${Y(21)}${pts.map(([x, y]) => `L${x} ${y}`).join('')}L${X(4)} ${Y(21)}Z"/>`;
    g += `<path class="p-trace" d="M${L} ${Y(21)}L${pts.map(([x, y]) => `${x} ${y}`).join('L')}L${Rr} ${Y(21)}"/>`;
    const notes = [null, ['+14 · color changed', 'red', -16], ['−14 resolved', 'green', 22], ['+24 · clicks swallowed', 'red', -16], ['−24 resolved', 'green', 22]];
    ATT.forEach((a, i) => {
      const [x, y] = pts[i];
      if (notes[i]) g += `<text class="p-note ${notes[i][1]}" x="${x}" y="${y + notes[i][2]}" text-anchor="middle">${notes[i][0]}</text>`;
      g += `<g class="p-pt${a.reg ? ' reg' : ''}${i === attSel ? ' on' : ''}" data-i="${i}" tabindex="0" role="button" aria-pressed="${i === attSel}" aria-label="Attempt ${a.n}: ${a.base + a.reg} findings, ${a.reg} regressions"><circle cx="${x}" cy="${y}" r="${i === attSel ? 9 : 7}"/></g>`;
      g += `<text class="p-tick" x="${x}" y="${B + 18}" text-anchor="middle" style="fill: #121211; font-weight: 600">${a.n}</text><text class="p-tick" x="${x}" y="${B + 32}" text-anchor="middle">${a.label}</text>`;
    });
    g += `<text class="p-lab" x="${Rr}" y="${B + 50}" text-anchor="end">verify attempt →</text>`;
    $('#plot').innerHTML = g;
    $$('.p-pt', $('#plot')).forEach((p) => {
      const pick = () => { attSel = Number(p.dataset.i); drawPlot(); $(`.p-pt[data-i="${attSel}"]`).focus({ preventScroll: true }); };
      p.addEventListener('click', pick);
      p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(); } });
    });
    const a = ATT[attSel];
    $('#readout').innerHTML = `<span>attempt <b>${a.n}</b></span><span>${a.change}</span><span>findings <b>${a.base + a.reg}</b></span><span>regressions <b class="${a.reg ? 'red' : ''}">${a.reg}</b></span><span>resolved <b class="${a.res ? 'green' : ''}">${a.res}</b></span><span>transitions <b>${a.trans}</b></span>`;
  }
  drawPlot();

  // ─── 08 Tools: pinout and datasheet ───
  const TOOLS = [
    ['Look', 'scan_interface', 'uidna scan <url>', 'What is on each page at each viewport, and where the layout changes.'],
    ['Look', 'explore_interactions', 'uidna explore <scan>', 'What changes when you interact, with every skip explained.'],
    ['Read', 'inspect_dna', 'uidna inspect <scan>', 'A summary, one facet, one path, or the whole document.'],
    ['Read', 'inspect_element', 'uidna element <scan> <state>', 'One node: box, style, tokens, accessibility and evidence.'],
    ['Read', 'search_components', 'uidna components <scan>', 'Fingerprinted component candidates, matched across pages.'],
    ['Read', 'extract_tokens', 'uidna tokens <scan>', 'Token clusters with member values and sample counts.'],
    ['Build', 'annotate_dna', 'uidna annotate <scan> <patches>', 'Your agent’s readings, stored as inferred.'],
    ['Build', 'generate_project', 'uidna generate <scan> <outDir>', 'The React project, installed and built.'],
    ['Prove', 'verify_reconstruction', 'uidna verify <scan> <outDir>', 'The DiffReport, with regressions and resolved findings.'],
    ['Prove', 'report_reconstruction', 'uidna report <scan>', 'A static HTML report of the evidence.'],
    ['Prove', 'export_evidence', 'uidna export <scan>', 'A portable evidence bundle with digests.'],
    ['Loop', 'reconstruct_interface', 'uidna reconstruct <url> <outDir>', 'The whole loop, from URL to verified project.'],
  ];
  const GCOL = { Look: '#2244ff', Read: '#0b855a', Build: '#b06a00', Prove: '#e2401f', Loop: '#121211' };
  let pinSel = 8;
  function drawChip() {
    const BX = 246; const BW = 168; const BY = 100; const BH = 448;
    const py = (k) => BY + 44 + k * 72;
    let g = `<rect class="c-body" x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="4"/><path d="M${BX + BW / 2 - 18} ${BY}a18 18 0 0 0 36 0" fill="#f1efe8"/><circle cx="${BX + 18}" cy="${BY + 22}" r="5" fill="#3a3935"/>`;
    g += `<text class="c-title" x="${BX + BW / 2}" y="${BY + BH / 2 - 6}">UI DNA</text><text class="c-sub" x="${BX + BW / 2}" y="${BY + BH / 2 + 14}">0.3.0 · 12 pins</text><text class="c-sub" x="${BX + BW / 2}" y="${BY + BH / 2 + 30}">MCP stdio · CLI</text>`;
    g += `<text class="p-lab" x="${BX + BW / 2}" y="${BY - 24}" text-anchor="middle">VDD · your coding agent over MCP</text><line x1="${BX + BW / 2}" x2="${BX + BW / 2}" y1="${BY - 18}" y2="${BY}" stroke="#121211"/>`;
    g += `<text class="p-lab" x="${BX + BW / 2}" y="${BY + BH + 36}" text-anchor="middle">GND · your machine, no network writes</text><line x1="${BX + BW / 2}" x2="${BX + BW / 2}" y1="${BY + BH}" y2="${BY + BH + 22}" stroke="#121211"/>`;
    TOOLS.forEach(([grp, name], i) => {
      const left = i < 6;
      const k = left ? i : 11 - i;
      const y = py(k);
      const pin = i + 1;
      const on = i === pinSel ? ' on' : '';
      const px = left ? BX - 26 : BX + BW;
      const lx1 = left ? BX - 86 : BX + BW + 26;
      const lx2 = left ? BX - 26 : BX + BW + 86;
      const tx = left ? BX - 92 : BX + BW + 92;
      const anchor = left ? 'end' : 'start';
      g += `<g class="c-pin${on}" data-i="${i}" tabindex="0" role="button" aria-pressed="${i === pinSel}" aria-label="Pin ${pin}, ${name}, ${grp}">`
        + `<rect class="hl" x="${left ? 0 : BX + BW + 86}" y="${y - 22}" width="${left ? BX - 86 : 660 - (BX + BW + 86)}" height="34"/>`
        + `<line x1="${lx1}" x2="${lx2}" y1="${y}" y2="${y}"/><rect class="p" x="${px}" y="${y - 7}" width="26" height="14"/>`
        + `<text class="n" x="${left ? BX + 10 : BX + BW - 10}" y="${y + 3.5}" text-anchor="${left ? 'start' : 'end'}">${pin}</text>`
        + `<text class="grp" x="${tx}" y="${y - 9}" text-anchor="${anchor}" style="fill: ${GCOL[grp]}">${grp.toUpperCase()}</text>`
        + `<text class="nm" x="${tx}" y="${y + 6}" text-anchor="${anchor}">${name}</text></g>`;
    });
    $('#chip').setAttribute('viewBox', '0 0 660 640');
    $('#chip').innerHTML = g;
    $$('.c-pin', $('#chip')).forEach((p) => {
      const pick = () => { pinSel = Number(p.dataset.i); drawChip(); renderPin(); $(`.c-pin[data-i="${pinSel}"]`).focus({ preventScroll: true }); };
      p.addEventListener('click', pick);
      p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(); } });
    });
  }
  function renderPin() {
    const [grp, name, cli, what] = TOOLS[pinSel];
    $('#pin-data').innerHTML = `<p class="lab"><b>Datasheet</b> · pin ${pinSel + 1} of 12</p><div class="sd-pin"><b>${String(pinSel + 1).padStart(2, '0')}</b><span class="k" style="background: ${GCOL[grp]}; color: ${grp === 'Loop' ? '#ffe24a' : '#fff'}">${grp}</span></div><p class="sd-name">${name}</p><p class="sd-what">${what}</p><dl class="sd-rows"><div><dt>CLI</dt><dd>${cli.replace(/</g, '&lt;')}</dd></div><div><dt>MCP</dt><dd>${name}</dd></div><div><dt>Returns · evidence envelope</dt><dd class="sd-env"><span>result</span><span>evidence_id</span><span>evidence</span><span>limitations</span><span>unknowns</span></dd></div></dl>`;
  }
  drawChip();
  renderPin();
  const TERM = {
    prompt: { copy: 'Reconstruct http://127.0.0.1:51767 at 1280, 768 and 390 px with UI DNA. Repair until no regressions remain.', html: '<span class="c"># to Claude Code, Codex or Cursor</span>\n<span class="u">Reconstruct http://127.0.0.1:51767 at\n1280, 768 and 390 px with UI DNA. Repair\nuntil no regressions remain.</span>\n\n<span class="t">●</span> scan_interface       <span class="c">3 states</span>\n<span class="t">●</span> explore_interactions <span class="c">73 transitions</span>\n<span class="t">●</span> extract_tokens       <span class="c">10 colors</span>\n<span class="t">●</span> generate_project     <span class="c">built</span>\n<span class="t">●</span> verify_reconstruction\n  <span class="c">73/73 · 0.66%</span>\n<span class="ok">✓ No regressions.</span>' },
    mcp: { copy: '{"mcpServers":{"uidna":{"type":"stdio","command":"npx","args":["-y","@rohzzn/uidna@latest","serve"]}}}', html: '{\n  <span class="k">"mcpServers"</span>: {\n    <span class="k">"uidna"</span>: {\n      <span class="k">"type"</span>: <span class="s">"stdio"</span>,\n      <span class="k">"command"</span>: <span class="s">"npx"</span>,\n      <span class="k">"args"</span>: [<span class="s">"-y"</span>,\n        <span class="s">"@rohzzn/uidna@latest"</span>,\n        <span class="s">"serve"</span>]\n    }\n  }\n}' },
    cli: { copy: 'uidna reconstruct https://example.com ./clone --viewports 1280,768,390', html: '<span class="c"># the whole loop on one page</span>\nuidna reconstruct https://example.com \\\n  ./clone --viewports 1280,768,390\n\n<span class="c"># a small site you own</span>\nuidna reconstruct http://localhost:3000 \\\n  ./site --crawl \'{"maxPages":5}\' \\\n  --capture-bodies json --policy forms' },
  };
  let termTab = 'prompt';
  function renderTerm() {
    $('#term-body').innerHTML = TERM[termTab].html;
    $$('.term-bar [role="tab"]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === termTab ? 'true' : 'false'));
  }
  $$('.term-bar [role="tab"]').forEach((b) => b.addEventListener('click', () => { termTab = b.dataset.tab; renderTerm(); }));
  renderTerm();

  // ─── Copy ───
  function copy(btn, text) {
    try { if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => undefined); } catch (e) { /* copying is a convenience */ }
    btn.classList.add('done');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => btn.classList.remove('done'), 1600);
  }
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b, b.dataset.copy)));
  $('#term-copy').addEventListener('click', (e) => copy(e.currentTarget, TERM[termTab].copy));

  // ─── X-ray: the page inspects itself ───
  let xr = false;
  const xrBtn = $('#xr-btn');
  const box = $('#xr-box');
  const card = $('#xr-card');
  const hex = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (a === 0) return null;
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') + (a < 1 ? ` · ${Math.round(a * 100)}%` : '');
  };
  function xray(on = !xr) {
    xr = on;
    document.body.classList.toggle('xray', on);
    xrBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  xrBtn.addEventListener('click', () => xray());
  function inspect(x, y) {
    $('#xh-x').style.top = y + 'px';
    $('#xh-y').style.left = x + 'px';
    const el = document.elementFromPoint(x, y);
    const sheet = el && el.closest('.sheet');
    if (!sheet || el === sheet) { box.style.opacity = 0; card.style.opacity = 0; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { opacity: 1, left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const cs = getComputedStyle(el);
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0];
    const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '');
    const col = hex(cs.color);
    const bg = hex(cs.backgroundColor);
    card.innerHTML = `<div><b>${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}</b></div>`
      + `<div class="r"><span>box</span><span>${fmt(r.width, 1)} × ${fmt(r.height, 1)}</span></div>`
      + `<div class="r"><span>at</span><span>x ${fmt(r.left - track.getBoundingClientRect().left + track.scrollLeft)} · y ${fmt(r.top - track.getBoundingClientRect().top)}</span></div>`
      + `<div class="r"><span>type</span><span>${fam} ${cs.fontWeight} · ${fmt(parseFloat(cs.fontSize), 1)}/${cs.lineHeight === 'normal' ? 'normal' : fmt(parseFloat(cs.lineHeight), 1)}</span></div>`
      + (col ? `<div class="r"><span>color</span><span><i style="background: ${cs.color}"></i>${col}</span></div>` : '')
      + (bg ? `<div class="r"><span>fill</span><span><i style="background: ${cs.backgroundColor}"></i>${bg}</span></div>` : '')
      + '<div class="prov">measured · computed-style · just now</div>';
    const cw = card.offsetWidth || 240;
    const ch = card.offsetHeight || 150;
    const cx = x + 18 + cw > innerWidth ? x - 18 - cw : x + 18;
    const cy = y + 18 + ch > innerHeight ? y - 18 - ch : y + 18;
    Object.assign(card.style, { opacity: 1, left: cx + 'px', top: cy + 'px' });
  }

  // ─── Frame bookkeeping ───
  let frameQueued = false;
  function frame() {
    frameQueued = false;
    drawRulers();
    placeWin();
    markCurrent();
  }
  const queue = () => { if (!frameQueued) { frameQueued = true; requestAnimationFrame(frame); } };
  track.addEventListener('scroll', () => { if (!anim && !dragFrom) target = null; queue(); }, { passive: true });
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('pointermove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (xr) inspect(e.clientX, e.clientY);
    queue();
  }, { passive: true });
  document.addEventListener('pointerleave', () => { mouse = null; queue(); });

  function layout() {
    if (isH()) {
      RX = fit(rx);
      RY = fit(ry);
    }
    HX = isH() ? fit(hc) : null;
    sheets.forEach((s) => { const v = $('[data-scale]', s); if (v) v.textContent = '×' + unit(s).toFixed(2); });
    measureSpecimen();
    placeBalloons();
    drawClouds();
    renderFB();
    leadAll();
    queue();
    if (isH()) drawHelix(performance.now());
  }
  // a sheet draws itself the first time it comes into view
  if (window.IntersectionObserver && !reduce) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.3 });
    sheets.forEach((s) => io.observe(s));
  } else sheets.forEach((s) => s.classList.add('in'));
  if (window.ResizeObserver) new ResizeObserver(() => layout()).observe(track);
  else window.addEventListener('resize', layout);
  HQ.addEventListener('change', layout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
  layout();
  requestAnimationFrame(loop);

  // deep links: #explore, or ?sheet=explore for screenshots
  const want = new URLSearchParams(location.search).get('sheet') || location.hash.slice(1);
  const at = sheets.findIndex((s) => s.id === want);
  if (at > 0) requestAnimationFrame(() => { if (isH()) track.scrollLeft = sheets[at].offsetLeft; else sheets[at].scrollIntoView(); queue(); });
  if (new URLSearchParams(location.search).get('xray') === '1') xray(true);
})();
