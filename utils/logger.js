// utils/logger.js
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const config = require('../config');

// Папка для логов (создаётся автоматически при первой записи)
const logDir = path.join(__dirname, '../logs');
const logLevel = config.LOG_LEVEL || 'info';

// Маркер инициализации в PM2 stdout — сразу видно, что logger загрузился
// и какой уровень/директория используются. Если этого лога нет в pm2 logs —
// значит require('./utils/logger') нигде не выполнился.
console.log(`[logger.js] initialized: level=${logLevel}, dir=${logDir}`);

// ---------------------------------------------------------------------------
// Извлечение stack из Error-объектов.
// Без этого формата logger.error(new Error('x')) логирует только "Error: x",
// а стек теряется. С ним в info появляется поле stack, которое рендерится
// отдельной строкой ниже — и в errors-*.log попадает полный стек вызовов.
// ---------------------------------------------------------------------------
const errorFormat = winston.format.errors({ stack: true });

// Безопасное приведение message к строке. message может быть Error,
// строкой, объектом или undefined — printf должен получить строку.
function stringifyMessage(message) {
  if (message === null || message === undefined) return '';
  if (message instanceof Error) return message.message;
  if (typeof message === 'string') return message;
  try {
    return JSON.stringify(message);
  } catch (_) {
    return String(message);
  }
}

// Единый формат для всех файловых транспортов.
// Пример: [2026-09-19 12:34:56] [INFO] [BOT] Текст
// Если есть stack — рендерится отдельной строкой после сообщения.
const logFormat = winston.format.combine(
  errorFormat,
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, context, stack }) => {
    const ctx = context ? ` [${context}]` : '';
    let line = `[${timestamp}] [${level.toUpperCase()}]${ctx} ${stringifyMessage(message)}`;
    if (stack) {
      line += `\n${stack}`;
    }
    return line;
  })
);

// Формат для консоли: тот же смысл, но с цветным уровнем.
// Это то, что видно в `pm2 logs newsbot`.
const consoleFormat = winston.format.combine(
  errorFormat,
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: false, level: true }),
  winston.format.printf(({ timestamp, level, message, context, stack }) => {
    const ctx = context ? ` [${context}]` : '';
    let line = `[${timestamp}] ${level}${ctx} ${stringifyMessage(message)}`;
    if (stack) {
      line += `\n${stack}`;
    }
    return line;
  })
);

// Общие опции для всех ротационных транспортов
const rotateOpts = {
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  zippedArchive: false
};

// errors-*.log: только ошибки (и выше), 30 дней.
// Явный format: logFormat — не полагаемся на наследование от логгера.
const errorTransport = new DailyRotateFile({
  ...rotateOpts,
  filename: path.join(logDir, 'errors-%DATE%.log'),
  level: 'error',
  maxFiles: '30d',
  format: logFormat
});

// bot-*.log: события основного бота (bootstrap, cron, handlers), 14 дней
const botTransport = new DailyRotateFile({
  ...rotateOpts,
  filename: path.join(logDir, 'bot-%DATE%.log'),
  maxFiles: '14d',
  format: logFormat
});

// rss-*.log: события RSS-парсинга (newsService), 14 дней
const rssTransport = new DailyRotateFile({
  ...rotateOpts,
  filename: path.join(logDir, 'rss-%DATE%.log'),
  maxFiles: '14d',
  format: logFormat
});

// db-*.log: события базы данных (очистки, миграции), 14 дней
const dbTransport = new DailyRotateFile({
  ...rotateOpts,
  filename: path.join(logDir, 'db-%DATE%.log'),
  maxFiles: '14d',
  format: logFormat
});

// Консоль — для `pm2 logs newsbot` в реальном времени.
// Используем тот же формат, что и в файлах, но с цветом.
const consoleTransport = new winston.transports.Console({
  format: consoleFormat
});

// Фабрика логгеров.
//
// defaultMeta.context задаёт «модуль» — он попадёт в [BOT], [RSS], [DB].
// ВАЖНО: вызывающий код НЕ должен передавать {context: '...'} в .log() —
// это перебьёт defaultMeta. Контекст конкретного вызова передавайте
// префиксом в message (так делает errorHandler.js).
//
// Все логгеры дополнительно пишут в:
//  - errors-*.log — только error (общий для всех модулей)
//  - console      — всё, что проходит по уровню
//
// exitOnError: false — при ошибке транспорта winston не роняет процесс.
// Для долгоживущего бота это правильнее, чем дефолтный exitOnError: true.
function createLogger(context, primaryTransport) {
  return winston.createLogger({
    level: logLevel,
    defaultMeta: { context },
    exitOnError: false,
    transports: [
      primaryTransport,
      errorTransport,
      consoleTransport
    ]
  });
}

const botLogger = createLogger('BOT', botTransport);
const rssLogger = createLogger('RSS', rssTransport);
const dbLogger  = createLogger('DB',  dbTransport);

module.exports = {
  botLogger,
  rssLogger,
  dbLogger
};