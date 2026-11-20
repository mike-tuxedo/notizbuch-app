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

// ─── Objekte: Abbildung, Grenzen, Treffertest ───────────────────────────────

/** @returns {boolean} t ist [sx, sy, tx, ty] mit endlichen Werten und ohne Null-Skalierung */
export function isValidTransform(t) {
  return Array.isArray(t) && t.length === 4 && t.every(Number.isFinite) && t[0] !== 0 && t[1] !== 0;
}

/**
 * Objekt (Strich oder Form) mit [sx, sy, tx, ty] abbilden: x' = sx·x + tx, y' = sy·y + ty.
 * Liefert ein neues Objekt; die Strichstärke bleibt. Bei Formen wird der Umriss neu berechnet.
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
  return { ...stroke, points: roundPoints((stroke.points || []).map(map)) };
}

/** Grenzen der Geometrie (ohne Strichstärke) in Weltkoordinaten, oder null. */
export function strokeGeomBounds(stroke) {
  const pts = stroke.tool === 'shape' && isValidShape(stroke.shape)
    ? [{ x: stroke.shape.x1, y: stroke.shape.y1 }, { x: stroke.shape.x2, y: stroke.shape.y2 }]
    : (stroke.points || []);
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
 * Trifft der Punkt das Objekt? Stiftstrich und Kontur: Abstand zur Linie; gefüllte Form: auch die Fläche.
 * Radierer-Striche sind nie wählbar.
 * @param {number} tol - Toleranz in Weltkoordinaten (zusätzlich zur halben Strichstärke)
 */
export function hitTestStroke(stroke, x, y, tol) {
  if (stroke.tool === 'eraser') return false;
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
