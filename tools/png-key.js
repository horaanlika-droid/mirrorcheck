/* PRICELEX · подготовка объёмных иконок: чёрный фон → альфа, кроп и даунскейл.
   Генератор отдаёт 3D-иконки на чёрном; интерфейсу нужны PNG с прозрачностью
   и скромные размеры. Альфа берётся flooded-маской фона от краёв кадра, поэтому
   тёмные металлы внутри силуэта не становятся полупрозрачными, а кромка
   получает мягкое перо по яркости. Запуск:
     node tools/png-key.js <src.png> <dst.png> <size> */
'use strict';

const fs = require('fs');
const zlib = require('zlib');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

/* ---------- декодер PNG (8 bit, RGB/RGBA, без interlace) ---------- */
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('не PNG: ' + file);
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace !== 0 || (ihdr.color !== 2 && ihdr.color !== 6)) {
    throw new Error(`unsupported png (${file}): depth=${ihdr && ihdr.depth} color=${ihdr && ihdr.color}`);
  }
  const bpp = ihdr.color === 6 ? 4 : 3;
  const stride = ihdr.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(ihdr.width * ihdr.height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    for (let x = 0; x < ihdr.width; x += 1) {
      const si = x * bpp;
      const di = (y * ihdr.width + x) * 4;
      px[di] = cur[si];
      px[di + 1] = cur[si + 1];
      px[di + 2] = cur[si + 2];
      px[di + 3] = bpp === 4 ? cur[si + 3] : 255;
    }
    prev = cur;
  }
  return { width: ihdr.width, height: ihdr.height, px };
}

/* ---------- чёрный фон → альфа ---------- */
function keyBlack(img, { bgMax = 52, feather = 26 } = {}) {
  const { width, height, px } = img;
  const maxOf = (i) => Math.max(px[i], px[i + 1], px[i + 2]);
  const bg = new Uint8Array(width * height); // 1 — фон
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const push = (x, y) => {
    const i = y * width + x;
    if (bg[i]) return;
    if (maxOf(i * 4) >= bgMax) return;
    bg[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x += 1) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y += 1) { push(0, y); push(width - 1, y); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i / width) | 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  // Замкнутые чёрные полости (дырка кольца, просветы между стрелками) тоже фон:
  // крупная связная область почти чёрных пикселей не может быть тенью металла.
  const holeMin = Math.max(512, Math.round(width * height * 0.005));
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || bg[start] || maxOf(start * 4) >= bgMax) continue;
    const comp = [start];
    seen[start] = 1;
    for (let q = 0; q < comp.length; q += 1) {
      const i = comp[q];
      const x = i % width;
      const y = (i / width) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
      for (const j of nb) {
        if (j < 0 || seen[j] || bg[j] || maxOf(j * 4) >= bgMax) continue;
        seen[j] = 1;
        comp.push(j);
      }
    }
    if (comp.length >= holeMin) for (const i of comp) bg[i] = 1;
  }
  // перо: пиксель фона рядом с силуэтом получает частичную альфу по яркости
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!bg[i]) { alpha[i] = px[i * 4 + 3]; continue; }
      const near =
        (x > 0 && !bg[i - 1]) || (x < width - 1 && !bg[i + 1]) ||
        (y > 0 && !bg[i - width]) || (y < height - 1 && !bg[i + width]);
      if (!near) continue;
      const m = maxOf(i * 4);
      alpha[i] = Math.max(0, Math.min(255, Math.round((m / feather) * 255)));
    }
  }
  for (let i = 0; i < width * height; i += 1) px[i * 4 + 3] = alpha[i];
  return img;
}

/* ---------- кроп по альфе + даунскейл усреднением ---------- */
function cropAlpha(img) {
  const { width, height, px } = img;
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (px[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return img;
  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const s = ((y + y0) * width + (x + x0)) * 4;
      const d = (y * w + x) * 4;
      out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
    }
  }
  return { width: w, height: h, px: out };
}

function resize(img, size) {
  const { width, height, px } = img;
  // вписываем в квадрат size×size с полями
  const side = Math.max(width, height);
  if (side <= size) return img;
  const tw = Math.max(1, Math.round((width * size) / side));
  const th = Math.max(1, Math.round((height * size) / side));
  const out = Buffer.alloc(tw * th * 4);
  for (let ty = 0; ty < th; ty += 1) {
    const sy0 = (ty * height) / th;
    const sy1 = ((ty + 1) * height) / th;
    for (let tx = 0; tx < tw; tx += 1) {
      const sx0 = (tx * width) / tw;
      const sx1 = ((tx + 1) * width) / tw;
      let r = 0; let g = 0; let b = 0; let a = 0; let w = 0;
      const ya = Math.floor(sy0); const yb = Math.min(height - 1, Math.ceil(sy1));
      const xa = Math.floor(sx0); const xb = Math.min(width - 1, Math.ceil(sx1));
      for (let sy = ya; sy <= yb; sy += 1) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        for (let sx = xa; sx <= xb; sx += 1) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          const s = (sy * width + sx) * 4;
          const wa = wx * wy;
          const al = px[s + 3] / 255;
          r += px[s] * al * wa; g += px[s + 1] * al * wa; b += px[s + 2] * al * wa;
          a += px[s + 3] * wa;
          w += wa;
        }
      }
      const d = (ty * tw + tx) * 4;
      const aa = w ? a / w : 0;
      const af = aa / 255;
      out[d] = af > 0 ? Math.min(255, Math.round(r / w / af)) : 0;
      out[d + 1] = af > 0 ? Math.min(255, Math.round(g / w / af)) : 0;
      out[d + 2] = af > 0 ? Math.min(255, Math.round(b / w / af)) : 0;
      out[d + 3] = Math.round(aa);
    }
  }
  return { width: tw, height: th, px: out };
}

/* ---------- унификация оттенка: градационная карта золота ---------- */
// Генерация даёт каждый объект со своим нюансом металла (розовее, меднее,
// зеленоватее). Чтобы набор не различался по оттенкам, цвет каждого
// непрозрачного пикселя заменяется точкой единой рампы нового логотипа
// (IMG_1237): тень → тёплое золото → блик по его яркости — объём и блики
// сохраняются, оттенок становится общим у всех иконок и знака.
const RAMP = [
  [0.0, [0x2e, 0x1c, 0x0c]],
  [0.35, [0x6b, 0x45, 0x1f]],
  [0.62, [0xa9, 0x7b, 0x3c]],
  [0.82, [0xd3, 0xa9, 0x61]],
  [1.0, [0xf7, 0xe7, 0xc3]],
];
function rampColor(t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < RAMP.length; i += 1) {
    if (x <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1];
      const [t1, c1] = RAMP[i];
      const k = (x - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return RAMP[RAMP.length - 1][1];
}
function gradeBronze(img) {
  const { width, height, px } = img;
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (px[o + 3] === 0) continue;
    const r = px[o] / 255;
    const g = px[o + 1] / 255;
    const b = px[o + 2] / 255;
    // perceptual luminance + контрастная S-кривая, чтобы металл держал объём
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let t = Math.pow(lum, 0.92);
    t = Math.min(1, Math.max(0, (t - 0.06) / 0.88));
    t = t * t * (3 - 2 * t);
    const [nr, ng, nb] = rampColor(t);
    px[o] = nr; px[o + 1] = ng; px[o + 2] = nb;
  }
  return img;
}

/* ---------- кодировщик PNG (RGBA, filter 0) ---------- */
function encodePng(img, file) {
  const { width, height, px } = img;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    px.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return png.length;
}

function convert(src, dst, size) {
  let img = decodePng(src);
  img = keyBlack(img);
  img = cropAlpha(img);
  img = resize(img, size);
  const bytes = encodePng(img, dst);
  console.log(`${src} → ${dst} ${img.width}×${img.height} ${(bytes / 1024).toFixed(0)} KB`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'grade') {
    // унификация оттенка готовых ассетов: node tools/png-key.js grade a.png b.png …
    for (const file of argv.slice(1)) {
      const img = gradeBronze(decodePng(file));
      const bytes = encodePng(img, file);
      console.log(`grade ${file} ${img.width}×${img.height} ${(bytes / 1024).toFixed(0)} KB`);
    }
  } else {
    const [src, dst, size] = argv;
    convert(src, dst, Number(size) || 96);
  }
}

module.exports = { decodePng, encodePng, keyBlack, cropAlpha, resize, convert, gradeBronze, rampColor };
