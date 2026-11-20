// Interactions of the landing page. No dependency and no network; only the theme choice is stored.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const every = (ms, fn) => (reduced ? null : setInterval(fn, ms));

  // Theme: the light theme inverts the page, as in the design.
  const themeButtons = $$('[data-theme-toggle]');
  const showTheme = () => {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    themeButtons.forEach((button) => {
      const label = light ? button.dataset.dark : button.dataset.light;
      button.querySelector('.ti').className = `ti ${light ? 'ti-moon' : 'ti-sun'}`;
      const text = button.querySelector('span');
      if (text) text.textContent = label;
      else {
        button.setAttribute('aria-label', label);
        button.title = label;
      }
    });
  };
  themeButtons.forEach((button) =>
    button.addEventListener('click', () => {
      const light = document.documentElement.getAttribute('data-theme') !== 'light';
      if (light) document.documentElement.setAttribute('data-theme', 'light');
      else document.documentElement.removeAttribute('data-theme');
      try {
        localStorage.setItem('shipkeep-theme', light ? 'light' : 'dark');
      } catch {
        // Storage can be blocked: the choice lasts for this page only.
      }
      showTheme();
    }),
  );
  showTheme();

  // Mobile menu.
  const menu = $('#sk-menu');
  const burger = $('.burger');
  const setMenu = (open) => {
    menu.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) $('[data-close]', menu).focus();
    else burger.focus();
  };
  burger.addEventListener('click', () => setMenu(true));
  $('[data-close]', menu).addEventListener('click', () => setMenu(false));
  $$('nav a', menu).forEach((link) => link.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) setMenu(false);
  });

  // Hero: the deployment steps light up one after the other.
  const steps = $$('#sk-steps .step');
  const showStep = (current) => {
    steps.forEach((step, i) => {
      step.classList.toggle('cur', i === current || (current > 4 && i === 4));
      step.classList.toggle('done', i < current);
      step.querySelector('.v').textContent = i <= current ? step.dataset.v : '…';
    });
  };
  let step = reduced ? 6 : 0;
  showStep(step);
  every(1300, () => showStep((step = (step + 1) % 7)));

  // Gutters: columns of dots, drawn once per size.
  $$('.gut canvas').forEach((canvas) => {
    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      let seed = Number(canvas.dataset.seed);
      const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let x = 3; x < width; x += 5) {
        let y = -random() * 200;
        while (y < height) {
          const length = 30 + Math.pow(random(), 1.6) * 320;
          const gap = 40 + random() * 260;
          const hot = random() < 0.08;
          const alpha = hot ? 0.45 + random() * 0.35 : 0.07 + random() * 0.2;
          const tone = hot ? 236 : 150 + Math.floor(random() * 60);
          context.fillStyle = `rgba(${tone},${tone},${tone + 4},${alpha.toFixed(3)})`;
          for (let yy = y; yy < y + length && yy < height; yy += 3)
            context.fillRect(x, yy, 1.6, 1.6);
          y += length + gap;
        }
      }
    };
    draw();
    new ResizeObserver(draw).observe(canvas);
  });

  // Gutter badge: the deployment advances as the page scrolls.
  const badge = $('#sk-trav');
  const stages = JSON.parse(badge.dataset.stages);
  const marks = ['region', 'opensource', 'pourquoi', 'comparer', 'equipe', 'installer'].map((id) =>
    document.getElementById(id),
  );
  let stage = -1;
  const onScroll = () => {
    const middle = innerHeight * 0.55;
    let reached = 0;
    marks.forEach((mark, i) => {
      if (mark.getBoundingClientRect().top < middle) reached = i;
    });
    if (reached === stage) return;
    stage = reached;
    $('.lb', badge).textContent = stages[stage];
    $('.nn', badge).textContent = `${stage + 1}/6`;
    badge.classList.toggle('live', stage === 5);
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Anatomy: an exploded view of the five layers, which open one by one.
  const figure = $('#sk-anatomy');
  const layers = $$('#anatomie .layer');
  const readout = $('#anatomie .ro');
  const readoutIdle = readout.textContent;
  let active = null;
  let open = 0;
  let target = 0;
  let hovering = false;
  const drawAnatomy = () => {
    const iso = (x, y, z) => [(x - y) * 0.866, (x + y) * 0.5 - z];
    const fmt = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
    const poly = (points) => `M${points.map(fmt).join('L')}Z`;
    const parts = [];
    const tones = {
      base: ['#1E1A1A', '#141111', '#0E0C0C', '#2c2c2f'],
      mid: ['#28282b', '#1C1818', '#151212', '#37373a'],
      hi: ['#363639', '#27272a', '#1d1d20', '#454548'],
      lit: ['#88888c', '#5c5c60', '#3e3e42', '#c4c4c8'],
    };
    const face = (points, fill, stroke) =>
      parts.push(
        `<path d="${poly(points)}" fill="${fill}" stroke="${stroke}" stroke-width="0.6" stroke-linejoin="round"/>`,
      );
    const box = (x, y, z, w, d, h, tone, lit) => {
      const t = tones[tone];
      const stroke = lit ? '#c4c4c8' : t[3];
      face(
        [iso(x, y + d, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x, y + d, z + h)],
        t[2],
        stroke,
      );
      face(
        [iso(x + w, y, z), iso(x + w, y + d, z), iso(x + w, y + d, z + h), iso(x + w, y, z + h)],
        t[1],
        stroke,
      );
      face(
        [iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)],
        t[0],
        stroke,
      );
    };
    const line = (a, b, color, width = 0.6) =>
      parts.push(
        `<path d="M${fmt(a)}L${fmt(b)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" fill="none"/>`,
      );
    const dot = (p, r, fill) =>
      parts.push(
        `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r}" fill="${fill}"/>`,
      );
    const W = 120;
    const D = 80;
    const gap = 4 + open * 30;
    [
      [6, 6],
      [W - 10, 6],
      [W - 10, D - 10],
      [6, D - 10],
    ].forEach(([a, b]) => box(a, b, 0, 4, 4, 3, 'base'));
    let z = 3;
    box(0, 0, z, W, D, 14, 'base', active === 0);
    for (let i = 0; i < 16; i++)
      line(iso(8 + i * 4, D, z + 4), iso(8 + i * 4, D, z + 10), '#37373a', 0.9);
    [0, 1, 2, 3].forEach((i) => dot(iso(W, 10 + i * 6, z + 7), 1.1, '#0A0808'));
    dot(iso(86, D, z + 7), 1.2, '#3DD68C');
    dot(iso(92, D, z + 7), 1.2, '#37373a');
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
        dot(iso(12 + i * 18, 12 + j * 18, z + 4), 1.3, active === 3 ? '#d7d7db' : '#545457');
    for (let i = 0; i < 5; i++)
      line(
        iso(12 + i * 18, 12, z + 4),
        iso(30 + i * 18, 66, z + 4),
        active === 3 ? 'rgba(201,201,205,0.6)' : 'rgba(255,255,255,0.12)',
        0.5,
      );
    z += 4 + gap;
    box(0, 0, z, W, D, 10, active === 4 ? 'lit' : 'hi', active === 4);
    [
      [4, 4],
      [W - 4, 4],
      [W - 4, D - 4],
      [4, D - 4],
    ].forEach(([a, b]) => dot(iso(a, b, z + 10), 0.9, '#68686b'));
    for (let i = 0; i < 3; i++)
      line(iso(14, 20 + i * 6, z + 10), iso(60, 20 + i * 6, z + 10), '#68686b', 0.6);
    dot(iso(100, D, z + 5), 1.6, '#bebec2');
    const top = iso(W / 2, D / 2, z + 10);
    const sky = iso(W / 2, D / 2, z + 80);
    parts.push(
      `<path d="M${fmt(top)}L${fmt(sky)}" stroke="url(#skBeam)" stroke-width="2.2" stroke-linecap="round"/>`,
    );
    dot(top, 2.2, '#bebec2');
    // The view box of the fully opened stack, so that the drawing does not jump while it opens.
    const tallest = 3 + 14 + 18 + 12 + 4 + 4 * 34 + 10;
    const viewBox = [-W * 0.95, -(tallest + 90), W * 1.9 + 10, tallest + 90 + (W + D) * 0.5 + 16]
      .map((v) => v.toFixed(0))
      .join(' ');
    figure.innerHTML = `<svg xmlns="${NS}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><defs><linearGradient id="skBeam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#bebec2"/><stop offset="1" stop-color="#bebec2" stop-opacity="0"/></linearGradient></defs>${parts.join('')}</svg>`;
  };
  let frame = 0;
  const animate = () => {
    const delta = target - open;
    open = Math.abs(delta) < 0.002 || reduced ? target : open + delta * 0.12;
    drawAnatomy();
    frame = open === target ? 0 : requestAnimationFrame(animate);
  };
  const setLayer = (index) => {
    active = index;
    target = index === null ? 0 : 1;
    layers.forEach((layer, i) => layer.classList.toggle('on', i === index));
    readout.textContent = index === null ? readoutIdle : $('.n', layers[index]).textContent;
    if (!frame) frame = requestAnimationFrame(animate);
  };
  layers.forEach((layer, i) => {
    const enter = () => {
      hovering = true;
      setLayer(i);
    };
    const leave = () => {
      hovering = false;
    };
    layer.addEventListener('mouseenter', enter);
    layer.addEventListener('focus', enter);
    layer.addEventListener('mouseleave', leave);
    layer.addEventListener('blur', leave);
  });
  drawAnatomy();
  every(2200, () => {
    if (hovering) return;
    const next = active === null ? 0 : active + 1;
    setLayer(next > 4 ? null : next);
  });

  // shipkeep.yml: each line explains itself, in turn or when chosen.
  const ymlLines = $$('#opensource .yl');
  const ymlIcon = $('#opensource .yi .ti');
  const ymlTitle = $('#opensource .yt');
  const ymlText = $('#opensource .yx');
  let ymlIndex = 0;
  let ymlHeld = false;
  const showLine = (index) => {
    ymlIndex = index;
    ymlLines.forEach((line, i) => line.classList.toggle('on', i === index));
    const line = ymlLines[index];
    ymlIcon.className = `ti ${line.dataset.icon}`;
    ymlTitle.textContent = line.dataset.title;
    ymlText.textContent = line.dataset.text;
  };
  ymlLines.forEach((line, i) =>
    line.addEventListener('click', () => {
      ymlHeld = true;
      showLine(i);
    }),
  );
  every(4500, () => {
    if (!ymlHeld) showLine((ymlIndex + 1) % ymlLines.length);
  });

  // Services: one of them lights up at a time.
  const services = $$('#services .svc li');
  const lightService = (index) =>
    services.forEach((service, i) => {
      const on = i === index;
      service.classList.toggle('on', on);
      const mark = $('.lg', service);
      mark.style.backgroundImage = `url(https://cdn.simpleicons.org/${mark.dataset.slug}/${on ? 'f2f2f3' : '6e6e74'})`;
    });
  let serviceIndex = 0;
  every(1300, () => lightService((serviceIndex = (serviceIndex + 1) % services.length)));

  // Previews: a stack of pull request tiles.
  const tiles = $('#sk-tiles');
  const fragment = document.createDocumentFragment();
  for (let s = 0; s < 6; s++) {
    for (let k = 0; k < 12; k++) {
      if (s === 1 && (k === 5 || k === 6)) continue;
      const hot = s === 1 && k === 4;
      const tile = document.createElement('div');
      tile.className = hot ? 'tile hot' : 'tile';
      tile.style.right = `${s * 128 + 14 + k * 10 - (hot ? 4 : 0)}px`;
      tile.style.top = `${-46 + k * 30 - (hot ? 2 : 0)}px`;
      tile.style.animationDelay = `${-(s * 0.55 + k * 0.16)}s`;
      if (hot) tile.innerHTML = '<i class="ti ti-git-pull-request"></i>';
      fragment.append(tile);
    }
  }
  tiles.append(fragment);

  // Deployments: a new one builds, then goes live, and pushes the others down.
  const list = $('#sk-deploys');
  const rows = $$('li', list);
  const when = JSON.parse(list.dataset.when);
  const live = list.dataset.live;
  const pool = [
    '4f2c1a9',
    'a77e310',
    '6dac0a2',
    'c09a114',
    '9a0c771',
    'e13f5b2',
    '72dd0e4',
    'b81e0d3',
  ];
  let shift = 0;
  let building = false;
  const showDeploys = () => {
    rows.forEach((row, i) => {
      const top = i === 0 && building;
      row.children[0].textContent = pool[(shift - i + pool.length * 100) % pool.length];
      row.children[1].textContent = i === 0 ? when[building ? 0 : 1] : when[i + 1];
      row.children[2].innerHTML = `${top ? 'Build' : live}<i class="ti ${top ? 'ti-loader-2' : 'ti-circle-check-filled'}" aria-hidden="true"></i>`;
    });
  };
  every(2200, () => {
    building = !building;
    if (building) {
      shift += 1;
      list.classList.remove('moved');
      void list.offsetWidth;
      list.classList.add('moved');
    }
    showDeploys();
  });
  showDeploys();
})();
