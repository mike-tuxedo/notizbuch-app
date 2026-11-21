// canvas.js — Canvas Drawing Engine
// Catmull-Rom Smoothing, Polygon-Rendering, Bitmap-Cache, Multi-Layer Canvas.
// Exportiert reine Funktionen — kein State, kein DOM-Zugriff.

// ─── Koordinaten ────────────────────────────────────────────────────────────

/**
 * Koordinaten auf 0.1 Präzision runden (für Speicherung).
 * @param {Array<{x: number, y: number}>} points
 * @returns {Array<{x: number, y: number}>}
 */
export function roundPoints(points) {
  return points.map(p => ({
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10
  }));
}

// ─── Catmull-Rom Smoothing ──────────────────────────────────────────────────

/**
 * Punkte mit Catmull-Rom Spline glätten.
 * Erzeugt 4 Segmente pro Punkt-Paar für glatte Kurven.
 * @param {Array<{x: number, y: number}>} points - Rohpunkte
 * @returns {Array<{x: number, y: number}>} Geglättete Punkte
 */
export function smoothPoints(points) {
  if (points.length < 3) return points;
  const result = [];
  const numSegments = 4;

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    for (let t = 0; t < numSegments; t++) {
      const s = t / numSegments;
      const s2 = s * s;
      const s3 = s2 * s;

      result.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * s + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * s2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * s3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * s + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * s2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * s3)
      });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

// ─── Stroke Polygon ─────────────────────────────────────────────────────────

/**
 * Stroke-Polygon aus Punkten und Breite berechnen.
 * Erzeugt zwei Kanten (links/rechts) mit senkrechten Offsets für die Strichbreite.
 * @param {Array<{x: number, y: number}>} points - Geglättete Punkte
 * @param {number} width - Strichbreite in Pixel
 * @returns {Array<{x: number, y: number}>|null} Polygon-Punkte oder null
 */
export function buildStrokePolygon(points, width) {
  if (points.length < 2) return null;

  const leftEdge = [];
  const rightEdge = [];
  const halfWidth = width / 2;

  for (let i = 0; i < points.length; i++) {
    const curr = points[i];

    let dx, dy;
    if (i === 0) {
      dx = points[1].x - curr.x;
      dy = points[1].y - curr.y;
    } else if (i === points.length - 1) {
      dx = curr.x - points[i - 1].x;
      dy = curr.y - points[i - 1].y;
    } else {
      dx = points[i + 1].x - points[i - 1].x;
      dy = points[i + 1].y - points[i - 1].y;
    }

    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    leftEdge.push({ x: curr.x + nx * halfWidth, y: curr.y + ny * halfWidth });
    rightEdge.push({ x: curr.x - nx * halfWidth, y: curr.y - ny * halfWidth });
  }

  return [...leftEdge, ...rightEdge.reverse()];
}

// ─── Stroke Rendering ───────────────────────────────────────────────────────

/**
 * Einzelnen Stroke auf einen Canvas-Context zeichnen.
 * Nutzt Catmull-Rom Smoothing + Polygon-Fill.
 * Eraser nutzt globalCompositeOperation = 'destination-out'.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{points: Array, color: string, size: number, tool: string}} stroke
 */
export function drawStrokeToCanvas(ctx, stroke) {
  // Formen werden als Vektor gezeichnet; stroke.points ist bei ihnen nur der Umriss für alte Versionen
  if (stroke.tool === 'shape' && isValidShape(stroke.shape)) { drawShapeToCanvas(ctx, stroke); return; }
  // Füllflächen: Vektorfläche UNTER allem, was schon gezeichnet ist; stroke.points ist nur der Umriss für alte Versionen
  if (stroke.tool === 'fill') { if (isValidFill(stroke)) drawFillToCanvas(ctx, stroke); return; }
  if (!stroke.points || stroke.points.length < 2) return;

  const pts = stroke.points.length >= 3 ? smoothPoints(stroke.points) : stroke.points;
  const size = stroke.tool === 'eraser' ? stroke.size * 3 : stroke.size;

  ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.fillStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : stroke.color;

  // Kreise an jedem Punkt für glatte Verbindungen
  for (let i = 0; i < pts.length; i++) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Polygon füllen
  const polygon = buildStrokePolygon(pts, size);
  if (polygon && polygon.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x, polygon[i].y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

// ─── Formen (Rechteck, Ellipse, Linie, Pfeil) ───────────────────────────────
// Eine Form ist ein Strich mit tool:'shape' und shape:{type,x1,y1,x2,y2} (Weltkoordinaten).
// Zusätzlich trägt sie in points ihren Umriss als Punktfolge — alte App-Versionen kennen
// 'shape' nicht und zeichnen damit wenigstens den Umriss als Stiftstrich.

export const SHAPE_TYPES = ['rect', 'ellipse', 'line', 'arrow'];

const r1 = v => Math.round(v * 10) / 10;

/** @returns {boolean} shape hat einen bekannten Typ und vier endliche Koordinaten */
export function isValidShape(shape) {
  return !!shape && SHAPE_TYPES.includes(shape.type)
    && [shape.x1, shape.y1, shape.x2, shape.y2].every(Number.isFinite);
}

/** Geometrie einer Form auf 0.1 runden (für Speicherung). */
export function roundShape(shape) {
  return { type: shape.type, x1: r1(shape.x1), y1: r1(shape.y1), x2: r1(shape.x2), y2: r1(shape.y2) };
}

/** Die beiden Enden der Pfeilspitze; die Spitze wächst mit der Strichstärke. */
export function arrowHead(shape, size) {
  const dx = shape.x2 - shape.x1, dy = shape.y2 - shape.y1;
  const len = Math.hypot(dx, dy) || 1;
  const head = Math.min(Math.max(10, size * 4), len * 0.6);
  const ang = Math.atan2(dy, dx), spread = Math.PI / 6;
  return {
    a: { x: shape.x2 - head * Math.cos(ang - spread), y: shape.y2 - head * Math.sin(ang - spread) },
    b: { x: shape.x2 - head * Math.cos(ang + spread), y: shape.y2 - head * Math.sin(ang + spread) }
  };
}

/** Strecke a→b in gleichmäßigen Schritten an out anhängen (ohne a selbst). */
function sampleSegment(out, a, b, step) {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
  for (let i = 1; i <= n; i++) out.push({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });
}

/**
 * Umriss einer Form als Punktfolge (Ersatzdarstellung für alte Versionen, Treffertest, grobe Grenzen).
 * Der alte Renderer glättet mit Catmull-Rom: gleichmäßig dichte Punkte halten Geraden gerade und
 * Ecken scharf (die Rundung bleibt unter einem Achtel des Punktabstands). Doppelte Punkte an den
 * Ecken wären falsch — sie erzeugen dort Schleifen.
 */
export function shapeOutlinePoints(shape, size = 2) {
  const { type, x1, y1, x2, y2 } = shape;
  const out = [];
  if (type === 'line') {
    out.push({ x: x1, y: y1 }, { x: x2, y: y2 });
  } else if (type === 'arrow') {
    const tail = { x: x1, y: y1 }, tip = { x: x2, y: y2 };
    const { a, b } = arrowHead(shape, size);
    const step = Math.max(4, Math.hypot(x2 - x1, y2 - y1) / 80);
    out.push(tail);
    sampleSegment(out, tail, tip, step);
    sampleSegment(out, tip, a, 4);
    sampleSegment(out, a, tip, 4);
    sampleSegment(out, tip, b, 4);
  } else if (type === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    const n = Math.min(96, Math.max(24, Math.round(Math.PI * (rx + ry) / 6)));
    // zwei Punkte über den Anfang hinaus: so schließt die geglättete Kurve ohne Knick
    for (let i = 0; i <= n + 2; i++) {
      const t = 2 * Math.PI * i / n;
      out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
    }
  } else {
    const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
    const step = Math.max(4, (r - l + b - t) / 80);
    // Anfang und Ende mitten auf der Oberkante, nicht in einer Ecke
    const start = { x: (l + r) / 2, y: t };
    const path = [start, { x: r, y: t }, { x: r, y: b }, { x: l, y: b }, { x: l, y: t }, start];
    out.push(start);
    for (let i = 1; i < path.length; i++) sampleSegment(out, path[i - 1], path[i], step);
  }
  return roundPoints(out);
}

/** Form als Vektor zeichnen: Kontur in Strichstärke, Rechteck/Ellipse optional gefüllt. */
export function drawShapeToCanvas(ctx, stroke) {
  const { type, x1, y1, x2, y2 } = stroke.shape;
  const size = stroke.size || 2;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = stroke.color || '#000000';
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = type === 'rect' ? 'miter' : 'round';
  ctx.beginPath();
  if (type === 'rect') {
    ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (type === 'ellipse') {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    if (type === 'arrow') {
      const { a, b } = arrowHead(stroke.shape, size);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(x2, y2);
      ctx.lineTo(b.x, b.y);
    }
  }
  if (stroke.fill && (type === 'rect' || type === 'ellipse')) {
    ctx.fillStyle = stroke.fill;
    ctx.fill();
  }
  ctx.stroke();
  ctx.restore();
}

/** Form als SVG-Element (<rect>, <ellipse>, <line>, Pfeil als <path>). Farben müssen schon maskiert sein. */
export function shapeToSvg(stroke, color, fill) {
  const { type, x1, y1, x2, y2 } = stroke.shape;
  const size = stroke.size || 2;
  const line = `stroke="${color}" stroke-width="${size}"`;
  const inner = `fill="${fill || 'none'}"`;
  if (type === 'rect') {
    return `<rect x="${r1(Math.min(x1, x2))}" y="${r1(Math.min(y1, y2))}" width="${r1(Math.abs(x2 - x1))}" height="${r1(Math.abs(y2 - y1))}" ${inner} ${line} stroke-linejoin="miter"/>`;
  }
  if (type === 'ellipse') {
    return `<ellipse cx="${r1((x1 + x2) / 2)}" cy="${r1((y1 + y2) / 2)}" rx="${r1(Math.abs(x2 - x1) / 2)}" ry="${r1(Math.abs(y2 - y1) / 2)}" ${inner} ${line}/>`;
  }
  if (type === 'line') {
    return `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" ${line} stroke-linecap="round"/>`;
  }
  const { a, b } = arrowHead(stroke.shape, size);
  return `<path d="M ${r1(x1)} ${r1(y1)} L ${r1(x2)} ${r1(y2)} M ${r1(a.x)} ${r1(a.y)} L ${r1(x2)} ${r1(y2)} L ${r1(b.x)} ${r1(b.y)}" fill="none" ${line} stroke-linecap="round" stroke-linejoin="round"/>`;
}

// ─── Füllflächen (Werkzeug „Füllen“) ────────────────────────────────────────
// Eine Füllfläche ist ein Strich mit tool:'fill' und polys: Array von Ringen aus {x, y} in
// Weltkoordinaten (erster Ring = Außenkontur, weitere = Löcher), gefüllt nach 'evenodd'.
// points trägt die Außenkontur als Punktfolge — alte App-Versionen zeichnen damit den Umriss.

/** @returns {boolean} stroke ist eine Füllfläche mit mindestens einem Ring aus ≥ 3 endlichen Punkten */
export function isValidFill(stroke) {
  return !!stroke && stroke.tool === 'fill' && Array.isArray(stroke.polys) && stroke.polys.length > 0
    && stroke.polys.every(ring => Array.isArray(ring) && ring.length >= 3
      && ring.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)));
}

/**
 * Außenkontur als geschlossene Punktfolge (Ersatzdarstellung für alte Versionen, die sie als
 * Stiftstrich zeichnen). Lange Kanten werden unterteilt: Der alte Renderer glättet mit Catmull-Rom,
 * und nur bei gleichmäßig dichten Punkten bleiben Geraden gerade (siehe shapeOutlinePoints).
 */
export function fillOutlinePoints(polys) {
  const outer = polys?.[0] || [];
  if (!outer.length) return [];
  let perimeter = 0;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const step = Math.max(6, perimeter / 240);
  const out = [outer[0]];
  for (let i = 0; i < outer.length; i++) sampleSegment(out, outer[i], outer[(i + 1) % outer.length], step);
  return roundPoints(out);
}

/** Liegt der Punkt in der Fläche? (evenodd über alle Ringe) */
export function pointInFill(polys, x, y) {
  let inside = false;
  for (const ring of polys) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Füllfläche zeichnen — mit 'destination-over': Sie legt sich UNTER alles, was zeitlich vor ihr
 * gezeichnet wurde (Linien bleiben scharf, früher Wegradiertes wird mitgefüllt). Spätere Striche
 * und Radierer wirken normal darüber. Das Ziel muss dafür eine transparente Ebene sein
 * (kein Papier darunter gemalt) — sonst läge die Füllung unsichtbar unter dem Papier.
 */
export function drawFillToCanvas(ctx, stroke) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = stroke.color || '#000000';
  ctx.beginPath();
  for (const ring of stroke.polys) {
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
  }
  ctx.fill('evenodd');
  ctx.restore(); // setzt globalCompositeOperation zurück
}

/** Füllfläche als SVG-<path> mit fill-rule="evenodd". Die Farbe muss schon maskiert sein. */
export function fillToSvg(stroke, color) {
  const d = stroke.polys.map(ring => ring.map((p, i) => `${i ? 'L' : 'M'} ${r1(p.x)} ${r1(p.y)}`).join(' ') + ' Z').join(' ');
  return `<path d="${d}" fill="${color}" fill-rule="evenodd" stroke="none"/>`;
}

/**
 * Flutfüllung auf einem RGBA-Pixelfeld und Nachzeichnen der gefüllten Maske als Ringe.
 *  1. Scanline-Flutfüllung (Spannen-Stapel, 4er-Nachbarschaft, ohne Rekursion) über alle Pixel mit
 *     Alpha < alphaThreshold. Erreicht sie den Bildrand, ist die Fläche offen ('open').
 *  2. Maske erweitern — nur in belegte Pixel hinein (die Füllung liegt unter den Linien; so bleibt
 *     kein heller Saum): erst alle belegten 4er-Nachbarn, dann (grow = 2) deren 8er-Nachbarn, sofern
 *     sie deckend sind (Alpha ≥ solidAlpha) — so schaut die Fläche hinter dünnen Linien nicht heraus.
 *  3. Kanten der Maske entlang der Pixelgrenzen verfolgen: ein Ring je Rand (außen + Löcher).
 * Der Aufwand nach der Flutfüllung hängt nur vom Umfang der Fläche ab.
 * @param {Uint8ClampedArray} rgba - Pixel (ImageData.data), Breite W, Höhe H
 * @param {number} sx - Startpixel
 * @param {number} sy
 * @returns {{status: 'solid'|'open'|'tiny'}|{status: 'ok', area: number, rings: Array<number[]>}}
 *   rings: je Ring flache Folge [x0, y0, x1, y1, …] der Eckpunkte in Pixel-Koordinaten
 *   (Pixelecken, ganzzahlig); der Ring mit der größten Fläche steht vorn.
 */
export function traceFillRegion(rgba, W, H, sx, sy, opts = {}) {
  const T = opts.alphaThreshold ?? 16;
  const solidAlpha = opts.solidAlpha ?? 128;
  const grow = opts.grow ?? 2;
  const minArea = opts.minArea ?? 12;
  const minRingArea = opts.minRingArea ?? 4;
  if (!(sx >= 1 && sy >= 1 && sx < W - 1 && sy < H - 1)) return { status: 'open' };
  // Alpha ist das oberste Byte (alle unterstützten Plattformen sind Little-Endian)
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H);
  if ((px[sy * W + sx] >>> 24) >= T) return { status: 'solid' };

  // Maske: 1 = geflutet, 2/3 = erweitert; Bits 16/32/64/128 = besuchte Kante (siehe 3.)
  const mask = new Uint8Array(W * H);
  const W1 = W - 1, H1 = H - 1;
  const edge = []; // belegte 4er-Nachbarn der Fläche (Maske 2)
  let area = 0;

  // 1. Flutfüllung. Stapel aus Spannen (y, x1, x2, dy): Zeile y, x1..x2 ist gefüllt, als Nächstes y + dy.
  let st = new Int32Array(4096), sp = 0;
  const push = (y, x1, x2, dy) => {
    if (sp + 4 > st.length) { const bigger = new Int32Array(st.length * 2); bigger.set(st); st = bigger; }
    st[sp++] = y; st[sp++] = x1; st[sp++] = x2; st[sp++] = dy;
  };
  push(sy, sx, sx, 1);
  push(sy + 1, sx, sx, -1);
  while (sp) {
    const dy = st[--sp], x2 = st[--sp], x1 = st[--sp], y = st[--sp] + dy;
    const row = y * W;
    const inner = y > 0 && y < H1; // nur dort wird erweitert
    let x = x1, l = 0, i;
    while (x >= 0 && !mask[i = row + x] && (px[i] >>> 24) < T) { mask[i] = 1; x--; }
    let skip = x >= x1;
    if (!skip) {
      if (x < 0 || !inner) return { status: 'open' };
      if (!mask[i = row + x] && x > 0) { mask[i] = 2; edge.push(i); }
      l = x + 1;
      if (l < x1) push(y, l, x1 - 1, -dy);
      x = x1 + 1;
    } else if (inner && !mask[i = row + x] && x > 0 && x < W1) { mask[i] = 2; edge.push(i); }
    do {
      if (!skip) {
        while (x < W && !mask[i = row + x] && (px[i] >>> 24) < T) { mask[i] = 1; x++; }
        if (x >= W) return { status: 'open' };
        if (!mask[i = row + x] && x < W1) { mask[i] = 2; edge.push(i); }
        area += x - l;
        push(y, l, x - 1, dy);
        if (x > x2 + 1) push(y, x2 + 1, x - 1, -dy);
      }
      skip = false;
      x++;
      while (x <= x2 && (mask[i = row + x] || (px[i] >>> 24) >= T)) {
        if (!mask[i] && inner && x < W1) { mask[i] = 2; edge.push(i); }
        x++;
      }
      // Am oberen/unteren Bildrand darf nichts mehr frei sein
      if (!inner && x <= x2) return { status: 'open' };
      l = x;
    } while (x <= x2);
  }
  if (area < minArea) return { status: 'tiny' };

  // 2. Zweiter Schritt der Erweiterung: deckende 8er-Nachbarn der Randpixel (nie in die Bildrand-Pixel)
  const edge2 = [];
  if (grow >= 2) {
    const around = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
    for (let n = 0; n < edge.length; n++) {
      for (let a = 0; a < 8; a++) {
        const j = edge[n] + around[a];
        if (mask[j] || (px[j] >>> 24) < solidAlpha) continue;
        const jx = j % W;
        if (jx === 0 || jx === W1 || j < W || j >= W * H1) continue;
        mask[j] = 3;
        edge2.push(j);
      }
    }
  }

  // 3. Ränder verfolgen. Jede Pixelkante zwischen „drin“ und „draußen“ gehört zu genau einem Ring;
  //    das Innere liegt in Laufrichtung rechts. Besuchte Kanten: Bits 16/32/64/128 am inneren Pixel
  //    (oben/rechts/unten/links). Jeder Ring enthält mindestens eine Oberkante, und geflutete Pixel
  //    haben keine Außenkante (ihre Nachbarn sind geflutet oder erweitert) — gesucht wird also nur
  //    an den erweiterten Pixeln.
  const rings = [];
  for (const list of [edge, edge2]) {
    for (let n = 0; n < list.length; n++) {
      const i0 = list[n];
      if ((mask[i0] & 16) || mask[i0 - W]) continue;
      const x0 = i0 % W, y0 = (i0 - x0) / W;
      const pts = [];
      let vx = x0, vy = y0, d = 0; // Ecke (vx, vy), Richtung 0 = rechts, 1 = unten, 2 = links, 3 = oben
      do {
        let right, left; // die beiden Pixel vor der nächsten Ecke: rechts und links der Laufrichtung
        if (d === 0) { mask[vy * W + vx] |= 16; vx++; right = mask[vy * W + vx]; left = mask[(vy - 1) * W + vx]; }
        else if (d === 1) { mask[vy * W + vx - 1] |= 32; vy++; right = mask[vy * W + vx - 1]; left = mask[vy * W + vx]; }
        else if (d === 2) { mask[(vy - 1) * W + vx - 1] |= 64; vx--; right = mask[(vy - 1) * W + vx - 1]; left = mask[vy * W + vx - 1]; }
        else { mask[(vy - 1) * W + vx] |= 128; vy--; right = mask[(vy - 1) * W + vx]; left = mask[(vy - 1) * W + vx - 1]; }
        // Berühren sich zwei Pixel nur über Eck, biegt der Ring rechts ab (bleibt am eigenen Pixel)
        const nd = !right ? (d + 1) & 3 : (left ? (d + 3) & 3 : d);
        if (nd !== d) pts.push(vx, vy);
        d = nd;
      } while (vx !== x0 || vy !== y0 || d !== 0);
      let a2 = 0;
      for (let k = 0, n2 = pts.length; k < n2; k += 2) {
        const j = (k + 2) % n2;
        a2 += pts[k] * pts[j + 1] - pts[j] * pts[k + 1];
      }
      const ringArea = Math.abs(a2) / 2;
      if (ringArea >= minRingArea) rings.push({ pts, area: ringArea });
    }
  }
  if (!rings.length) return { status: 'tiny' };
  rings.sort((p, q) => q.area - p.area);
  return { status: 'ok', area, rings: rings.map(r => r.pts) };
}

/**
 * Geschlossenen Ring vereinfachen (Ramer-Douglas-Peucker, ohne Rekursion).
 * @param {number[]} pts - flache Folge [x0, y0, x1, y1, …]
 * @param {number} tol - größte erlaubte Abweichung
 * @returns {number[]} flache Folge der behaltenen Punkte
 */
export function simplifyRing(pts, tol) {
  const n = pts.length / 2;
  if (n <= 4) return pts.slice();
  // Zwei feste Punkte: der erste und der von ihm am weitesten entfernte
  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) {
    const dx = pts[2 * i] - pts[0], dy = pts[2 * i + 1] - pts[1];
    const dd = dx * dx + dy * dy;
    if (dd > farD) { farD = dd; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const tol2 = tol * tol;
  const todo = [0, far, far, n]; // Index n steht für den ersten Punkt (Ring geschlossen)
  while (todo.length) {
    const j = todo.pop(), i = todo.pop();
    if (j - i < 2) continue;
    const ax = pts[2 * i], ay = pts[2 * i + 1];
    const jj = j === n ? 0 : j;
    const dx = pts[2 * jj] - ax, dy = pts[2 * jj + 1] - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1, worstD = -1;
    for (let k = i + 1; k < j; k++) {
      const qx = pts[2 * k] - ax, qy = pts[2 * k + 1] - ay;
      const t = l2 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / l2)) : 0;
      const ex = qx - dx * t, ey = qy - dy * t;
      const dd = ex * ex + ey * ey;
      if (dd > worstD) { worstD = dd; worst = k; }
    }
    if (worstD > tol2) { keep[worst] = 1; todo.push(i, worst, worst, j); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

// ─── Objekte: Abbildung, Grenzen, Treffertest ───────────────────────────────

/** @returns {boolean} t ist [sx, sy, tx, ty] mit endlichen Werten und ohne Null-Skalierung */
export function isValidTransform(t) {
  return Array.isArray(t) && t.length === 4 && t.every(Number.isFinite) && t[0] !== 0 && t[1] !== 0;
}

/**
 * Objekt (Strich, Form oder Füllfläche) mit [sx, sy, tx, ty] abbilden: x' = sx·x + tx, y' = sy·y + ty.
 * Liefert ein neues Objekt; die Strichstärke bleibt. Bei Formen wird der Umriss neu berechnet,
 * bei Füllflächen werden alle Ringe abgebildet.
 */
export function transformStroke(stroke, t) {
  const [sx, sy, tx, ty] = t;
  const map = p => ({ x: p.x * sx + tx, y: p.y * sy + ty });
  if (stroke.tool === 'shape' && isValidShape(stroke.shape)) {
    const p1 = map({ x: stroke.shape.x1, y: stroke.shape.y1 });
    const p2 = map({ x: stroke.shape.x2, y: stroke.shape.y2 });
    const shape = roundShape({ type: stroke.shape.type, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
    return { ...stroke, shape, points: shapeOutlinePoints(shape, stroke.size) };
  }
  if (isValidFill(stroke)) {
    const polys = stroke.polys.map(ring => roundPoints(ring.map(map)));
    return { ...stroke, polys, points: fillOutlinePoints(polys) };
  }
  return { ...stroke, points: roundPoints((stroke.points || []).map(map)) };
}

/** Grenzen der Geometrie (ohne Strichstärke) in Weltkoordinaten, oder null. */
export function strokeGeomBounds(stroke) {
  const pts = stroke.tool === 'shape' && isValidShape(stroke.shape)
    ? [{ x: stroke.shape.x1, y: stroke.shape.y1 }, { x: stroke.shape.x2, y: stroke.shape.y2 }]
    : (isValidFill(stroke) ? stroke.polys[0] : (stroke.points || []));
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function distToSegment(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

/**
 * Trifft der Punkt das Objekt? Stiftstrich und Kontur: Abstand zur Linie; gefüllte Form: auch die Fläche;
 * Füllfläche: Punkt in der Fläche (evenodd) oder näher als tol an einem ihrer Ränder.
 * Radierer-Striche sind nie wählbar.
 * @param {number} tol - Toleranz in Weltkoordinaten (zusätzlich zur halben Strichstärke)
 */
export function hitTestStroke(stroke, x, y, tol) {
  if (stroke.tool === 'eraser') return false;
  if (stroke.tool === 'fill') {
    if (!isValidFill(stroke)) return false;
    if (pointInFill(stroke.polys, x, y)) return true;
    if (!(tol > 0)) return false;
    for (const ring of stroke.polys) {
      for (let i = 0; i < ring.length; i++) {
        if (distToSegment(x, y, ring[i], ring[(i + 1) % ring.length]) <= tol) return true;
      }
    }
    return false;
  }
  const pts = stroke.points || [];
  if (pts.length < 2) return false;
  const reach = tol + (stroke.size || 1) / 2;
  if (stroke.tool === 'shape' && isValidShape(stroke.shape) && stroke.fill) {
    const { type, x1, y1, x2, y2 } = stroke.shape;
    if (type === 'rect' && x >= Math.min(x1, x2) - reach && x <= Math.max(x1, x2) + reach
      && y >= Math.min(y1, y2) - reach && y <= Math.max(y1, y2) + reach) return true;
    if (type === 'ellipse') {
      const rx = Math.abs(x2 - x1) / 2 + reach, ry = Math.abs(y2 - y1) / 2 + reach;
      const nx = (x - (x1 + x2) / 2) / rx, ny = (y - (y1 + y2) / 2) / ry;
      if (nx * nx + ny * ny <= 1) return true;
    }
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(x, y, pts[i - 1], pts[i]) <= reach) return true;
  }
  return false;
}

// ─── Background Drawing ─────────────────────────────────────────────────────

/**
 * Hintergrund (Kariert/Liniert/Blank) auf einen Canvas zeichnen.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width - Canvas-Breite
 * @param {number} height - Canvas-Höhe
 * @param {string} background - 'grid' | 'lined' | 'blank'
 * @param {number} viewX - View-Offset X
 * @param {number} viewY - View-Offset Y
 * @param {number} viewScale - Zoom-Faktor
 */
export function drawBackground(ctx, width, height, background, viewX, viewY, viewScale) {
  ctx.clearRect(0, 0, width, height);

  if (background === 'blank') return;

  const gridSize = 25 * viewScale;
  if (gridSize < 4) return; // Zu klein zum Zeichnen

  ctx.save();
  // --paper-line: in beiden Themes gleich, das Papier ist immer weiß
  ctx.strokeStyle = '#dde3ec';
  ctx.lineWidth = 1;

  const offsetX = viewX % gridSize;
  const offsetY = viewY % gridSize;

  if (background === 'grid') {
    // Vertikale Linien
    for (let x = offsetX; x < width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }
  // Horizontale Linien (grid + lined)
  for (let y = offsetY; y < height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.restore();
}
