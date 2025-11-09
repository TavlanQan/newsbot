const Parser = require('rss-parser');
const db = require('./db');
const config = require('./config');
const fs = require('fs');
const path = require('path');

// Логирование
const logStream = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'a' });
function log(msg) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  const logMsg = `[${timestamp}] [NewsService] ${msg}\n`;
  logStream.write(logMsg);
  console.log(logMsg);
}

class NewsService {
  constructor() {
    this.parser = new Parser({
      timeout: 15000,
      customFields: {
        item: [
          ['content:encoded', 'contentEncoded'],
          ['description', 'description'],
          ['pubDate', 'pubDate'],
          ['dc:creator', 'creator']
        ]
      }
    });
    this.monitoringInterval = null;
    this.isMonitoring = false;
    this.sendFunction = null;
  }

  async initialize(sendFunction = null) {
    this.sendFunction = sendFunction;
    log('📰 Инициализация сервиса новостей...');
    
    // Проверяем доступность RSS-лент
    for (const feedUrl of config.RSS_FEEDS) {
      try {
        await this.parser.parseURL(feedUrl);
        log(`✅ RSS лента доступна: ${feedUrl}`);
      } catch (error) {
        log(`❌ Ошибка доступа к RSS: ${feedUrl} - ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
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

    if (!this.sendFunction) {
      log('❌ Функция отправки не установлена!');
      return;
    }

    this.isMonitoring = true;
    log('🔄 Запуск мониторинга RSS-лент...');

    // Немедленная проверка при запуске
    await this.checkAllFeeds();

    // Периодическая проверка каждые 10 минут
    this.monitoringInterval = setInterval(() => {
      this.checkAllFeeds();
    }, 10 * 60 * 1000);

    log('✅ Мониторинг RSS-лент запущен');
  }

  async stopMonitoring() {
    this.isMonitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    log('⏹️ Мониторинг RSS-лент остановлен');
  }

  async checkAllFeeds() {
    if (!this.isMonitoring) {
      log('⏹️ Мониторинг отключен, пропускаем проверку RSS');
      return;
    }

    log('🔍 Начинаем проверку всех RSS-лент...');
    let totalProcessed = 0;
    
    for (const feedUrl of config.RSS_FEEDS) {
      try {
        const processed = await this.processFeed(feedUrl);
        totalProcessed += processed;
        
        // Задержка между обработкой фидов чтобы избежать блокировок
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error) {
        log(`❌ Ошибка обработки RSS-ленты ${feedUrl}: ${error.message}`);
      }
    }
    
    log(`✅ Проверка RSS завершена. Обработано новостей: ${totalProcessed}`);
  }

  async processFeed(feedUrl) {
    try {
      const feed = await this.parser.parseURL(feedUrl);
      log(`📋 RSS: ${feed.title || feedUrl} - найдено ${feed.items?.length || 0} новостей`);

      if (!feed.items || feed.items.length === 0) {
        return 0;
      }

      const keywords = await db.getKeywords();
      let processedCount = 0;
      
      // Обрабатываем только последние 10 новостей чтобы не перегружать
      const recentItems = feed.items.slice(0, 10);
      
      for (const item of recentItems) {
        // Проверяем, не отправляли ли мы уже эту новость
        const newsId = item.guid || item.link;
        if (!newsId) continue;

        const isSent = await db.isNewsSent(newsId);
        if (isSent) continue;

        // Проверяем соответствие ключевым словам
        if (this.matchesKeywords(item, keywords)) {
          const success = await this.processNewsItem(item, feed.title || feedUrl);
          if (success) processedCount++;
        }
      }
      
      if (processedCount > 0) {
        log(`✅ Обработано ${processedCount} новых новостей из ${feed.title || feedUrl}`);
      }
      
      return processedCount;
    } catch (error) {
      throw new Error(`Ошибка парсинга ${feedUrl}: ${error.message}`);
    }
  }

  matchesKeywords(item, keywords) {
    if (keywords.length === 0) return true; // Если нет ключевых слов, отправляем все

    const content = `${item.title} ${item.contentSnippet || ''} ${item.content || ''} ${item.description || ''}`.toLowerCase();
    
    return keywords.some(keyword => 
      content.includes(keyword.toLowerCase())
    );
  }

  async processNewsItem(item, feedTitle) {
    try {
      const message = this.formatNewsMessage(item, feedTitle);
      
      // Отправляем сообщение в целевые каналы
      if (this.sendFunction) {
        const success = await this.sendFunction(message);
        
        if (success) {
          log(`✅ Отправлена новость: ${item.title.substring(0, 100)}...`);
          
          // Помечаем как отправленную
          await db.addSentNews(item.guid || item.link, item.title, item.link);
          return true;
        } else {
          log(`❌ Не удалось отправить новость: ${item.title}`);
          return false;
        }
      } else {
        log('❌ Функция отправки не установлена, новость не отправлена');
        log(`📰 Новость: ${item.title}`);
        log(`🔗 Ссылка: ${item.link}`);
        return false;
      }
      
    } catch (error) {
      log(`❌ Ошибка обработки новости "${item.title}": ${error.message}`);
      return false;
    }
  }

  formatNewsMessage(item, feedTitle) {
    // Ограничиваем длину контента
    let content = item.contentSnippet || item.description || item.content || '';
    
    // Удаляем HTML теги и ограничиваем длину
    content = content.replace(/<[^>]*>/g, '').trim();
    if (content.length > 400) {
      content = content.substring(0, 400) + '...';
    }
    
    // Форматируем дату
    let dateStr = 'Неизвестно';
    try {
      if (item.pubDate) {
        dateStr = new Date(item.pubDate).toLocaleDateString('ru-RU');
      } else if (item.isoDate) {
        dateStr = new Date(item.isoDate).toLocaleDateString('ru-RU');
      }
    } catch (e) {
      // Игнорируем ошибки парсинга даты
    }
    
    return `
📰 <b>${this.escapeHtml(item.title)}</b>

${this.escapeHtml(content)}

🔗 <a href="${item.link}">Читать полностью</a>
📅 ${dateStr}
📋 Источник: ${this.escapeHtml(feedTitle)}
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
}

module.exports = new NewsService();