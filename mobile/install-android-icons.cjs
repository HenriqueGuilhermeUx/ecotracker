const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");
const { generateIcons } = require("./generate-icons.cjs");

const ROOT = __dirname;
const ANDROID_MAIN = path.join(ROOT, "android", "app", "src", "main");
const RES = path.join(ANDROID_MAIN, "res");
const DARK = [6, 16, 12, 255];

const DENSITIES = {
  mdpi: { legacy: 48, adaptive: 108 },
  hdpi: { legacy: 72, adaptive: 162 },
  xhdpi: { legacy: 96, adaptive: 216 },
  xxhdpi: { legacy: 144, adaptive: 324 },
  xxxhdpi: { legacy: 192, adaptive: 432 },
};

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function writePng(file, png) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 6 }));
}

function createCanvas(width, height, color = [0, 0, 0, 0]) {
  const png = new PNG({ width, height, colorType: 6 });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      png.data[index] = color[0];
      png.data[index + 1] = color[1];
      png.data[index + 2] = color[2];
      png.data[index + 3] = color[3];
    }
  }
  return png;
}

function sampleBilinear(source, x, y, channel) {
  const x0 = Math.max(0, Math.min(source.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(source.height - 1, Math.floor(y)));
  const x1 = Math.max(0, Math.min(source.width - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(source.height - 1, y0 + 1));
  const tx = x - Math.floor(x);
  const ty = y - Math.floor(y);
  const at = (px, py) => source.data[(py * source.width + px) * 4 + channel];
  const top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return Math.round(top * (1 - ty) + bottom * ty);
}

function resize(source, width, height) {
  const target = createCanvas(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = ((x + 0.5) * source.width) / width - 0.5;
      const sourceY = ((y + 0.5) * source.height) / height - 0.5;
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        target.data[index + channel] = sampleBilinear(source, sourceX, sourceY, channel);
      }
    }
  }
  return target;
}

function alphaComposite(destination, source, offsetX, offsetY) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const dx = x + offsetX;
      const dy = y + offsetY;
      if (dx < 0 || dy < 0 || dx >= destination.width || dy >= destination.height) continue;
      const si = (y * source.width + x) * 4;
      const di = (dy * destination.width + dx) * 4;
      const sa = source.data[si + 3] / 255;
      const da = destination.data[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        const sc = source.data[si + channel] / 255;
        const dc = destination.data[di + channel] / 255;
        destination.data[di + channel] = Math.round(((sc * sa) + (dc * da * (1 - sa))) / oa * 255);
      }
      destination.data[di + 3] = Math.round(oa * 255);
    }
  }
}

function padded(source, targetSize, scale, background) {
  const target = createCanvas(targetSize, targetSize, background);
  const renderedSize = Math.max(1, Math.round(targetSize * scale));
  const rendered = resize(source, renderedSize, renderedSize);
  const offset = Math.floor((targetSize - renderedSize) / 2);
  alphaComposite(target, rendered, offset, offset);
  return target;
}

function removeOldLauncherResources(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory)) {
    if (/^ic_launcher(?:_round|_foreground|_monochrome)?\.(png|webp|xml)$/i.test(entry)) {
      fs.rmSync(path.join(directory, entry), { force: true });
    }
  }
}

function verifyVisible(png, label) {
  let opaque = 0;
  let green = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    if (png.data[index + 3] > 16) opaque += 1;
    if (png.data[index + 1] > png.data[index] * 1.4 && png.data[index + 1] > png.data[index + 2] * 1.2) green += 1;
  }
  const pixels = png.width * png.height;
  if (opaque < pixels * 0.08 || green < pixels * 0.02) {
    throw new Error(`${label} parece vazio ou sem a marca EcoTracker.`);
  }
}

function writeAdaptiveXml(directory, includeMonochrome) {
  fs.mkdirSync(directory, { recursive: true });
  const monochrome = includeMonochrome ? '\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />' : "";
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ecotracker_icon_background" />\n    <foreground android:drawable="@mipmap/ic_launcher_foreground" />${monochrome}\n</adaptive-icon>\n`;
  fs.writeFileSync(path.join(directory, "ic_launcher.xml"), xml);
  fs.writeFileSync(path.join(directory, "ic_launcher_round.xml"), xml);
}

function updateManifest() {
  const manifestPath = path.join(ANDROID_MAIN, "AndroidManifest.xml");
  let manifest = fs.readFileSync(manifestPath, "utf8");
  if (/android:icon="[^"]+"/.test(manifest)) {
    manifest = manifest.replace(/android:icon="[^"]+"/, 'android:icon="@mipmap/ic_launcher"');
  } else {
    manifest = manifest.replace(/<application\b/, '<application android:icon="@mipmap/ic_launcher"');
  }
  if (/android:roundIcon="[^"]+"/.test(manifest)) {
    manifest = manifest.replace(/android:roundIcon="[^"]+"/, 'android:roundIcon="@mipmap/ic_launcher_round"');
  } else {
    manifest = manifest.replace(/<application\b/, '<application android:roundIcon="@mipmap/ic_launcher_round"');
  }
  fs.writeFileSync(manifestPath, manifest);
}

function installAndroidIcons() {
  if (!fs.existsSync(ANDROID_MAIN)) {
    throw new Error("Projeto Android não encontrado. Execute expo prebuild antes de instalar os ícones.");
  }

  generateIcons();
  const icon = readPng(path.join(ROOT, "assets", "icon.png"));
  const adaptive = readPng(path.join(ROOT, "assets", "adaptive-icon.png"));
  const monochrome = readPng(path.join(ROOT, "assets", "monochrome-icon.png"));
  verifyVisible(icon, "Ícone principal");
  verifyVisible(adaptive, "Ícone adaptativo");
  verifyVisible(monochrome, "Ícone monocromático");

  for (const [density, sizes] of Object.entries(DENSITIES)) {
    const directory = path.join(RES, `mipmap-${density}`);
    fs.mkdirSync(directory, { recursive: true });
    removeOldLauncherResources(directory);

    // Ícone legado completo, com fundo próprio e margem segura.
    const legacy = padded(icon, sizes.legacy, 0.94, DARK);
    writePng(path.join(directory, "ic_launcher.png"), legacy);
    writePng(path.join(directory, "ic_launcher_round.png"), legacy);

    // Foreground adaptativo: marca menor dentro da zona segura para não ser cortada.
    writePng(path.join(directory, "ic_launcher_foreground.png"), padded(adaptive, sizes.adaptive, 0.66, [0, 0, 0, 0]));
    writePng(path.join(directory, "ic_launcher_monochrome.png"), padded(monochrome, sizes.adaptive, 0.66, [0, 0, 0, 0]));
  }

  const valuesDirectory = path.join(RES, "values");
  fs.mkdirSync(valuesDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(valuesDirectory, "ecotracker_icon_colors.xml"),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ecotracker_icon_background">#06100C</color>\n</resources>\n',
  );

  const anyDpi26 = path.join(RES, "mipmap-anydpi-v26");
  const anyDpi33 = path.join(RES, "mipmap-anydpi-v33");
  removeOldLauncherResources(anyDpi26);
  removeOldLauncherResources(anyDpi33);
  writeAdaptiveXml(anyDpi26, false);
  writeAdaptiveXml(anyDpi33, true);
  updateManifest();

  console.log("EcoTracker Android launcher icons installed in all densities.");
}

if (require.main === module) installAndroidIcons();
module.exports = { installAndroidIcons };
