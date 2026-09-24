// Хранение чеков PDF от клиентов: data/receipts/order-<id>.pdf
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MAX_BYTES = 8 * 1024 * 1024;

const dir = () => path.join(DATA_DIR, 'receipts');
const filePath = (orderId) => path.join(dir(), `order-${Number(orderId)}.pdf`);

function save(orderId, buf) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(filePath(orderId), buf);
}

const exists = (orderId) => {
  try {
    return fs.statSync(filePath(orderId)).isFile();
  } catch {
    return false;
  }
};

module.exports = { filePath, save, exists, MAX_BYTES };
