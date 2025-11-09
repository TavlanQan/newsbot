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
    this.parser = new Parser();
    this.monitoringInterval = null;
    this.isMonitoring = false;
  }

  async initialize() {
    log('📰 Инициализация сервиса новостей...');
  }

  async startMonitoring() {
    if (this.isMonitoring) {
      log('⚠️ Мониторинг уже запущен');
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
    if (!this.isMonitoring) return;

    log('🔍 Проверка RSS-лент...');
    
    for (const feedUrl of config.RSS_FEEDS) {
      try {
        await this.processFeed(feedUrl);
        // Задержка между обработкой фидов чтобы избежать блокировок
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        log(`❌ Ошибка обработки RSS-ленты ${feedUrl}: ${error.message}`);
      }
    }
  }

  async processFeed(feedUrl) {
    try {
      const feed = await this.parser.parseURL(feedUrl);
      log(`📋 Найдено ${feed.items.length} новостей в ${feed.title || feedUrl}`);

      const keywords = await db.getKeywords();
      
      for (const item of feed.items) {
        // Проверяем, не отправляли ли мы уже эту новость
        const isSent = await db.isNewsSent(item.guid || item.link);
        if (isSent) continue;

        // Проверяем соответствие ключевым словам
        if (this.matchesKeywords(item, keywords)) {
          await this.processNewsItem(item, feed.title);
        }
      }
    } catch (error) {
      throw new Error(`Ошибка парсинга ${feedUrl}: ${error.message}`);
    }
  }

  matchesKeywords(item, keywords) {
    if (keywords.length === 0) return true; // Если нет ключевых слов, отправляем все

    const content = `${item.title} ${item.contentSnippet || ''} ${item.content || ''}`.toLowerCase();
    
    return keywords.some(keyword => 
      content.includes(keyword.toLowerCase())
    );
  }

  async processNewsItem(item, feedTitle) {
    try {
      const message = this.formatNewsMessage(item, feedTitle);
      
      // Здесь должна быть логика отправки в телеграм каналы
      // Временно просто логируем
      log(`📰 Новая новость: ${item.title}`);
      log(`🔗 Ссылка: ${item.link}`);
      
      // Помечаем как отправленную
      await db.addSentNews(item.guid || item.link, item.title, item.link);
      
    } catch (error) {
      log(`❌ Ошибка обработки новости "${item.title}": ${error.message}`);
    }
  }

  formatNewsMessage(item, feedTitle) {
    return `
📰 ${item.title}

${item.contentSnippet || item.content || ''}

🔗 ${item.link}
📅 ${new Date(item.pubDate || '').toLocaleDateString('ru-RU')}
📋 Источник: ${feedTitle || 'RSS'}
    `.trim();
  }
}

module.exports = new NewsService();