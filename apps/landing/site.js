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
      icon.style.color = open ? '#FF6B6B' : '#5A5A5E';
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
    base: ['#1E1A1A', '#141111', '#0E0C0C', '#2E2828'],
    mid: ['#2A2424', '#1C1818', '#151212', '#3A3232'],
    hi: ['#3A3030', '#2A2222', '#1F1919', '#4A3E3E'],
    red: ['#C8262C', '#8A1418', '#5E0C10', '#FF6B6B'],
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
    element('stop', { offset: 0, 'stop-color': '#FF5C5C', 'stop-opacity': 1 }),
    element('stop', { offset: 1, 'stop-color': '#FF5C5C', 'stop-opacity': 0 }),
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
      const stroke = lit ? '#FF6B6B' : t[3];
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
      line(iso(8 + i * 4, D, z + 4), iso(8 + i * 4, D, z + 10), '#3A3232', 0.9);
    for (let i = 0; i < 4; i++) dot(iso(W, 10 + i * 6, z + 7), 1.1, '#0A0808');
    dot(iso(86, D, z + 7), 1.2, '#3DD68C');
    dot(iso(92, D, z + 7), 1.2, '#3A3232');
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
      line(iso(10 + i * 5, D, z + 2), iso(10 + i * 5, D, z + 5), '#4A3E3E', 0.8);
    z += 12 + gap;
    box(0, 0, z, W, D, 4, 'mid', active === 3);
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 4; j++)
        dot(iso(12 + i * 18, 12 + j * 18, z + 4), 1.3, active === 3 ? '#FF9C9C' : '#5A4A4A');
    for (let i = 0; i < 5; i++)
      line(
        iso(12 + i * 18, 12, z + 4),
        iso(30 + i * 18, 66, z + 4),
        active === 3 ? 'rgba(255,120,120,0.6)' : 'rgba(255,255,255,0.12)',
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
      dot(iso(a, b, z + 10), 0.9, '#6E5E5E');
    });
    for (let i = 0; i < 3; i++)
      line(iso(14, 20 + i * 6, z + 10), iso(60, 20 + i * 6, z + 10), '#6E5E5E', 0.6);
    dot(iso(100, D, z + 5), 1.6, '#FF5C5C');
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
    dot(top, 2.2, '#FF5C5C');
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
      icon.style.color = on ? '#FF5C5C' : '#6E6E74';
      icon.style.filter = on ? 'drop-shadow(0 0 8px #FF5C5C)' : 'none';
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
