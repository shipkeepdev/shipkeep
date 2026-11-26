// Hero drawing: your servers and their control plane, written in characters. Racks stand under and
// beside the text, their status lights blink, and their agents call out: packets climb from each rack,
// run along the cables around the text and reach the control plane at the top, never the other way.
// No dependency and no network; still when the visitor asks for reduced motion, and paused while the
// hero is out of sight.
(() => {
  const canvas = document.querySelector('.hero .art');
  if (!canvas) return;
  const host = canvas.parentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const FPS = 12;
  const SHADES = 12;
  const INK = '242,242,243';
  const FONT = '"Geist Mono", ui-monospace, monospace';
  // The page's example servers and control plane (reserved names, as in the rest of the page).
  const NAMES = ['srv-par-1', 'srv-fra-2', 'srv-ams-3'];
  const CONTROL_PLANE = 'cp.example.com:7443';
  const CABLE = 0.32;

  const context = canvas.getContext('2d');
  const base = document.createElement('canvas');
  const baseContext = base.getContext('2d');

  let art = null;
  let lights = [];
  let routes = [];
  let packets = [];
  let inbox = null;
  let frame = 0;
  let visible = true;
  let running = false;
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const between = (min, max) => min + Math.floor(random() * (max - min + 1));
  const smooth = (edge0, edge1, x) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };

  // Fronts of a server, by the width they fill inside the rack.
  const FRONTS = [
    (n) => `[${':'.repeat(Math.max(0, n - 2))}]`,
    (n) => '[__]'.repeat(Math.ceil(n / 4)).slice(0, n),
    (n) => '='.repeat(n),
    (n) => ' o'.repeat(Math.ceil(n / 2)).slice(0, n),
    (n) => `|${'.'.repeat(Math.max(0, n - 2))}|`,
    (n) => '#'.repeat(Math.ceil(n / 3)).padEnd(n, '-'),
  ];

  function measure() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return null;
    const narrow = width < 640;
    const size = narrow ? 8 : 9;
    const line = narrow ? 9 : 10;
    baseContext.font = `${size}px ${FONT}`;
    const cell = baseContext.measureText('M').width;
    const rows = Math.floor(height / line);
    // The last row stands on the bottom edge, on the deployment rail.
    return {
      width,
      height,
      size,
      line,
      cell,
      cols: Math.ceil(width / cell),
      rows,
      top: height - rows * line,
    };
  }

  // Where the text is, in cells, with a margin: nothing is drawn there.
  function textZones(view) {
    const box = host.getBoundingClientRect();
    // A zoomed page reports boxes zoomed, and sizes not: bring the boxes back to the canvas's scale.
    const scale = box.width / view.width || 1;
    return [...host.children]
      .filter((element) => element !== canvas)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width && rect.height)
      .map((rect) => ({
        c0: Math.floor((rect.left - box.left) / scale / view.cell) - 3,
        c1: Math.ceil((rect.right - box.left) / scale / view.cell) + 2,
        r0: Math.floor(((rect.top - box.top) / scale - view.top) / view.line) - 1,
        r1: Math.ceil(((rect.bottom - box.top) / scale - view.top) / view.line),
      }));
  }

  function compose(view) {
    const { cols, rows } = view;
    const chars = new Array(cols * rows).fill(' ');
    const alpha = new Float32Array(cols * rows);
    const blocked = new Uint8Array(cols * rows);
    const zones = textZones(view);
    for (const zone of zones)
      for (let r = Math.max(0, zone.r0); r <= Math.min(rows - 1, zone.r1); r++)
        for (let c = Math.max(0, zone.c0); c <= Math.min(cols - 1, zone.c1); c++)
          blocked[r * cols + c] = 1;
    const set = (c, r, char, strength) => {
      if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
      const i = r * cols + c;
      if (blocked[i]) return false;
      chars[i] = char;
      alpha[i] = strength;
      return true;
    };
    const write = (c, r, text, strength) =>
      [...text].forEach((char, k) => set(c + k, r, char, strength));
    // The highest row a drawing may reach in each column without touching the text.
    const free = new Int32Array(cols);
    for (let c = 0; c < cols; c++) {
      let r = rows - 1;
      while (r >= 0 && !blocked[r * cols + c]) r--;
      free[c] = r + 1;
    }
    const bottom = rows - 1;
    const room = (c0, w) => {
      let top = 0;
      for (let c = Math.max(0, c0); c < Math.min(cols, c0 + w); c++) top = Math.max(top, free[c]);
      return bottom - top + 1;
    };
    // Racks under the text are fainter than those beside it, which frame the title; on a phone,
    // where the text takes the whole width, they all stay clear.
    const middle = cols / 2;
    const left = Math.min(...zones.map((zone) => zone.c0), cols);
    const right = Math.max(...zones.map((zone) => zone.c1), 0);
    const floor = right - left > cols * 0.75 ? 0.85 : 0.5;
    const fade = (c) => floor + (1 - floor) * smooth(0.25, 0.75, Math.abs(c - middle) / middle);

    // The cables: a bus under the text, a riser on each side of it, and a bus over it that leads to
    // the control plane, when the hero has room for it above the text.
    const textTop = Math.min(...zones.map((zone) => zone.r0), rows);
    const riserLeft = Math.max(1, left - 2);
    const riserRight = Math.min(cols - 2, right + 2);
    let busRow = 0;
    for (let c = riserLeft; c <= riserRight; c++) busRow = Math.max(busRow, free[c]);
    busRow = Math.min(bottom - 6, busRow + 1);
    // The box's title is the page's own words (data-title), its address the page's example.
    const title = ` ${canvas.dataset.title || 'control plane'}`;
    const address = ` * ${CONTROL_PLANE} `;
    const boxWidth = Math.max(title.length, address.length) + 3;
    const boxLeft = Math.round(middle - boxWidth / 2);
    const topRow = textTop >= 7 ? 3 : -1;
    const ceiling = topRow >= 0 ? topRow + 2 : 0;

    seed = 7919;
    // A sparse dust, thicker near the floor, as in the background of a long exposure.
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (random() < 0.012 + 0.03 * (r / rows)) set(c, r, '.', 0.05 + 0.13 * (r / rows));
    for (let c = 0; c < cols; c++) set(c, bottom, '_', 0.28);

    lights = [];
    const rack = (c0, w, h, strength, detailed) => {
      const t = bottom - h + 1;
      const tone = strength * fade(c0 + w / 2);
      const edge = tone * 0.85;
      for (let c = c0; c < c0 + w; c++) set(c, t, c === c0 || c === c0 + w - 1 ? '.' : '-', edge);
      for (let r = t + 1; r <= bottom; r++) {
        set(c0, r, '|', edge);
        set(c0 + w - 1, r, '|', edge);
      }
      for (let c = c0 + 1; c < c0 + w - 1; c++) set(c, bottom, '_', edge);
      const width = detailed ? w - 5 : w - 3;
      let r = t + 1;
      while (r < bottom) {
        if (random() < 0.12) {
          r++; // an empty slot
          continue;
        }
        const front = FRONTS[Math.floor(random() * FRONTS.length)](width);
        const units = random() < 0.3 ? 2 : 1;
        const lit = random() < 0.8;
        for (let k = 0; k < units && r < bottom; k++, r++) {
          for (let n = 0; n < width; n++) set(c0 + 2 + n, r, front[n] ?? ' ', tone * 0.5);
          if (detailed && lit && k === 0 && set(c0 + w - 3, r, '*', tone))
            lights.push({
              c: c0 + w - 3,
              r,
              on: random() < 0.7,
              rate: 0.03 + random() * 0.14,
              tone,
            });
        }
      }
      return { c0, w, t };
    };
    const row = (from, to, strength, detailed, low, high, under) => {
      const result = [];
      let c = from;
      while (c < to) {
        // Beside the text, racks are wide enough to carry a name plate.
        const w = Math.min(detailed ? between(under ? 11 : 13, 16) : between(7, 11), to - c);
        const space = Math.min(
          room(c, w) - 1,
          bottom - ceiling - 1,
          under ? bottom - busRow - 2 : rows,
        );
        const h = Math.min(space, Math.round(space * (low + random() * (high - low))));
        if (w >= (detailed ? 11 : 7) && h >= 4)
          result.push({ ...rack(c, w, h, strength, detailed), under });
        c += w + between(detailed ? 1 : 0, detailed ? 3 : 2);
      }
      return result;
    };

    // Back row first, pale and taller.
    row(-between(0, 4), cols, 0.24, false, 0.55, 0.95, false);

    // Cables over the back row.
    for (let c = riserLeft + 1; c < riserRight; c++) set(c, busRow, '-', CABLE);
    for (const riser of [riserLeft, riserRight]) {
      for (let r = busRow - 1; r > Math.max(topRow, -1); r--) set(riser, r, ':', CABLE);
      set(riser, busRow, '+', CABLE + 0.1);
    }
    if (topRow >= 0) {
      for (let c = riserLeft; c <= riserRight; c++) set(c, topRow, '-', CABLE);
      for (const riser of [riserLeft, riserRight]) set(riser, topRow, '+', CABLE + 0.1);
    }

    // Front row, which leaves the risers' columns clear.
    const placed = [
      ...row(-between(2, 5), riserLeft - 1, 0.95, true, 0.45, 1, false),
      ...row(riserLeft + 2, riserRight - 1, 0.95, true, 0.3, 0.75, true),
      ...row(riserRight + 2, cols + 4, 0.95, true, 0.45, 1, false),
    ];

    // Each rack's route out: up to the bus, along it to the nearer riser, up to the top bus and along
    // it to the control plane; or, beside the text, straight up.
    routes = [];
    const boxEdge = (c) => (c < middle ? boxLeft - 1 : boxLeft + boxWidth);
    for (const { c0, w, t } of placed) {
      const c = c0 + Math.floor(w / 2);
      const route = [];
      const climb = (x, from, to) => {
        for (let r = from; r > to; r--) route.push([x, r]);
      };
      const along = (r, from, to) => {
        const way = to < from ? -1 : 1;
        for (let x = from; x !== to; x += way) route.push([x, r]);
      };
      if (c > riserLeft && c < riserRight) {
        for (let r = t - 1; r > busRow; r--) set(c, r, ':', CABLE);
        set(c, busRow, '+', CABLE + 0.1);
        climb(c, t - 1, busRow);
        const riser = c - riserLeft <= riserRight - c ? riserLeft : riserRight;
        along(busRow, c, riser);
        if (topRow >= 0) {
          climb(riser, busRow, topRow);
          along(topRow, riser, boxEdge(riser));
          route.push([boxEdge(riser), topRow]);
        } else climb(riser, busRow, -1);
      } else if (c > 1 && c < cols - 2 && random() < 0.7) {
        // A rack beside the text climbs on its own, then joins the top bus.
        const end = topRow >= 0 ? topRow : -1;
        for (let r = t - 1; r > end; r--) set(c, r, ':', CABLE * 0.75);
        climb(c, t - 1, end);
        if (topRow >= 0) {
          set(c, topRow, '+', CABLE + 0.1);
          for (let x = Math.min(c, riserLeft); x <= Math.max(c, riserRight); x++)
            if (chars[topRow * cols + x] === ' ') set(x, topRow, '-', CABLE);
          along(topRow, c, boxEdge(c));
          route.push([boxEdge(c), topRow]);
        }
      }
      if (route.length > 3) routes.push(route);
    }

    // The control plane's box, over every cable.
    inbox = null;
    if (topRow >= 0) {
      write(boxLeft, topRow - 2, `.${'-'.repeat(boxWidth - 2)}.`, 0.7);
      write(boxLeft, topRow - 1, `|${title.padEnd(boxWidth - 2)}|`, 0.6);
      write(boxLeft, topRow, `|${address.padEnd(boxWidth - 2)}|`, 0.9);
      write(boxLeft, topRow + 1, `'${'-'.repeat(boxWidth - 2)}'`, 0.7);
      inbox = { c: boxLeft + 2, r: topRow, glow: 0 };
    }

    // Name plates, in the page's order: the tallest rack on the left, under the text, on the right.
    const tallest = (racks) =>
      racks.filter(({ w }) => w - 4 >= NAMES[0].length).sort((a, b) => a.t - b.t)[0];
    [
      tallest(placed.filter((rack) => !rack.under && rack.c0 < middle)),
      tallest(placed.filter((rack) => rack.under)),
      tallest(placed.filter((rack) => !rack.under && rack.c0 > middle)),
    ]
      .filter(Boolean)
      .forEach(({ c0, w, t }, n) => {
        const name = `[${NAMES[n]}]`;
        write(c0 + Math.floor((w - name.length) / 2), t, name, 0.8);
      });
    return { ...view, chars, alpha };
  }

  function render() {
    const view = measure();
    if (!view) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    for (const target of [canvas, base]) {
      target.width = Math.round(view.width * ratio);
      target.height = Math.round(view.height * ratio);
    }
    art = compose(view);
    packets = [];
    baseContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    baseContext.clearRect(0, 0, view.width, view.height);
    baseContext.font = `${view.size}px ${FONT}`;
    baseContext.textBaseline = 'top';
    // One pass per shade: each row is one string, with blanks where another shade goes.
    for (let s = 1; s <= SHADES; s++) {
      baseContext.fillStyle = `rgba(${INK},${(s / SHADES).toFixed(3)})`;
      for (let r = 0; r < view.rows; r++) {
        let text = '';
        let any = false;
        for (let c = 0; c < view.cols; c++) {
          const i = r * view.cols + c;
          if (art.chars[i] !== ' ' && Math.max(1, Math.round(art.alpha[i] * SHADES)) === s) {
            text += art.chars[i];
            any = true;
          } else text += ' ';
        }
        if (any) baseContext.fillText(text, 0, view.top + r * view.line);
      }
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.font = `${view.size}px ${FONT}`;
    context.textBaseline = 'top';
    draw();
  }

  // Writes one character over the still drawing.
  function put(c, r, char, strength) {
    const x = c * art.cell;
    const y = art.top + r * art.line;
    context.clearRect(x, y, art.cell, art.line);
    context.fillStyle = `rgba(${INK},${strength.toFixed(3)})`;
    context.fillText(char, x, y);
  }

  function draw() {
    if (!art) return;
    context.clearRect(0, 0, art.width, art.height);
    context.drawImage(base, 0, 0, art.width, art.height);
    for (const light of lights)
      put(light.c, light.r, light.on ? '*' : '.', light.on ? light.tone : 0.4 * light.tone);
    if (inbox) put(inbox.c, inbox.r, inbox.glow ? '@' : '*', inbox.glow ? 1 : 0.55);
    for (const packet of packets)
      for (let back = 3; back >= 0; back--) {
        const index = Math.floor(packet.at) - back;
        const at = packet.route[index];
        if (!at) continue;
        const next = packet.route[index + 1] ?? at;
        const across = next[1] === at[1] && next[0] !== at[0];
        const head = across ? (next[0] > at[0] ? '>' : '<') : '^';
        put(at[0], at[1], back ? (across ? '=' : '|') : head, back ? 0.75 - back * 0.18 : 1);
      }
  }

  function step() {
    frame++;
    for (const light of lights) if (Math.random() < light.rate) light.on = !light.on;
    if (inbox && inbox.glow) inbox.glow--;
    for (const packet of packets) {
      const at = packet.route[Math.floor(packet.at)];
      const next = packet.route[Math.floor(packet.at) + 1];
      // Cells are about twice as tall as wide: a packet crosses two columns in the time of one row.
      packet.at += next && at && next[1] === at[1] ? 2 : 1;
      if (inbox && !packet.done && packet.at >= packet.route.length - 1) {
        packet.done = true;
        inbox.glow = 3;
      }
    }
    packets = packets.filter((packet) => packet.at < packet.route.length + 3);
    if (frame % 4 === 0 && routes.length && packets.length < 12)
      packets.push({
        route: routes[Math.floor(Math.random() * routes.length)],
        at: 0,
        done: false,
      });
    draw();
  }

  // One frame, then a pause until the next: the page is woken 12 times a second, not 60.
  function loop() {
    if (!visible || motion.matches || document.hidden) {
      running = false;
      return;
    }
    step();
    setTimeout(() => requestAnimationFrame(loop), 1000 / FPS);
  }
  const start = () => {
    if (running || !visible || motion.matches || document.hidden) return;
    running = true;
    requestAnimationFrame(loop);
  };

  let pending = 0;
  new ResizeObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(render, 120);
  }).observe(host);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    start();
  }).observe(host);
  document.addEventListener('visibilitychange', start);
  motion.addEventListener('change', () => {
    packets = [];
    draw();
    start();
  });
  // The text's place and the cell size depend on the page's fonts: draw again once they are in.
  document.fonts.ready.then(render, render);
  render();
  start();
})();
