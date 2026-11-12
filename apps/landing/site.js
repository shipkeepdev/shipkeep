// Interactions of the landing page. No dependency, no network, nothing stored.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const NS = 'http://www.w3.org/2000/svg';

  // Mobile menu.
  const menu = document.getElementById('sk-menu');
  const setMenu = (open) => {
    menu.style.display = open ? 'flex' : 'none';
    document.body.style.overflow = open ? 'hidden' : '';
  };
  document.querySelector('[data-m="burger"]')?.addEventListener('click', () => setMenu(true));
  menu?.querySelector('button')?.addEventListener('click', () => setMenu(false));
  menu?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setMenu(false));
  });

  // Questions: the first starts open. Without JavaScript every answer stays visible.
  const items = [...document.querySelectorAll('#faq [data-stagger] > div')];
  const showAnswer = (active) => {
    items.forEach((item, index) => {
      const open = index === active;
      const [, row, answer] = item.children;
      const [question, icon] = row.children;
      answer.style.display = open ? '' : 'none';
      question.style.color = open ? '#FFFFFF' : '#D6D6DA';
      icon.className = open ? 'ti ti-minus' : 'ti ti-plus';
      icon.style.color = open ? '#C4C4C8' : '#5A5A5E';
      row.setAttribute('aria-expanded', String(open));
    });
  };
  let answerOpen = 0;
  items.forEach((item, index) => {
    const row = item.children[1];
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const toggle = () => {
      answerOpen = answerOpen === index ? -1 : index;
      showAnswer(answerOpen);
    };
    item.addEventListener('click', toggle);
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
  });
  if (items.length) showAnswer(0);

  // Promises carousel.
  const quote = document.getElementById('sk-quote');
  if (quote) {
    const quotes = JSON.parse(quote.dataset.quotes);
    const source = document.getElementById('sk-quote-source');
    let index = 0;
    const show = (step) => {
      index = (index + step + quotes.length) % quotes.length;
      quote.textContent = quotes[index][0];
      source.textContent = quotes[index][1];
    };
    document.querySelectorAll('[data-quote-step]').forEach((control) => {
      const step = Number(control.dataset.quoteStep);
      control.setAttribute('role', 'button');
      control.tabIndex = 0;
      control.addEventListener('click', () => {
        show(step);
      });
      control.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        show(step);
      });
    });
  }

  // Anatomy of a server: an isometric stack whose layers open one by one.
  const stage = document.getElementById('sk-anatomy');
  if (!stage) return;
  const rows = [...document.querySelectorAll('#anatomie [data-stagger] > div')];
  const readout = document.getElementById('sk-anatomy-readout');
  const idle = readout?.textContent ?? '';
  const iso = (x, y, z) => [(x - y) * 0.866, (x + y) * 0.5 - z];
  const pth = (points) =>
    'M' + points.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + 'Z';
  const ln = (a, b) =>
    'M' + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + 'L' + b[0].toFixed(1) + ' ' + b[1].toFixed(1);
  const TONES = {
    base: ['#1E1A1A', '#141111', '#0E0C0C', '#2C2C2F'],
    mid: ['#28282B', '#1C1818', '#151212', '#37373A'],
    hi: ['#363639', '#27272A', '#1D1D20', '#454548'],
    red: ['#88888C', '#5C5C60', '#3E3E42', '#C4C4C8'],
  };
  const element = (name, attributes) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const svg = element('svg', { preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  svg.style.cssText = 'width:100%;height:100%;display:block;overflow:visible';
  const defs = element('defs', {});
  const beam = element('linearGradient', { id: 'anB', x1: 0, y1: 1, x2: 0, y2: 0 });
  beam.append(
    element('stop', { offset: 0, 'stop-color': '#BEBEC2', 'stop-opacity': 1 }),
    element('stop', { offset: 1, 'stop-color': '#BEBEC2', 'stop-opacity': 0 }),
  );
  defs.append(beam);
  const group = element('g', {});
  svg.append(defs, group);
  stage.replaceChildren(svg);
  svg.setAttribute('aria-label', stage.dataset.label ?? '');

  const draw = (opening, active) => {
    const out = [];
    const box = (x, y, z, w, d, height, tone, lit) => {
      const t = TONES[tone];
      const stroke = lit ? '#C4C4C8' : t[3];
      const face = (points, fill) =>
        out.push(
          element('path', {
            d: pth(points),
            fill,
            stroke,
            'stroke-width': 0.6,
            'stroke-linejoin': 'round',
          }),
        );
      face(
        [
          iso(x, y + d, z),
          iso(x + w, y + d, z),
          iso(x + w, y + d, z + height),
          iso(x, y + d, z + height),
        ],
        t[2],
      );
      face(
        [
          iso(x + w, y, z),
          iso(x + w, y + d, z),
          iso(x + w, y + d, z + height),
          iso(x + w, y, z + height),
        ],
        t[1],
      );
      face(
        [
          iso(x, y, z + height),
          iso(x + w, y, z + height),
          iso(x + w, y + d, z + height),
          iso(x, y + d, z + height),
        ],
        t[0],
      );
    };
    const line = (a, b, color, width) =>
      out.push(
        element('path', {
          d: ln(a, b),
          stroke: color,
          'stroke-width': width ?? 0.6,
          'stroke-linecap': 'round',
          fill: 'none',
        }),
      );
    const dot = (p, r, fill) => out.push(element('circle', { cx: p[0], cy: p[1], r, fill }));
    const W = 120;
    const D = 80;
    const gap = 4 + opening * 30;
    [
      [6, 6],
      [W - 10, 6],
      [W - 10, D - 10],
      [6, D - 10],
    ].forEach(([a, b]) => {
      box(a, b, 0, 4, 4, 3, 'base');
    });
    let z = 3;
    box(0, 0, z, W, D, 14, 'base', active === 0);
    for (let i = 0; i < 16; i++)
      line(iso(8 + i * 4, D, z + 4), iso(8 + i * 4, D, z + 10), '#37373A', 0.9);
    for (let i = 0; i < 4; i++) dot(iso(W, 10 + i * 6, z + 7), 1.1, '#0A0808');
    dot(iso(86, D, z + 7), 1.2, '#3DD68C');
    dot(iso(92, D, z + 7), 1.2, '#37373A');
    z += 14 + gap;
    box(0, 0, z, W, D, 6, 'mid', active === 1);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 2; j++)
        box(
          12 + i * 34,
          12 + j * 32,
          z + 6,
          26,
          22,
          12,
          i === 1 && j === 0 ? 'hi' : 'mid',
          active === 1,
        );
    z += 18 + gap;
    box(0, 0, z, W, D, 7, 'mid', active === 2);
    box(W - 30, 18, z + 7, 18, 18, 5, 'hi', active === 2);
    for (let i = 0; i < 10; i++)
      line(iso(10 + i * 5, D, z + 2), iso(10 + i * 5, D, z + 5), '#454548', 0.8);
    z += 12 + gap;
    box(0, 0, z, W, D, 4, 'mid', active === 3);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 4; j++)
        dot(iso(12 + i * 18, 12 + j * 18, z + 4), 1.3, active === 3 ? '#D7D7DB' : '#545457');
    for (let i = 0; i < 5; i++)
      line(
        iso(12 + i * 18, 12, z + 4),
        iso(30 + i * 18, 66, z + 4),
        active === 3 ? 'rgba(201,201,205,0.6)' : 'rgba(255,255,255,0.12)',
        0.5,
      );
    z += 4 + gap;
    box(0, 0, z, W, D, 10, active === 4 ? 'red' : 'hi', active === 4);
    [
      [4, 4],
      [W - 4, 4],
      [W - 4, D - 4],
      [4, D - 4],
    ].forEach(([a, b]) => {
      dot(iso(a, b, z + 10), 0.9, '#68686B');
    });
    for (let i = 0; i < 3; i++)
      line(iso(14, 20 + i * 6, z + 10), iso(60, 20 + i * 6, z + 10), '#68686B', 0.6);
    dot(iso(100, D, z + 5), 1.6, '#BEBEC2');
    const top = iso(W / 2, D / 2, z + 10);
    const sky = iso(W / 2, D / 2, z + 80);
    out.push(
      element('path', {
        d: ln(top, sky),
        stroke: 'url(#anB)',
        'stroke-width': 2.2,
        'stroke-linecap': 'round',
      }),
    );
    dot(top, 2.2, '#BEBEC2');
    svg.setAttribute(
      'viewBox',
      [-W * 0.95, -(z + 90), W * 1.9 + 10, z + 90 + (W + D) * 0.5 + 16]
        .map((v) => v.toFixed(0))
        .join(' '),
    );
    group.replaceChildren(...out);
  };

  let layer = null;
  let open = false;
  let opening = 0;
  let hovering = false;
  let drawn = '';
  const paintRows = () => {
    rows.forEach((row, index) => {
      const on = layer === index;
      const icon = row.querySelector('i');
      const [name, bar, description] = row.querySelector(':scope > div').children;
      icon.style.color = on ? '#BEBEC2' : '#6E6E74';
      icon.style.filter = on ? 'drop-shadow(0 0 8px #BEBEC2)' : 'none';
      name.style.color = on ? '#FFFFFF' : '#C9C9CC';
      bar.style.transition = `transform ${on ? 2200 : 0}ms linear`;
      bar.style.transform = `scaleX(${on ? 1 : 0})`;
      bar.style.opacity = on ? '1' : '0';
      if (description) description.style.opacity = '';
    });
    if (readout)
      readout.textContent =
        layer === null
          ? idle
          : (rows[layer].querySelector(':scope > div > div')?.textContent ?? idle);
  };
  const frame = () => {
    const target = open ? 1 : 0;
    if (Math.abs(target - opening) > 0.002) opening += (target - opening) * 0.12;
    else opening = target;
    const key = opening.toFixed(3) + '|' + String(layer);
    if (key !== drawn) {
      draw(opening, layer);
      drawn = key;
    }
    if (!reduced) requestAnimationFrame(frame);
  };
  if (reduced) {
    opening = 1;
    open = true;
    frame();
  } else {
    requestAnimationFrame(frame);
    setInterval(() => {
      if (hovering) return;
      const next = layer === null ? 0 : (layer + 1) % 6;
      layer = next === 5 ? null : next;
      open = next !== 5;
      paintRows();
    }, 2200);
  }
  rows.forEach((row, index) => {
    row.addEventListener('mouseenter', () => {
      hovering = true;
      layer = index;
      open = true;
      paintRows();
      if (reduced) {
        drawn = '';
        frame();
      }
    });
    row.addEventListener('mouseleave', () => {
      hovering = false;
    });
  });
  paintRows();
})();

// Hero background: a perspective field of thin lines, redrawn at most 25 times per second.
(() => {
  const cv = document.querySelector('[data-terrain] canvas');
  if (!cv) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let W = 0;
  let H = 0;
  let c = null;
  let mx = 0;
  let my = 0;
  let tx = 0;
  let ty = 0;
  let raf = 0;
  let last = 0;
  let HZF = 0.37;
  const t0 = performance.now();
  const size = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = cv.clientWidth;
    H = cv.clientHeight;
    if (!W || !H) return;
    const btn = cv.closest('section').querySelector('a[data-dc-tpl="75"]');
    if (btn) {
      const br = btn.getBoundingClientRect();
      const cr = cv.getBoundingClientRect();
      HZF = Math.max(0.3, Math.min(0.7, (br.bottom - cr.top + (W < 760 ? 30 : 60)) / H));
    }
    cv.width = W * dpr;
    cv.height = H * dpr;
    c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const prof = (x, z) => {
    const ax = Math.abs(x);
    let y = ax > 0.5 ? 2.2 * Math.pow(ax - 0.5, 2.2) * (0.2 + 2.4 / Math.pow(z, 1.25)) : 0;
    if (x > 0)
      y +=
        0.14 * Math.exp(-Math.pow((x - 1.25) / 0.28, 2)) * Math.exp(-Math.pow((z - 3.8) / 1.0, 2));
    return y * (1 + 0.06 * Math.sin(z * 0.9 + ax));
  };
  const ZS = [];
  for (let k = 0; k <= 110; k++) ZS.push(0.35 * Math.pow(40 / 0.35, k / 110));
  const draw = (time) => {
    if (!c) return;
    c.clearRect(0, 0, W, H);
    const cx = W / 2 + tx * W * 0.012;
    const hz = H * HZF + ty * H * 0.008;
    const F = H * 0.55;
    const KX = Math.max((W / H) * 0.85, W < 760 ? 0.72 : 0);
    const cam = 0.32;
    const ph = time * 0.0004;
    const P = (x, y, z) => [cx + (x * F * KX) / z, hz + ((cam - y) * F) / z];
    const glow = c.createRadialGradient(cx, hz, 0, cx, hz, W * 0.42);
    glow.addColorStop(0, 'rgba(255,255,255,0.13)');
    glow.addColorStop(0.35, 'rgba(255,255,255,0.035)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, W, H);
    c.lineWidth = 0.5;
    const N = 640;
    for (let i = 0; i <= N; i++) {
      const u0 = (i / N) * 2 - 1;
      const x =
        Math.sign(u0) * (0.5 * Math.pow(Math.abs(u0), 0.6) + 2.2 * Math.pow(Math.abs(u0), 2.2));
      const ax = Math.abs(x);
      const slope = ax > 0.5 ? 5.8 * Math.pow(ax - 0.5, 0.8) : 0;
      const lit =
        ax <= 0.5
          ? 0.05 + 0.1 * (1 - ax / 0.5)
          : 0.06 +
            0.75 * Math.exp(-Math.pow((slope - 1.1) / 0.8, 2)) +
            0.3 * Math.exp(-Math.pow((slope - 4.2) / 1.8, 2));
      const al = Math.min(0.85, lit * (0.82 + 0.18 * Math.sin(x * 9 - ph * 5)));
      if (al < 0.012) continue;
      c.beginPath();
      let st = false;
      for (const z of ZS) {
        const p = P(x, prof(x, z), z);
        if (p[1] < -H || p[0] < -W || p[0] > 2 * W) {
          if (st) break;
          continue;
        }
        if (st) c.lineTo(p[0], p[1]);
        else c.moveTo(p[0], p[1]);
        st = true;
      }
      c.strokeStyle = 'rgba(236,236,241,' + al.toFixed(3) + ')';
      c.stroke();
    }
    c.globalCompositeOperation = 'destination-out';
    const fog = c.createRadialGradient(cx, hz, 0, cx, hz, W * 0.09);
    fog.addColorStop(0, 'rgba(0,0,0,0.35)');
    fog.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = fog;
    c.fillRect(0, 0, W, H);
    const top = c.createRadialGradient(cx, hz * 0.5, 0, cx, hz * 0.5, Math.min(W * 0.4, H * 0.42));
    top.addColorStop(0, 'rgba(0,0,0,0.95)');
    top.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = top;
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
    for (let i = -10; i <= 10; i++) {
      const x = cx + i * 2.4;
      const al2 = 0.22 * Math.pow(1 - Math.abs(i) / 11, 2);
      const yb = hz - H * 0.16;
      const g = c.createLinearGradient(0, yb, 0, hz);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(255,255,255,' + al2.toFixed(3) + ')');
      c.strokeStyle = g;
      c.lineWidth = 0.5;
      c.beginPath();
      c.moveTo(x, yb);
      c.lineTo(x, hz);
      c.stroke();
    }
    const vg = c.createRadialGradient(cx, hz, Math.min(W, H) * 0.4, cx, hz, Math.max(W, H) * 0.9);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.5)');
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);
  };
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (now - last < 40) return;
    last = now;
    tx += (mx - tx) * 0.07;
    ty += (my - ty) * 0.07;
    draw(now - t0);
  };
  size();
  draw(0);
  new ResizeObserver(() => {
    size();
    draw(performance.now() - t0);
  }).observe(cv);
  window.addEventListener('mousemove', (e) => {
    mx = (e.clientX / window.innerWidth) * 2 - 1;
    my = (e.clientY / window.innerHeight) * 2 - 1;
  });
  let visible = false;
  const sync = () => {
    const run = visible && !reduce.matches;
    if (run && !raf) raf = requestAnimationFrame(loop);
    if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  reduce.addEventListener('change', sync);
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    sync();
  }).observe(cv);
})();
