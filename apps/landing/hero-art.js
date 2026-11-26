// Hero drawing: a container ship seen from ahead, written in faint characters behind the text, like
// a watermark. The ship is a small 3D model painted in shades of grey on a hidden canvas, then read
// back cell by cell and written with the page's monospaced font. Only the sea moves, slowly, and
// the masthead light blinks. No dependency and no network; still when the visitor asks for reduced
// motion, and paused while the hero is out of sight.
(() => {
  const canvas = document.querySelector('.hero .art');
  if (!canvas) return;
  const host = canvas.parentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const TICK = 350; // the sea moves about three times a second, slowly
  const SHADES = 10;
  const INK = '242,242,243';
  const FONT = '"Geist Mono", ui-monospace, monospace';
  // Characters for flat surfaces, from dark to lit, and the strongest a character gets: a
  // watermark, never a picture.
  const FILL = ':-=+*#%';
  const STRONGEST = 0.36;

  const context = canvas.getContext('2d');
  const base = document.createElement('canvas');
  const baseContext = base.getContext('2d');
  const source = document.createElement('canvas');
  const sourceContext = source.getContext('2d', { willReadFrequently: true });

  let art = null;
  let time = 0;
  let visible = true;
  let running = false;
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const smooth = (edge0, edge1, x) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  const grey = (value) => {
    const v = Math.round(Math.min(1, Math.max(0, value)) * 255);
    return `rgb(${v},${v},${v})`;
  };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const unit = (a) => scale(a, 1 / (Math.hypot(...a) || 1));
  const newell = (points) =>
    points.reduce(
      (n, a, i) => {
        const b = points[(i + 1) % points.length];
        return [
          n[0] + (a[1] - b[1]) * (a[2] + b[2]),
          n[1] + (a[2] - b[2]) * (a[0] + b[0]),
          n[2] + (a[0] - b[0]) * (a[1] + b[1]),
        ];
      },
      [0, 0, 0],
    );

  // The ship, in metres: x from the bow (0) to the stern, y up from the waterline, z to port.
  const LENGTH = 300;
  const BEAM = 46;
  const FREEBOARD = 15;
  const TIER = 2.6;
  const BOX = 12.2;
  const half = (x, flare) => {
    if (x <= 0) return 0;
    if (x < 52) return (BEAM / 2) * (1 - Math.pow((52 - x) / 52, flare));
    if (x > LENGTH - 18) return (BEAM / 2) * (1 - 0.25 * Math.pow((x - LENGTH + 18) / 18, 2));
    return BEAM / 2;
  };
  const deckHalf = (x) => half(x + 7, 1.6); // the bow flares: the deck reaches further than the water
  const waterHalf = (x) => half(x, 2.4);
  const deckY = (x) => FREEBOARD + 4.5 * Math.pow(Math.max(0, (46 - x) / 53), 2);

  function measure() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return null;
    const narrow = width < 640;
    const size = narrow ? 6 : 7;
    const line = narrow ? 7 : 8;
    baseContext.font = `${size}px ${FONT}`;
    const cell = baseContext.measureText('M').width;
    const rows = Math.floor(height / line);
    return {
      width,
      height,
      narrow,
      size,
      line,
      cell,
      cols: Math.ceil(width / cell),
      rows,
      top: height - rows * line,
    };
  }

  // A camera close to the bow, to starboard and just above the deck: the bow stands tall beside the
  // title, and the ship runs away to the left, under the buttons, to the horizon.
  function cameraFor(view) {
    const eye = [-150, 30, -150];
    const forward = unit(sub([150, 4, 0], eye));
    const right = unit(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const raw = (p) => {
      const d = sub(p, eye);
      const z = dot(d, forward);
      return [dot(d, right) / z, -dot(d, up) / z];
    };
    // Two anchors: the stem head, and the stern far away; the scale follows from their distance.
    const [bowAt, sternAt] = view.narrow ? [[0.97, 0.8], [-0.15]] : [[0.95, 0.6], [0.03]];
    const stemHead = raw([-7, deckY(-7), 0]);
    const sternEnd = raw([LENGTH, 0, -BEAM / 2]);
    const k = ((bowAt[0] - sternAt[0]) * view.width) / (stemHead[0] - sternEnd[0]);
    const ox = bowAt[0] * view.width - k * stemHead[0];
    const oy = bowAt[1] * view.height - k * stemHead[1];
    const project = (p) => {
      const [x, y] = raw(p);
      return [ox + k * x, oy + k * y];
    };
    // The horizon: where a level line far ahead lands.
    const ahead = unit([forward[0], 0, forward[2]]);
    const horizon = oy + k * (-dot(ahead, up) / dot(ahead, forward));
    return { eye, project, horizon };
  }

  // Paints the ship in shades of grey on black, far parts first.
  function paint(ctx, view, camera) {
    const { project, eye } = camera;
    const light = unit([-0.55, 0.8, -0.35]);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, -view.line, view.width, view.height + 2 * view.line);
    seed = 7919;
    // A flat face, lit by the sun and seen from the eye.
    const face = (points, tone) => {
      // Newell's normal: sound for any outline, even one that starts and ends on the same point,
      // as the deck does at the stem.
      const normal0 = unit(newell(points));
      const centre = scale(points.reduce(add), 1 / points.length);
      const normal = dot(normal0, sub(eye, centre)) < 0 ? scale(normal0, -1) : normal0;
      const lit = 0.25 + 0.75 * Math.max(0, dot(normal, light));
      ctx.fillStyle = grey(tone * lit);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      points.forEach((p, i) => {
        const [x, y] = project(p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke(); // no seam between neighbouring faces
    };
    // A rectangle on a face: origin, two edges, and the part of each edge it covers.
    const patch = (origin, u, v, u0, u1, v0, v1, tone) =>
      face(
        [
          add(origin, add(scale(u, u0), scale(v, v0))),
          add(origin, add(scale(u, u1), scale(v, v0))),
          add(origin, add(scale(u, u1), scale(v, v1))),
          add(origin, add(scale(u, u0), scale(v, v1))),
        ],
        tone,
      );

    // The deck, from side to side.
    const stations = [];
    for (let x = -7; x <= LENGTH; x += 2) stations.push(x);
    face(
      [
        ...stations.map((x) => [x, deckY(x), -deckHalf(x)]),
        ...stations.reverse().map((x) => [x, deckY(x), deckHalf(x)]),
      ],
      0.55,
    );
    stations.reverse();

    // The starboard side of the hull, from the stern forward: light topsides, a dark boot-top.
    for (let i = stations.length - 2; i >= 0; i--) {
      const x0 = stations[i];
      const x1 = stations[i + 1];
      const top0 = [x0, deckY(x0), -deckHalf(x0)];
      const top1 = [x1, deckY(x1), -deckHalf(x1)];
      const low0 = [Math.max(0, x0), 0, -waterHalf(x0)];
      const low1 = [Math.max(0, x1), 0, -waterHalf(x1)];
      const band = (p, q, t) => add(p, scale(sub(q, p), t));
      const split = 3 / FREEBOARD;
      const aft = 1 - 0.45 * smooth(20, LENGTH, x0);
      face([top0, top1, band(low1, top1, split), band(low0, top0, split)], 0.66 * aft);
      face([band(low0, top0, split), band(low1, top1, split), low1, low0], 0.24);
      // Strakes: thin dark seams along the flank, which run away to the horizon.
      for (const y of [5.5, 9, 12.4]) {
        const t0 = y / deckY(x0);
        const t1 = y / deckY(x1);
        const d0 = 0.22 / deckY(x0);
        face(
          [
            band(low0, top0, t0),
            band(low1, top1, t1),
            band(low1, top1, t1 + d0),
            band(low0, top0, t0 + d0),
          ],
          0.3,
        );
      }
      // The sheer strake, bright along the deck's edge.
      face([top0, top1, band(top1, low1, 0.05), band(top0, low0, 0.05)], 1);
    }
    // The anchor in its pocket.
    patch([9, deckY(9) - 5, -deckHalf(9) - 0.2], [1, 0, 0.35], [0, 1, 0], 0, 3, 0, 3, 0.15);

    // A stack of containers: its top, its side to starboard and its end towards the bow.
    const tones = [0.6, 0.72, 0.84];
    const stack = (x0, tiers) => {
      const width = Math.min(deckHalf(x0), deckHalf(x0 + BOX)) - 1.2;
      const floor = deckY(x0 + BOX) + 0.6;
      const height = tiers * TIER;
      const across = Math.round((2 * width) / 2.5);
      const gap = 0.32;
      // The stack's body in shadow, so that the gaps between boxes read as lines.
      face(
        [
          [x0, floor, -width],
          [x0 + BOX, floor, -width],
          [x0 + BOX, floor + height, -width],
          [x0, floor + height, -width],
        ],
        0.12,
      );
      face(
        [
          [x0, floor, -width],
          [x0, floor, width],
          [x0, floor + height, width],
          [x0, floor + height, -width],
        ],
        0.12,
      );
      // Top, then one box per tier on the side, and a grid of box ends towards the bow.
      face(
        [
          [x0, floor + height, -width],
          [x0 + BOX, floor + height, -width],
          [x0 + BOX, floor + height, width],
          [x0, floor + height, width],
        ],
        0.9,
      );
      const origin = [x0, floor, -width];
      for (let k = 0; k < tiers; k++) {
        const tone = tones[Math.floor(random() * tones.length)];
        patch(
          origin,
          [1, 0, 0],
          [0, 1, 0],
          gap,
          BOX - gap,
          k * TIER + gap,
          (k + 1) * TIER - gap,
          tone,
        );
      }
      const w = (2 * width) / across;
      for (let k = 0; k < tiers; k++)
        for (let n = 0; n < across; n++)
          patch(
            origin,
            [0, 0, 1],
            [0, 1, 0],
            n * w + gap,
            (n + 1) * w - gap,
            k * TIER + gap,
            (k + 1) * TIER - gap,
            tones[Math.floor(random() * tones.length)],
          );
    };

    // Aft containers, funnel and deckhouse first: they are the furthest from the eye.
    for (let x = LENGTH - 10 - BOX; x > 262; x -= BOX + 0.8) stack(x, 3 + Math.floor(random() * 2));
    // Funnel, with a light band and a dark cap.
    const funnel = (y0, y1, tone) => {
      const lean = (y) => (y - FREEBOARD) * 0.08;
      const at = (x, y, z) => [x + lean(y), y, z];
      face([at(250, y0, -5), at(259, y0, -5), at(259, y1, -5), at(250, y1, -5)], tone);
      face([at(250, y0, -5), at(250, y0, 5), at(250, y1, 5), at(250, y1, -5)], tone);
      face([at(250, y1, -5), at(259, y1, -5), at(259, y1, 5), at(250, y1, 5)], tone);
    };
    funnel(FREEBOARD, FREEBOARD + 50, 0.62);
    funnel(FREEBOARD + 43, FREEBOARD + 47, 0.95);
    funnel(FREEBOARD + 48, FREEBOARD + 51, 0.15);
    // Deckhouse: a tall block with rows of windows, the bridge across its top, wings to the sides.
    const house = { x0: 228, x1: 242, z: 13, top: FREEBOARD + 40 };
    face(
      [
        [house.x0, FREEBOARD, -house.z],
        [house.x1, FREEBOARD, -house.z],
        [house.x1, house.top, -house.z],
        [house.x0, house.top, -house.z],
      ],
      0.9,
    );
    face(
      [
        [house.x0, FREEBOARD, -house.z],
        [house.x0, FREEBOARD, house.z],
        [house.x0, house.top, house.z],
        [house.x0, house.top, -house.z],
      ],
      0.95,
    );
    for (let y = FREEBOARD + 3; y < house.top - 3; y += 2.8) {
      for (let z = -house.z + 1.2; z < house.z - 1; z += 2.2)
        patch([house.x0 - 0.05, y, z], [0, 0, 1], [0, 1, 0], 0, 1.1, 0, 1.1, 0.2);
      for (let x = house.x0 + 1; x < house.x1 - 1; x += 2.2)
        patch([x, y, -house.z - 0.05], [1, 0, 0], [0, 1, 0], 0, 1.1, 0, 1.1, 0.2);
    }
    const bridge = { x0: 227, x1: 237, z: BEAM / 2 + 1, y0: house.top, y1: house.top + 4.6 };
    face(
      [
        [bridge.x0, bridge.y0, -bridge.z],
        [bridge.x0, bridge.y0, bridge.z],
        [bridge.x0, bridge.y1, bridge.z],
        [bridge.x0, bridge.y1, -bridge.z],
      ],
      1,
    );
    face(
      [
        [bridge.x0, bridge.y1, -bridge.z],
        [bridge.x1, bridge.y1, -bridge.z],
        [bridge.x1, bridge.y1, bridge.z],
        [bridge.x0, bridge.y1, bridge.z],
      ],
      0.9,
    );
    patch(
      [bridge.x0 - 0.05, bridge.y0 + 1.6, -bridge.z + 1],
      [0, 0, 1],
      [0, 1, 0],
      0,
      2 * bridge.z - 2,
      0,
      1.8,
      0.12,
    );
    // The wings' starboard end.
    face(
      [
        [bridge.x0, bridge.y0, -bridge.z],
        [bridge.x1, bridge.y0, -bridge.z],
        [bridge.x1, bridge.y1, -bridge.z],
        [bridge.x0, bridge.y1, -bridge.z],
      ],
      0.8,
    );
    // Mast and radar on the bridge's roof.
    const mastTop = [231, bridge.y1 + 11, 0];
    patch([231, bridge.y1, -0.3], [0, 0, 1], [0, 1, 0], 0, 0.6, 0, 11, 0.9);
    patch([231, bridge.y1 + 7, -4], [0, 0, 1], [0, 1, 0], 0, 8, 0, 0.4, 0.9);
    patch([234, bridge.y1 + 1.5, -3], [0, 0, 1], [0, 1, 0], 0, 6, 0, 0.5, 0.9);
    // A lifeboat on the deckhouse's side.
    patch([house.x0 + 2, FREEBOARD + 12, -house.z - 1.5], [1, 0, 0], [0, 1, 0], 0, 9, 0, 2.2, 1);

    // Containers forward of the deckhouse, from the deckhouse to the breakwater.
    for (let x = 226 - BOX; x > 30; x -= BOX + 0.8) {
      const mid = x > 70 && x < 200;
      stack(x, (mid ? 6 : x <= 70 ? 4 : 5) + Math.floor(random() * 2));
    }
    // The breakwater on the forecastle, then the foremast and its light.
    const breakwater = 28;
    face(
      [
        [breakwater, deckY(breakwater), -deckHalf(breakwater) + 1],
        [breakwater, deckY(breakwater), deckHalf(breakwater) - 1],
        [breakwater, deckY(breakwater) + 2.4, deckHalf(breakwater) - 1],
        [breakwater, deckY(breakwater) + 2.4, -deckHalf(breakwater) + 1],
      ],
      0.6,
    );
    patch([6, deckY(6), -0.3], [0, 0, 1], [0, 1, 0], 0, 0.7, 0, 17, 0.95);
    patch([6, deckY(6) + 13, -3], [0, 0, 1], [0, 1, 0], 0, 6, 0, 0.4, 0.95);

    return {
      mast: project(mastTop),
      stem: project([0, 0, 0]),
      name: (() => {
        const x = 16;
        const y = FREEBOARD * 0.7;
        return project([
          x,
          y,
          -(waterHalf(x) + (deckHalf(x) - waterHalf(x)) * (y / deckY(x))) - 0.3,
        ]);
      })(),
    };
  }

  // Where the text is, in pixels of the hero, so that the drawing fades behind it.
  function textZones(view) {
    const box = host.getBoundingClientRect();
    // A zoomed page reports boxes zoomed, and sizes not: bring the boxes back to the canvas's scale.
    const ratio = box.width / view.width || 1;
    return [...host.children]
      .filter((element) => element !== canvas)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width && rect.height)
      .map((rect) => ({
        left: (rect.left - box.left) / ratio,
        right: (rect.right - box.left) / ratio,
        top: (rect.top - box.top) / ratio,
        bottom: (rect.bottom - box.top) / ratio,
      }));
  }

  function compose(view) {
    const { cols, rows, cell, line } = view;
    const S = 3;
    source.width = cols * S;
    source.height = rows * S;
    // One source pixel per third of a cell; the grid starts `top` pixels down the hero.
    sourceContext.setTransform(S / cell, 0, 0, S / line, 0, (-view.top * S) / line);
    const camera = cameraFor(view);
    const marks = paint(sourceContext, view, camera);
    const pixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
    const level = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let dy = 0; dy < S; dy++)
          for (let dx = 0; dx < S; dx++)
            sum += pixels[((r * S + dy) * source.width + c * S + dx) * 4];
        level[r * cols + c] = sum / (S * S * 255);
      }
    const zones = textZones(view);
    const fade = (x, y) => {
      let distance = Infinity;
      for (const zone of zones) {
        const dx = Math.max(zone.left - x, 0, x - zone.right);
        const dy = Math.max(zone.top - y, 0, y - zone.bottom);
        distance = Math.min(distance, Math.hypot(dx, dy));
      }
      return 0.35 + 0.65 * smooth(0, 56, distance);
    };
    const value = (c, r) =>
      level[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
    const horizonRow = Math.max(
      0,
      Math.min(rows - 1, Math.round((camera.horizon - view.top) / line)),
    );
    const chars = new Array(cols * rows).fill(' ');
    const alpha = new Float32Array(cols * rows);
    const mask = new Float32Array(cols * rows);
    const ship = new Uint8Array(cols * rows);
    seed = 104729;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        mask[i] = fade((c + 0.5) * cell, view.top + (r + 0.5) * line);
        const v = level[i];
        if (v < 0.04) {
          // A sparse dust in the sky, as on a long exposure.
          if (r < horizonRow && random() < 0.025) {
            chars[i] = '.';
            alpha[i] = 0.05 * mask[i];
          }
          continue;
        }
        ship[i] = 1;
        const lit = smooth(0.05, 0.85, v);
        const gx = (value(c + 1, r) - value(c - 1, r)) / cell;
        const gy = (value(c, r + 1) - value(c, r - 1)) / line;
        const edge = Math.hypot(gx, gy) * cell;
        let char;
        // Outlines carry the drawing; flat surfaces get a light texture, as in an engraving.
        if (edge > 0.24) {
          const ax = Math.abs(gx);
          const ay = Math.abs(gy);
          if (ax > ay * 2.4) char = '|';
          else if (ay > ax * 2.4) char = gy > 0 ? '_' : '-';
          else char = gx * gy > 0 ? '\\' : '/';
          alpha[i] = (0.2 + 0.16 * Math.min(1, edge)) * mask[i];
        } else {
          char = FILL[Math.min(FILL.length - 1, Math.floor(lit * FILL.length))];
          alpha[i] = (0.08 + 0.2 * lit) * mask[i];
        }
        chars[i] = char;
      }
    // The ship's name, painted on the bow.
    const nameRow = Math.floor((marks.name[1] - view.top) / line);
    const nameCol = Math.floor(marks.name[0] / cell) - 4;
    [...'SHIPKEEP'].forEach((char, k) => {
      const c = nameCol + k;
      if (c < 0 || c >= cols || nameRow < 0 || nameRow >= rows) return;
      chars[nameRow * cols + c] = char;
      alpha[nameRow * cols + c] = 0.34 * mask[nameRow * cols + c];
    });
    // Each column's waterline: the lowest row of the ship, where its reflection starts.
    const waterline = new Int32Array(cols).fill(-1);
    for (let c = 0; c < cols; c++)
      for (let r = rows - 1; r >= horizonRow; r--)
        if (ship[r * cols + c]) {
          waterline[c] = r;
          break;
        }
    const cellOf = ([x, y]) => [Math.floor(x / cell), Math.floor((y - view.top) / line)];
    return {
      ...view,
      chars,
      alpha,
      mask,
      level,
      ship,
      horizonRow,
      waterline,
      mast: cellOf(marks.mast),
      stem: cellOf(marks.stem),
    };
  }

  // Writes rows of characters: each row is read once, split by shade, and each shade present is
  // written as one string, with blanks where another shade goes.
  function writeRows(ctx, grid, chars, alpha, fromRow, toRow) {
    const { cols } = grid;
    const shades = Array.from({ length: SHADES + 1 }, () => []);
    for (let r = fromRow; r < toRow; r++) {
      const split = new Map();
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (chars[i] === ' ' || !alpha[i]) continue;
        const s = Math.max(1, Math.min(SHADES, Math.round((alpha[i] / STRONGEST) * SHADES)));
        let row = split.get(s);
        if (!row) split.set(s, (row = new Array(cols).fill(' ')));
        row[c] = chars[i];
      }
      // Only the stretch between the first and the last character is written.
      for (const [s, row] of split) {
        const text = row.join('');
        const first = text.search(/\S/);
        shades[s].push([r, first, text.slice(first).trimEnd()]);
      }
    }
    for (let s = 1; s <= SHADES; s++) {
      if (!shades[s].length) continue;
      ctx.fillStyle = `rgba(${INK},${((s / SHADES) * STRONGEST).toFixed(3)})`;
      for (const [r, first, text] of shades[s])
        ctx.fillText(text, first * grid.cell, grid.top + r * grid.line);
    }
  }

  // The sea at a given time, around the ship: its reflection broken by slow waves, a few crests that
  // thicken towards the eye, and the bow wave.
  function sea(grid, t) {
    const { cols, rows, horizonRow } = grid;
    const chars = new Array(cols * rows).fill(' ');
    const alpha = new Float32Array(cols * rows);
    const depth = Math.max(1, rows - horizonRow);
    for (let r = horizonRow; r < rows; r++) {
      const near = (r - horizonRow) / depth; // 0 at the horizon, 1 at the bottom
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (grid.ship[i]) continue;
        const wave =
          Math.sin(c * (0.08 + 0.12 * near) + t * 0.5 + r * 1.9) +
          0.6 * Math.sin(c * 0.037 - t * 0.27 + r * 0.7) +
          0.35 * Math.sin(c * 0.31 + t * 0.7 - r);
        let char = ' ';
        let strength = 0;
        const below = grid.waterline[c];
        if (r === horizonRow) {
          char = wave > 0 ? '_' : '-';
          strength = 0.07;
        } else if (
          below >= 0 &&
          r > below &&
          r - below < (below - horizonRow) * 0.8 + 3 &&
          wave > -0.5
        ) {
          // The reflection: the ship upside down, shifted by the waves.
          const k = r - below;
          const shift = Math.round(Math.sin(k * 1.2 + t * 0.6 + c * 0.04) * 1.5);
          const mirrored = below - Math.floor(k * 1.25);
          const v =
            mirrored >= 0
              ? grid.level[mirrored * cols + Math.min(cols - 1, Math.max(0, c + shift))]
              : 0;
          // Broken horizontal strokes, one row in two, as a reflection on moving water.
          if (v > 0.12 && k % 2 === 1 && wave > 0) {
            char = v > 0.5 ? '=' : wave > 0.9 ? '~' : '-';
            strength = (0.03 + 0.09 * v) * (1 - k / (depth + 1));
          }
        } else if (wave > 1.78 - near * 0.3) {
          char = '~';
          strength = 0.05 + 0.06 * near;
        } else if (wave > 1.6 - near * 0.3) {
          char = '-';
          strength = 0.035 + 0.04 * near;
        }
        // The bow wave, white along the stem.
        const [sc, sr] = grid.stem;
        const dc = (c - sc) / 3.2;
        const dr = r - sr;
        if (dr >= -1 && dr <= 2 && Math.abs(dc) < 6 && Math.sin(c * 0.9 + t * 1.6) > -0.2) {
          char = dr <= 0 ? '~' : '-';
          strength = Math.max(strength, 0.16 * (1 - Math.abs(dc) / 6));
        }
        chars[i] = char;
        alpha[i] = strength * grid.mask[i];
      }
    }
    return { chars, alpha };
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
    baseContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    baseContext.clearRect(0, 0, view.width, view.height);
    baseContext.font = `${view.size}px ${FONT}`;
    baseContext.textBaseline = 'top';
    writeRows(baseContext, art, art.chars, art.alpha, 0, art.rows);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.font = `${view.size}px ${FONT}`;
    context.textBaseline = 'top';
    draw();
  }

  function draw() {
    if (!art) return;
    context.clearRect(0, 0, art.width, art.height);
    context.drawImage(base, 0, 0, art.width, art.height);
    const water = sea(art, time);
    writeRows(context, art, water.chars, water.alpha, art.horizonRow, art.rows);
    // The masthead light, on for a second, off for a second and a half.
    const [c, r] = art.mast;
    if (c >= 0 && c < art.cols && r >= 0 && r < art.rows) {
      const on = motion.matches || time % 2.5 < 1;
      const x = c * art.cell;
      const y = art.top + r * art.line;
      context.clearRect(x, y, art.cell, art.line);
      context.fillStyle = `rgba(${INK},${(on ? 0.6 : 0.18) * art.mask[r * art.cols + c]})`;
      context.fillText(on ? '*' : '.', x, y);
    }
  }

  function loop() {
    if (!visible || motion.matches || document.hidden) {
      running = false;
      return;
    }
    time += TICK / 1000;
    draw();
    setTimeout(() => requestAnimationFrame(loop), TICK);
  }
  const start = () => {
    if (running || !visible || motion.matches || document.hidden) return;
    running = true;
    setTimeout(() => requestAnimationFrame(loop), TICK);
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
    draw();
    start();
  });
  // The text's place and the cell size depend on the page's fonts: draw again once they are in.
  document.fonts.ready.then(render, render);
  render();
  start();
})();
