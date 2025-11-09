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
  }

  async initialize() {
    log('📰 Инициализация сервиса новостей...');
    // Проверяем доступность RSS-лент при инициализации
    await this.validateFeeds();
  }

  async validateFeeds() {
    log('🔍 Проверка доступности RSS-лент...');
    let workingFeeds = 0;
    
    for (const feedUrl of config.RSS_FEEDS.slice(0, 3)) { // Проверяем только первые 3
      try {
        await this.parser.parseURL(feedUrl);
        workingFeeds++;
        log(`✅ RSS-лента доступна: ${feedUrl}`);
      } catch (error) {
        log(`⚠️ RSS-лента недоступна: ${feedUrl} - ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    log(`📊 Доступно RSS-лент: ${workingFeeds}/${Math.min(3, config.RSS_FEEDS.length)} (проверка первых 3)`);
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
    
    for (const feedUrl of config.RSS_FEEDS) {
      try {
        await this.processFeed(feedUrl);
        processedFeeds++;
        
        // Задержка между обработкой фидов чтобы избежать блокировок
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        errorFeeds++;
        log(`❌ Ошибка обработки RSS-ленты ${feedUrl}: ${error.message}`);
        
        // Более короткая задержка при ошибке
        await new Promise(resolve => setTimeout(resolve, 1000));
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

      const keywords = await db.getKeywords();
      
      // Обрабатываем только последние 5 новостей чтобы не перегружать
      const recentItems = feed.items.slice(0, 5);
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
    
    // Очистка HTML тегов
    content = content.replace(/<[^>]*>/g, '').trim();
    
    // Обрезка длинного контента
    if (content.length > 300) {
      content = content.substring(0, 300) + '...';
    }
    
    // Если контент пустой, используем заголовок как контент
    if (!content) {
      content = title;
    }
    
    const link = item.link || '';
    const source = feedTitle || 'Неизвестный источник';
    
    return `
📰 <b>${this.escapeHtml(title)}</b>

${this.escapeHtml(content)}

${link ? `🔗 <a href="${link}">Читать полностью</a>` : ''}
📋 Источник: ${this.escapeHtml(source)}
    `.trim();
  }

  escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Метод для ручной проверки (может быть полезен для отладки)
  async manualCheck() {
    log('🔧 Запуск ручной проверки RSS...');
    await this.checkAllFeeds();
  }
}

module.exports = new NewsService();