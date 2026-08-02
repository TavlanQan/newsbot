// utils/logger.js
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Папка для логов (создаётся автоматически при первой записи)
const logDir = path.join(__dirname, '../logs');

// Общий формат для всех логов
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, context }) => {
    return `[${timestamp}] [${level.toUpperCase()}]${context ? ` [${context}]` : ''} ${message}`;
  })
);

// Транспорт для ошибок (уровень error и выше)
const errorTransport = new DailyRotateFile({
  filename: path.join(logDir, 'errors-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxSize: '20m',
  maxFiles: '30d', // хранить 30 дней
});

// Транспорт для общего лога бота (все уровни, кроме error – дублируются в errors.log)
const botTransport = new DailyRotateFile({
  filename: path.join(logDir, 'bot-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
});

// Транспорт для RSS
const rssTransport = new DailyRotateFile({
  filename: path.join(logDir, 'rss-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
});

// Транспорт для БД
const dbTransport = new DailyRotateFile({
  filename: path.join(logDir, 'db-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
});

// Базовый логгер (используется для создания дочерних)
const baseLogger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    // Можно добавить вывод в консоль для разработки (опционально)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Добавляем транспорты для ошибок и бота
baseLogger.add(errorTransport);
baseLogger.add(botTransport);

// Создаём отдельные логгеры с разными контекстами
// Они будут использовать те же транспорты, но с разными префиксами
const botLogger = baseLogger.child({ context: 'BOT' });
const rssLogger = baseLogger.child({ context: 'RSS' });
const dbLogger = baseLogger.child({ context: 'DB' });

// Для ошибок можно использовать отдельный экземпляр, который пишет только в errorTransport,
// но мы будем использовать общий логгер с уровнем error – он автоматически попадёт в errors.log

module.exports = {
  botLogger,
  rssLogger,
  dbLogger,
  // Можно экспортировать и базовый, если понадобится
  baseLogger
};