// utils/logger.js
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const config = require('../config');

// Папка для логов (создаётся автоматически при первой записи)
const logDir = path.join(__dirname, '../logs');

// Единый формат: timestamp, level, [context] message + stack (если есть).
// stack рендерится отдельной строкой — так ошибки в errors-*.log
// содержат полный стек вызовов, а не только первую строку.
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, context, stack }) => {
    const ctx = context ? ` [${context}]` : '';
    let line = `[${timestamp}] [${level.toUpperCase()}]${ctx} ${message}`;
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

// errors-*.log: только ошибки, хранится 30 дней
const errorTransport = new DailyRotateFile({
  ...rotateOpts,
  filename: path.join(logDir, 'errors-%DATE%.log'),
  level: 'error',
  maxFiles: '30d'
});

// bot-*.log: всё от основного логгера (info/warn/error), 14 дней
const botTransport = new DailyRotateFile({
  ...rotateOpts,
  filename: path.join(logDir, 'bot-%DATE%.log'),
  maxFiles: '14d'
});

// rss-*.log: события RSS-парсинга, 14 дней
const rssTransport = new DailyRotateFile({
  ...rotateOpts,
  filename: path.join(logDir, 'rss-%DATE%.log'),
  maxFiles: '14d'
});

// db-*.log: события базы данных (очистки, миграции), 14 дней
const dbTransport = new DailyRotateFile({
  ...rotateOpts,
  filename: path.join(logDir, 'db-%DATE%.log'),
  maxFiles: '14d'
});

// Консоль — для pm2 logs newsbot в реальном времени
const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  )
});

// Фабрика логгеров.
// defaultMeta.context задаёт «модуль» — он попадёт в [BOT], [RSS], [DB].
// ВАЖНО: вызывающий код НЕ должен передавать {context: '...'} в .log() —
// это перебьёт defaultMeta. Контекст конкретного вызова передавайте префиксом
// в message (так делает errorHandler.js).
function createLogger(context, primaryTransport) {
  return winston.createLogger({
    level: config.LOG_LEVEL || 'info',
    format: logFormat,
    defaultMeta: { context },
    transports: [
      primaryTransport,
      errorTransport,   // дублируем ошибки в errors-*.log
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