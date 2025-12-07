const Parser = require('rss-parser');
const db = require('./db');
const config = require('./config');
const fs = require('fs');
const path = require('path');

// Улучшенная система логирования
let logStream;

function createLogStream() {
  if (logStream) {
    try {
      logStream.end();
    } catch (e) {
      console.error('Ошибка закрытия logStream в NewsService:', e.message);
    }
  }
  logStream = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'a' });
  return logStream;
}

function log(msg) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  const logMsg = `[${timestamp}] [NewsService] ${msg}\n`;
  
  if (!logStream || logStream.destroyed) {
    logStream = createLogStream();
  }
  
  try {
    logStream.write(logMsg);
    console.log(logMsg);
  } catch (error) {
    console.error('Ошибка записи в лог NewsService:', error.message);
  }
}

class NewsService {
  constructor() {
    this.parser = new Parser({
      timeout: 15000, // Увеличим таймаут для медленных RSS-лент
      requestOptions: {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)'
        }
      }
    });
    this.monitoringInterval = null;
    this.isMonitoring = false;
    this.sendFunction = null;
    this.currentProcessing = null; // Для отслеживания текущей обработки
    this.keywordsCache = []; // Кэш ключевых слов
    this.lastKeywordsUpdate = 0; // Когда обновляли
    this.CACHE_TIME = 5 * 60 * 1000; // 5 минут в миллисекундах
  }

  async getKeywordsCached() {
    const now = Date.now();
    
    // Если кэш устарел (прошло больше 5 минут) или пустой
    if (now - this.lastKeywordsUpdate > this.CACHE_TIME || this.keywordsCache.length === 0) {
      log('🔄 Обновляю кэш ключевых слов');
      this.keywordsCache = await db.getKeywords();
      this.lastKeywordsUpdate = now;
    }
    
    return this.keywordsCache;
  }

  async initialize() {
    log('📰 Инициализация сервиса новостей...');
    // Проверяем доступность RSS-лент при инициализации
    await this.validateFeeds();
  }

async validateFeeds() {
  log('🔍 Проверка доступности RSS-лент...');
  let workingFeeds = 0;
  let totalFeeds = config.RSS_FEEDS.length;
  
  // Проверяем ВСЕ RSS-ленты, но с ограничением времени
  for (let i = 0; i < totalFeeds; i++) {
    const feedUrl = config.RSS_FEEDS[i];
    try {
      // Ограничиваем время проверки 10 секундами на каждый фид
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Таймаут проверки')), 10000)
      );
      
      const checkPromise = this.parser.parseURL(feedUrl);
      await Promise.race([checkPromise, timeoutPromise]);
      
      workingFeeds++;
      log(`✅ RSS-лента доступна: ${feedUrl} (${i + 1}/${totalFeeds})`);
    } catch (error) {
      log(`⚠️ RSS-лента недоступна: ${feedUrl} - ${error.message} (${i + 1}/${totalFeeds})`);
    }
    
    // Небольшая задержка между проверками чтобы не перегружать сервера
    if (i < totalFeeds - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  log(`📊 Статистика RSS-лент: ${workingFeeds}/${totalFeeds} доступно`);
  
  if (workingFeeds === 0) {
    log('❌ ВНИМАНИЕ: Ни одна RSS-лента не доступна! Проверьте настройки.');
  } else if (workingFeeds < totalFeeds / 2) {
    log('⚠️ ВНИМАНИЕ: Менее половины RSS-лент доступно!');
  }
}

  setSendFunction(sendFunction) {
    this.sendFunction = sendFunction;
    log('✅ Функция отправки установлена в NewsService');
  }

  async startMonitoring() {
    if (this.isMonitoring) {
      log('⚠️ Мониторинг уже запущен');
      return;
    }

    this.isMonitoring = true;
    log('🔄 Запуск мониторинга RSS-лент...');

    // Немедленная проверка при запуске
    try {
      await this.checkAllFeeds();
    } catch (error) {
      log(`❌ Ошибка при начальной проверке RSS: ${error.message}`);
    }

    // Периодическая проверка каждые 10 минут
    this.monitoringInterval = setInterval(() => {
      this.checkAllFeeds().catch(error => {
        log(`❌ Ошибка в периодической проверке RSS: ${error.message}`);
      });
    }, 10 * 60 * 1000);

    log('✅ Мониторинг RSS-лент запущен');
  }

  async stopMonitoring() {
    this.isMonitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    // Если есть текущая обработка, даем ей завершиться
    if (this.currentProcessing) {
      log('⏳ Завершаем текущую обработку RSS...');
      try {
        await this.currentProcessing;
      } catch (error) {
        log(`⚠️ Ошибка при завершении обработки: ${error.message}`);
      }
    }
    
    log('⏹️ Мониторинг RSS-лент остановлен');
  }

  async checkAllFeeds() {
    if (!this.isMonitoring) {
      log('⚠️ Мониторинг не активен, пропускаем проверку');
      return;
    }

    // Защита от параллельных запусков
    if (this.currentProcessing) {
      log('⚠️ Проверка уже выполняется, пропускаем');
      return;
    }

    this.currentProcessing = this._checkAllFeeds();
    try {
      await this.currentProcessing;
    } finally {
      this.currentProcessing = null;
    }
  }

  async _checkAllFeeds() {
    log('🔍 Начинаем проверку всех RSS-лент...');
    let processedFeeds = 0;
    let errorFeeds = 0;
    
    for (let i = 0; i < config.RSS_FEEDS.length; i++) {
      const feedUrl = config.RSS_FEEDS[i];
      try {
        await this.processFeed(feedUrl);
        processedFeeds++;
        
        // УМНАЯ ЗАДЕРЖКА: первые 5 лент быстро, остальные медленнее
        const delay = i < 5 ? 500 : 1000; // 0.5 секунды для первых 5, 1 секунда для остальных
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (error) {
        errorFeeds++;
        log(`❌ Ошибка обработки RSS-ленты ${feedUrl}: ${error.message}`);
        
        // При ошибке ждем меньше
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    log(`✅ Проверка RSS завершена. Успешно: ${processedFeeds}, с ошибками: ${errorFeeds}`);
  }

  async processFeed(feedUrl) {
    try {
      const feed = await this.parser.parseURL(feedUrl);
      log(`📋 RSS: ${feed.title || feedUrl} - найдено ${feed.items?.length || 0} новостей`);

      if (!feed.items || feed.items.length === 0) {
        log(`⚠️ В RSS-ленте ${feedUrl} нет новостей`);
        return;
      }

      const keywords = await this.getKeywordsCached();
      
      // Обрабатываем только последние 10 новостей чтобы не перегружать
      const MAX_ITEMS_PER_FEED = 10;
      const recentItems = feed.items.slice(0, MAX_ITEMS_PER_FEED);

      // Добавляем предупреждение если новостей слишком много
      if (feed.items && feed.items.length > 50) {
        log(`⚠️ ВНИМАНИЕ: ${feedUrl} вернул ${feed.items.length} новостей! Обрабатываю только ${MAX_ITEMS_PER_FEED}`);
      }

      let processedItems = 0;
      
      for (const item of recentItems) {
        try {
          // Проверяем, не отправляли ли мы уже эту новость
          const newsId = item.guid || item.link;
          if (!newsId) {
            log(`⚠️ Пропущена новость без ID: ${item.title?.substring(0, 50)}`);
            continue;
          }

          const isSent = await db.isNewsSent(newsId);
          if (isSent) continue;

          // Проверяем соответствие ключевым словам
          if (this.matchesKeywords(item, keywords)) {
            await this.processNewsItem(item, feed.title || feedUrl);
            processedItems++;
          }
        } catch (itemError) {
          log(`❌ Ошибка обработки новости из ${feedUrl}: ${itemError.message}`);
        }
      }
      
      if (processedItems > 0) {
        log(`✅ Обработано ${processedItems} новостей из ${feedUrl}`);
      }
    } catch (error) {
      log(`❌ Критическая ошибка парсинга ${feedUrl}: ${error.message}`);
      // Не прерываем выполнение для других фидов
      throw error; // Пробрасываем для подсчета ошибок
    }
  }

  matchesKeywords(item, keywords) {
    if (keywords.length === 0) return true;

    const content = `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''} ${item.description || ''}`.toLowerCase();
    
    return keywords.some(keyword => 
      content.includes(keyword.toLowerCase())
    );
  }

  async processNewsItem(item, feedTitle) {
    const newsId = item.guid || item.link;
    
    // Проверяем размер новости
    if (item.content && item.content.length > 10000) {
      log(`📏 Новость слишком большая (${item.content.length} символов), обрезаю`);
      item.content = item.content.substring(0, 10000) + '...';
    }

    try {
      // Двойная проверка перед отправкой
      const isSent = await db.isNewsSent(newsId);
      if (isSent) {
        log(`⚠️ Новость уже была отправлена ранее: ${item.title?.substring(0, 100) || 'без названия'}`);
        return;
      }

      const message = this.formatNewsMessage(item, feedTitle);
      
      if (this.sendFunction) {
        const sent = await this.sendFunction(message);
        if (sent) {
          // Помечаем как отправленную только если успешно отправлено
          await db.addSentNews(newsId, item.title || 'Без названия', item.link || '');
          log(`✅ Отправлена новость: ${item.title?.substring(0, 100) || 'без названия'}...`);
        } else {
          log(`⚠️ Не удалось отправить новость: ${item.title?.substring(0, 100) || 'без названия'}`);
        }
      } else {
        log('❌ Функция отправки не установлена, новость не отправлена');
      }
    } catch (error) {
      log(`❌ Ошибка обработки новости "${item.title || 'без названия'}": ${error.message}`);
    }
  }

  formatNewsMessage(item, feedTitle) {
    const title = item.title || 'Без названия';
    let content = item.contentSnippet || item.description || item.content || '';
    
    // 1. Удаляем ВСЕ HTML теги
    content = content.replace(/<[^>]*>/g, '').trim();
    
    // 2. Обрезаем слишком длинный контент (увеличиваем лимит)
    const MAX_CONTENT_LENGTH = 500;
    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.substring(0, MAX_CONTENT_LENGTH) + '...';
    }
    
    // 3. Если контент пустой, используем заголовок
    if (!content) {
      content = title;
    }
    
    const link = item.link || '';
    const source = feedTitle || 'Неизвестный источник';
    
    // 4. Экранируем ВЕСЬ текст для безопасности
    const safeTitle = this.escapeHtml(title);
    const safeContent = this.escapeHtml(content);
    const safeSource = this.escapeHtml(source);
    
    // 5. Формируем ссылку безопасно
    let safeLink = '';
    if (link) {
      // Простая проверка что ссылка начинается с http
      if (link.startsWith('http://') || link.startsWith('https://')) {
        safeLink = `🔗 <a href="${link}">Читать полностью</a>`;
      } else {
        // Если ссылка странная, показываем как текст
        safeLink = `🔗 Ссылка: ${this.escapeHtml(link)}`;
      }
    }
    
    // 6. Формируем финальное сообщение
    return `
📰 <b>${safeTitle}</b>

${safeContent}

${safeLink}
📋 Источник: ${safeSource}
    `.trim();
  }

  escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/\$/g, '&#36;')     // знак доллара
      .replace(/`/g, '&#96;')      // обратная кавычка
      .replace(/\|/g, '&#124;');   // вертикальная черта
  }

  // Метод для ручной проверки (может быть полезен для отладки)
  async manualCheck() {
    log('🔧 Запуск ручной проверки RSS...');
    await this.checkAllFeeds();
  }
}

module.exports = new NewsService();