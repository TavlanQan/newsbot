// config.js
const path = require('path');
require('dotenv').config();

// ВАЖНО: этот модуль не должен зависеть от utils/logger.js —
// логгер читает LOG_LEVEL из config, что создаст циклическую зависимость.
// Поэтому здесь никакого логирования, только парсинг и дефолты.

// Безопасный парсер положительных целых.
// Возвращает fallback, если значение пустое / NaN / <= 0.
function parseIntSafe(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Парсер comma-separated списка. Возвращает массив строк (без пустых).
function parseList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Интервал RSS в минутах, пригодный для cron-выражения `*/N * * * *`.
// Значения > 59 приводят к тому, что cron молча не срабатывает ни разу
// (node-cron не понимает */120), поэтому клампим в [1, 59].
function parseIntervalMinutes(value, fallback) {
  const n = parseIntSafe(value, fallback);
  return Math.min(59, Math.max(1, n));
}

// ADMIN_CHAT_ID — критичная переменная. Внутри бота она используется
// через parseInt, поэтому валидируем здесь и отдаём числом (или null).
// Строго числовая проверка: "123abc" не пройдёт, "123" пройдёт,
// " 123 " (с пробелами) тоже пройдёт — trim затем сравнение.
function parseAdminId(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

// Fail-fast: без токена бот неработоспособен, а ошибка внутри Telegraf
// будет невнятной ("Cannot read property 'token' of undefined" и т.п.).
// Бросаем сразу — PM2 покажет причину в logs.
if (!process.env.TELEGRAM_BOT_TOKEN) {
  throw new Error(
    'TELEGRAM_BOT_TOKEN is not set. Проверьте .env или переменные окружения.'
  );
}

// DB_PATH абсолютизируем: относительный путь резолвится от cwd, а PM2
// может запускать процесс с другим cwd (например, без --cwd). Это
// приводит к созданию «второй БД» в другом каталоге и очень дорого
// в отладке. Если задан абсолютный путь — path.resolve оставит как есть.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, 'news_bot.db');

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,

  DB_PATH,

  // Интервал RSS в минутах. Клампится в [1, 59] под cron.
  RSS_UPDATE_INTERVAL: parseIntervalMinutes(process.env.RSS_UPDATE_INTERVAL, 10),

  // ВНИМАНИЕ: возвращает МАССИВ (не строку). Используется только
  // для однократной миграции в system_feeds при старте бота (см. bot.js).
  // После миграции переменную можно удалить из .env — дальнейшее
  // управление через таблицу system_feeds и интерфейс бота.
  RSS_FEEDS: parseList(process.env.RSS_FEEDS),

  // Задержка между отправками, мс. Передаётся СЫРЫМ (строка или undefined):
  // парсинг, дефолт (1500) и клампинг [500, 5000] делает queue.js — там же
  // и warning'и при выходе за границы. Раньше clamp был здесь, и queue.js
  // получал уже усечённое значение → warning про >5000 не срабатывал никогда
  // (мёртвый код). Теперь единственный источник правды — queue.js.
  //
  // ВАЖНО: значение теперь НЕ число, а строка или undefined. Потребителей,
  // кроме queue.js, нет. Если понадобится где-то ещё — парсить явно.
  QUEUE_DELAY_MS: process.env.QUEUE_DELAY_MS,

  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  DEFAULT_TARGET_CHANNELS: parseList(process.env.DEFAULT_TARGET_CHANNELS),

  // Зарезервировано под health-сервер (см. Задачу 2). Пока не используется.
  HEALTH_PORT: parseIntSafe(process.env.HEALTH_PORT, 3000),

  // Число (или null). Все потребители уже вызывают parseInt — примут
  // и число, и строку. Валидация здесь отсекает мусор типа "abc".
  ADMIN_CHAT_ID: parseAdminId(process.env.ADMIN_CHAT_ID),

  YOUTUBE_RSS_SERVICE_URL:
    process.env.YOUTUBE_RSS_SERVICE_URL || 'http://localhost:5005/rss'
};