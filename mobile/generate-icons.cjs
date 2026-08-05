const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const BG = [6, 16, 12, 255];
const GREEN = [105, 255, 154, 255];
const GREEN_DARK = [34, 168, 93, 255];
const TRANSPARENT = [0, 0, 0, 0];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mix(a, b, amount) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * amount));
}

function blendPixel(png, x, y, color, coverage = 1) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height || coverage <= 0) return;
  const index = (png.width * y + x) << 2;
  const sourceAlpha = (color[3] / 255) * clamp(coverage, 0, 1);
  const destinationAlpha = png.data[index + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    const source = color[channel] / 255;
    const destination = png.data[index + channel] / 255;
    png.data[index + channel] = Math.round(((source * sourceAlpha) + (destination * destinationAlpha * (1 - sourceAlpha))) / outputAlpha * 255);
  }
  png.data[index + 3] = Math.round(outputAlpha * 255);
}

function fill(png, color) {
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) blendPixel(png, x, y, color, 1);
  }
}

function smoothCoverage(distance, radius, feather = 1.25) {
  return clamp((radius + feather - distance) / (2 * feather), 0, 1);
}

function drawDisc(png, cx, cy, radius, color) {
  const minX = Math.floor(cx - radius - 2);
  const maxX = Math.ceil(cx + radius + 2);
  const minY = Math.floor(cy - radius - 2);
  const maxY = Math.ceil(cy + radius + 2);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      blendPixel(png, x, y, color, smoothCoverage(distance, radius));
    }
  }
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / lengthSquared, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawLine(png, x1, y1, x2, y2, width, color) {
  const radius = width / 2;
  const minX = Math.floor(Math.min(x1, x2) - radius - 2);
  const maxX = Math.ceil(Math.max(x1, x2) + radius + 2);
  const minY = Math.floor(Math.min(y1, y2) - radius - 2);
  const maxY = Math.ceil(Math.max(y1, y2) + radius + 2);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = distanceToSegment(x + 0.5, y + 0.5, x1, y1, x2, y2);
      blendPixel(png, x, y, color, smoothCoverage(distance, radius));
    }
  }
  drawDisc(png, x1, y1, radius, color);
  drawDisc(png, x2, y2, radius, color);
}

function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

function angleBetween(angle, start, end) {
  const normalized = normalizeAngle(angle);
  const a = normalizeAngle(start);
  const b = normalizeAngle(end);
  return a <= b ? normalized >= a && normalized <= b : normalized >= a || normalized <= b;
}

function drawArc(png, cx, cy, radius, width, start, end, color) {
  const outer = radius + width / 2 + 2;
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y += 1) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const angle = Math.atan2(dy, dx);
      if (!angleBetween(angle, start, end)) continue;
      const distance = Math.abs(Math.hypot(dx, dy) - radius);
      blendPixel(png, x, y, color, smoothCoverage(distance, width / 2));
    }
  }
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function drawPolygon(png, points, color) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.floor(Math.min(...xs) - 2);
  const maxX = Math.ceil(Math.max(...xs) + 2);
  const minY = Math.floor(Math.min(...ys) - 2);
  const maxY = Math.ceil(Math.max(...ys) + 2);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let hits = 0;
      const samples = [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]];
      for (const [sx, sy] of samples) if (pointInPolygon(x + sx, y + sy, points)) hits += 1;
      blendPixel(png, x, y, color, hits / samples.length);
    }
  }
}

function leafPoints(cx, cy, scale) {
  const points = [];
  const count = 80;
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const x = -0.02 + 0.57 * Math.sin(Math.PI * t) * (0.72 + 0.28 * t);
    const y = 0.48 - 0.98 * t;
    points.push([cx + x * scale, cy + y * scale]);
  }
  for (let i = count; i >= 0; i -= 1) {
    const t = i / count;
    const x = -0.02 - 0.57 * Math.sin(Math.PI * t) * (1.02 - 0.20 * t);
    const y = 0.48 - 0.98 * t;
    points.push([cx + x * scale, cy + y * scale]);
  }
  return points;
}

function drawMark(png, options = {}) {
  const size = png.width;
  const color = options.monochrome ? [255, 255, 255, 255] : GREEN;
  const centerX = size * 0.5;
  const centerY = size * 0.5;
  const ringRadius = size * 0.295;
  const ringWidth = size * 0.068;

  if (!options.monochrome) {
    drawArc(png, centerX, centerY, ringRadius, ringWidth * 2.4, Math.PI * 0.18, Math.PI * 1.76, [50, 232, 117, 28]);
  }
  drawArc(png, centerX, centerY, ringRadius, ringWidth, Math.PI * 0.18, Math.PI * 1.76, color);

  const arrowTipAngle = Math.PI * 0.18;
  const tipX = centerX + Math.cos(arrowTipAngle) * ringRadius;
  const tipY = centerY + Math.sin(arrowTipAngle) * ringRadius;
  const tangentX = -Math.sin(arrowTipAngle);
  const tangentY = Math.cos(arrowTipAngle);
  const radialX = Math.cos(arrowTipAngle);
  const radialY = Math.sin(arrowTipAngle);
  const arrowLength = size * 0.145;
  const arrowHalf = size * 0.083;
  drawPolygon(png, [
    [tipX + tangentX * arrowLength, tipY + tangentY * arrowLength],
    [tipX - tangentX * arrowHalf + radialX * arrowHalf, tipY - tangentY * arrowHalf + radialY * arrowHalf],
    [tipX - tangentX * arrowHalf - radialX * arrowHalf, tipY - tangentY * arrowHalf - radialY * arrowHalf],
  ], color);

  const leafScale = size * 0.33;
  const leaf = leafPoints(centerX - size * 0.015, centerY + size * 0.02, leafScale);
  if (options.monochrome) {
    drawPolygon(png, leaf, color);
  } else {
    drawPolygon(png, leaf, GREEN);
    drawPolygon(png, leaf.map(([x, y]) => [centerX + (x - centerX) * 0.74, centerY + (y - centerY) * 0.74]), mix(GREEN_DARK, GREEN, 0.25));
  }

  const veinColor = options.monochrome ? TRANSPARENT : BG;
  if (!options.monochrome) {
    drawLine(png, centerX - size * 0.13, centerY + size * 0.17, centerX + size * 0.10, centerY - size * 0.18, size * 0.027, veinColor);
    drawLine(png, centerX - size * 0.015, centerY - size * 0.005, centerX + size * 0.12, centerY - size * 0.03, size * 0.019, veinColor);
    drawLine(png, centerX - size * 0.055, centerY + size * 0.065, centerX - size * 0.14, centerY + size * 0.015, size * 0.018, veinColor);
  }
}

function createIcon(size, background, markOptions) {
  const png = new PNG({ width: size, height: size, colorType: 6 });
  fill(png, background);
  drawMark(png, markOptions);
  return PNG.sync.write(png, { colorType: 6 });
}

function generateIcons() {
  const assetsDir = path.join(__dirname, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "icon.png"), createIcon(1024, BG, {}));
  fs.writeFileSync(path.join(assetsDir, "adaptive-icon.png"), createIcon(1024, TRANSPARENT, {}));
  fs.writeFileSync(path.join(assetsDir, "monochrome-icon.png"), createIcon(1024, TRANSPARENT, { monochrome: true }));
  fs.writeFileSync(path.join(assetsDir, "play-store-icon.png"), createIcon(512, BG, {}));
}

if (require.main === module) generateIcons();
module.exports = { generateIcons };
