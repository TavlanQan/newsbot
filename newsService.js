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
      timeout: 10000,
      requestOptions: {
        timeout: 10000
      }
    });
    this.monitoringInterval = null;
    this.isMonitoring = false;
    this.sendFunction = null;
  }

  async initialize() {
    log('📰 Инициализация сервиса новостей...');
    // Отложим проверку RSS до первого запуска мониторинга
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
      return;
    }

    log('🔍 Начинаем проверку всех RSS-лент...');
    
    for (const feedUrl of config.RSS_FEEDS) {
      try {
        await this.processFeed(feedUrl);
        // Задержка между обработкой фидов чтобы избежать блокировок
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        log(`❌ Ошибка обработки RSS-ленты ${feedUrl}: ${error.message}`);
      }
    }
    
    log('✅ Проверка RSS завершена');
  }

  async processFeed(feedUrl) {
    try {
      const feed = await this.parser.parseURL(feedUrl);
      log(`📋 RSS: ${feed.title || feedUrl} - найдено ${feed.items?.length || 0} новостей`);

      if (!feed.items || feed.items.length === 0) {
        return;
      }

      const keywords = await db.getKeywords();
      
      // Обрабатываем только последние 5 новостей чтобы не перегружать
      const recentItems = feed.items.slice(0, 5);
      
      for (const item of recentItems) {
        // Проверяем, не отправляли ли мы уже эту новость
        const newsId = item.guid || item.link;
        if (!newsId) continue;

        const isSent = await db.isNewsSent(newsId);
        if (isSent) continue;

        // Проверяем соответствие ключевым словам
        if (this.matchesKeywords(item, keywords)) {
          await this.processNewsItem(item, feed.title || feedUrl);
        }
      }
    } catch (error) {
      throw new Error(`Ошибка парсинга ${feedUrl}: ${error.message}`);
    }
  }

  matchesKeywords(item, keywords) {
    if (keywords.length === 0) return true;

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
        await this.sendFunction(message);
        log(`✅ Отправлена новость: ${item.title.substring(0, 100)}...`);
        
        // Помечаем как отправленную
        await db.addSentNews(item.guid || item.link, item.title, item.link);
      } else {
        log('❌ Функция отправки не установлена, новость не отправлена');
      }
    } catch (error) {
      log(`❌ Ошибка обработки новости "${item.title}": ${error.message}`);
    }
  }

  formatNewsMessage(item, feedTitle) {
    let content = item.contentSnippet || item.description || item.content || '';
    content = content.replace(/<[^>]*>/g, '').trim();
    if (content.length > 300) {
      content = content.substring(0, 300) + '...';
    }
    
    return `
📰 <b>${this.escapeHtml(item.title)}</b>

${this.escapeHtml(content)}

🔗 <a href="${item.link}">Читать полностью</a>
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