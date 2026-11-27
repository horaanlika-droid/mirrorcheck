// Private deal attachments. The JSON database holds metadata, never file contents.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'order-attachments');
const MAX_BYTES = 8 * 1024 * 1024;
class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const tooLarge = () => new InputError('Размер вложения не должен превышать 8 МБ.', 413);

function decodeUpload(upload) {
  if (upload == null) return null;
  const { name, data } = upload;
  if (typeof name !== 'string' || !name.trim() || typeof data !== 'string' || !data) {
    throw new InputError('Укажите имя и содержимое файла.');
  }
  if (data.length > 4 * Math.ceil(MAX_BYTES / 3)) throw tooLarge();
  if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new InputError('Не удалось прочитать содержимое файла.');
  return { name, bytes: Buffer.from(data, 'base64') };
}

function fileType(b) {
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return ['image/png', 'png'];
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  if (b.toString('latin1', 0, 5) === '%PDF-') return ['application/pdf', 'pdf'];
  throw new InputError('Можно прикрепить изображение JPG, PNG, WebP или документ PDF.');
}

// Only generated keys enter filesystem paths. Names are for display/download only.
function filePath(attachment) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(attachment.key)) throw new Error('Invalid attachment key');
  return path.join(dir, attachment.key);
}
function save({ name, bytes }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new InputError('Нельзя отправить пустой файл.');
  if (bytes.length > MAX_BYTES) throw tooLarge();
  const [type, ext] = fileType(bytes);
  const stem = path.posix.parse(path.win32.basename(name)).name.normalize('NFC')
    .replace(/[^\p{L}\p{N}_() -]/gu, '_').trim().slice(0, 100) || 'Вложение';
  const attachment = { key: randomUUID(), name: `${stem}.${ext}`, type, size: bytes.length };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath(attachment), bytes, { flag: 'wx', mode: 0o600 });
  return attachment;
}
function remove(attachment) {
  if (attachment) fs.rmSync(filePath(attachment), { force: true });
}

module.exports = { MAX_BYTES, InputError, tooLarge, decodeUpload, save, filePath, remove };
