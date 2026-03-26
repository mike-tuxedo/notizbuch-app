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
  ctx.strokeStyle = background === 'grid' ? 'rgba(180, 200, 220, 0.35)' : 'rgba(180, 200, 220, 0.4)';
  ctx.lineWidth = 0.5;

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
