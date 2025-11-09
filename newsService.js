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
      customFields: {
        item: [
          ['content:encoded', 'contentEncoded'],
          ['description', 'description']
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
  }

  setSendFunction(sendFunction) {
    this.sendFunction = sendFunction;
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
      log('⏹️ Мониторинг отключен, пропускаем проверку RSS');
      return;
    }

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
    
    log('✅ Проверка RSS-лент завершена');
  }

  async processFeed(feedUrl) {
    try {
      const feed = await this.parser.parseURL(feedUrl);
      log(`📋 Найдено ${feed.items.length} новостей в ${feed.title || feedUrl}`);

      const keywords = await db.getKeywords();
      let processedCount = 0;
      
      for (const item of feed.items) {
        // Проверяем, не отправляли ли мы уже эту новость
        const newsId = item.guid || item.link;
        const isSent = await db.isNewsSent(newsId);
        if (isSent) continue;

        // Проверяем соответствие ключевым словам
        if (this.matchesKeywords(item, keywords)) {
          await this.processNewsItem(item, feed.title);
          processedCount++;
        }
      }
      
      if (processedCount > 0) {
        log(`✅ Обработано ${processedCount} новых новостей из ${feed.title || feedUrl}`);
      }
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
        await this.sendFunction(message);
        log(`✅ Отправлена новость: ${item.title.substring(0, 100)}...`);
      } else {
        log('⚠️ Функция отправки не установлена, новость не отправлена');
        log(`📰 Новость: ${item.title}`);
        log(`🔗 Ссылка: ${item.link}`);
      }
      
      // Помечаем как отправленную
      await db.addSentNews(item.guid || item.link, item.title, item.link);
      
    } catch (error) {
      log(`❌ Ошибка обработки новости "${item.title}": ${error.message}`);
    }
  }

  formatNewsMessage(item, feedTitle) {
    // Ограничиваем длину контента
    let content = item.contentSnippet || item.description || item.content || '';
    if (content.length > 500) {
      content = content.substring(0, 500) + '...';
    }
    
    // Очищаем HTML теги для простого текста
    content = content.replace(/<[^>]*>/g, '').trim();
    
    return `
📰 <b>${this.escapeHtml(item.title)}</b>

${this.escapeHtml(content)}

🔗 <a href="${item.link}">Читать полностью</a>
📅 ${new Date(item.pubDate || item.isoDate || '').toLocaleDateString('ru-RU')}
📋 Источник: ${this.escapeHtml(feedTitle || 'RSS')}
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