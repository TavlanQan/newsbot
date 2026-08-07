const Parser = require('rss-parser');
const db = require('./db');
const config = require('./config');
const errorHandler = require('./errorHandler');
const { rssLogger } = require('./utils/logger');

class NewsService {
  constructor() {
    this.parser = new Parser({
      timeout: 15000,
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
    this.currentProcessing = null;
    this.keywordsCache = [];
    this.lastKeywordsUpdate = 0;
    this.CACHE_TIME = 5 * 60 * 1000;
    this.feeds = [];  // теперь здесь хранятся все фиды
  }

  setFeeds(feedsArray) {
    this.feeds = feedsArray.filter(url => url && url.trim() !== '');
    rssLogger.info(`📡 Установлено ${this.feeds.length} RSS-фидов`);
  }

  addFeed(url) {
    if (!this.feeds.includes(url)) {
      this.feeds.push(url);
      rssLogger.info(`➕ Добавлен новый RSS-фид: ${url}`);
      return true;
    }
    return false;
  }

  async getKeywordsCached() {
    const now = Date.now();
    if (now - this.lastKeywordsUpdate > this.CACHE_TIME || this.keywordsCache.length === 0) {
      rssLogger.info('🔄 Обновляю кэш ключевых слов');
      try {
        this.keywordsCache = await db.getKeywords();
        this.lastKeywordsUpdate = now;
      } catch (error) {
        errorHandler.handleError(error, 'newsService: getKeywordsCached');
        throw error;
      }
    }
    return this.keywordsCache;
  }

  // ========== ИСПРАВЛЕННЫЙ initialize ==========
  async initialize() {
    // Если фиды ещё не установлены через setFeeds, берём из конфига
    if (!this.feeds || this.feeds.length === 0) {
      this.feeds = config.RSS_FEEDS || [];
    }
    rssLogger.info('📰 Инициализация сервиса новостей...');
    await this.validateFeeds();
  }

  // ========== ИСПРАВЛЕННЫЙ validateFeeds (использует this.feeds) ==========
  async validateFeeds() {
    rssLogger.info('🔍 Проверка доступности RSS-лент...');
    let workingFeeds = 0;
    const totalFeeds = this.feeds.length;

    if (totalFeeds === 0) {
      rssLogger.warn('⚠️ Нет RSS-лент для проверки');
      return;
    }

    for (let i = 0; i < totalFeeds; i++) {
      const feedUrl = this.feeds[i];
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Таймаут проверки')), 10000)
        );
        const checkPromise = this.parser.parseURL(feedUrl);
        await Promise.race([checkPromise, timeoutPromise]);
        workingFeeds++;
        rssLogger.info(`✅ RSS-лента доступна: ${feedUrl} (${i + 1}/${totalFeeds})`);
      } catch (error) {
        errorHandler.handleError(
          error,
          `newsService: validateFeeds failed for ${feedUrl}`,
          'WARN'
        );
        rssLogger.warn(`⚠️ RSS-лента недоступна: ${feedUrl} - ${error.message} (${i + 1}/${totalFeeds})`);
      }

      if (i < totalFeeds - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    rssLogger.info(`📊 Статистика RSS-лент: ${workingFeeds}/${totalFeeds} доступно`);
    if (workingFeeds === 0) {
      rssLogger.error('❌ ВНИМАНИЕ: Ни одна RSS-лента не доступна! Проверьте настройки.');
    } else if (workingFeeds < totalFeeds / 2) {
      rssLogger.warn('⚠️ ВНИМАНИЕ: Менее половины RSS-лент доступно!');
    }
  }

  setSendFunction(sendFunction) {
    this.sendFunction = sendFunction;
    rssLogger.info('✅ Функция отправки установлена в NewsService');
  }

  // ========== ИСПРАВЛЕННЫЙ startMonitoring (интервал из конфига) ==========
  async startMonitoring() {
    if (this.isMonitoring) {
      rssLogger.warn('⚠️ Мониторинг уже запущен');
      return;
    }

    this.isMonitoring = true;
    rssLogger.info('🔄 Запуск мониторинга RSS-лент...');

    try {
      await this.checkAllFeeds();
    } catch (error) {
      errorHandler.handleError(error, 'newsService: startMonitoring initial check');
      rssLogger.error(`❌ Ошибка при начальной проверке RSS: ${error.message}`);
    }

    // Интервал из конфига (в минутах)
    const intervalMs = (config.RSS_UPDATE_INTERVAL || 10) * 60 * 1000;
    this.monitoringInterval = setInterval(() => {
      this.checkAllFeeds().catch(error => {
        errorHandler.handleError(error, 'newsService: periodic check');
        rssLogger.error(`❌ Ошибка в периодической проверке RSS: ${error.message}`);
      });
    }, intervalMs);

    rssLogger.info(`✅ Мониторинг RSS-лент запущен (интервал ${config.RSS_UPDATE_INTERVAL || 10} мин)`);
  }

  async stopMonitoring() {
    this.isMonitoring = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    if (this.currentProcessing) {
      rssLogger.info('⏳ Завершаем текущую обработку RSS...');
      try {
        await this.currentProcessing;
      } catch (error) {
        errorHandler.handleError(error, 'newsService: stopMonitoring wait for processing');
        rssLogger.warn(`⚠️ Ошибка при завершении обработки: ${error.message}`);
      }
    }

    rssLogger.info('⏹️ Мониторинг RSS-лент остановлен');
  }

  async checkAllFeeds() {
    if (!this.isMonitoring) {
      rssLogger.warn('⚠️ Мониторинг не активен, пропускаем проверку');
      return;
    }

    if (this.currentProcessing) {
      rssLogger.warn('⚠️ Проверка уже выполняется, пропускаем');
      return;
    }

    this.currentProcessing = this._checkAllFeeds();
    try {
      await this.currentProcessing;
    } catch (error) {
      errorHandler.handleError(error, 'newsService: checkAllFeeds');
      throw error;
    } finally {
      this.currentProcessing = null;
    }
  }

  // ========== ИСПРАВЛЕННЫЙ _checkAllFeeds (использует this.feeds) ==========
  async _checkAllFeeds() {
    rssLogger.info('🔍 Начинаем проверку всех RSS-лент...');
    let processedFeeds = 0;
    let errorFeeds = 0;

    const feeds = this.feeds; // используем динамический список

    for (let i = 0; i < feeds.length; i++) {
      const feedUrl = feeds[i];
      try {
        await this.processFeed(feedUrl);
        processedFeeds++;
        const delay = i < 5 ? 500 : 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (error) {
        errorFeeds++;
        errorHandler.handleError(
          error,
          `newsService: _checkAllFeeds processing ${feedUrl}`,
          'ERROR'
        );
        rssLogger.error(`❌ Ошибка обработки RSS-ленты ${feedUrl}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    rssLogger.info(`✅ Проверка RSS завершена. Успешно: ${processedFeeds}, с ошибками: ${errorFeeds}`);
  }

  // ========== Остальные методы без изменений ==========
  async processFeed(feedUrl) {
    try {
      const feed = await this.parser.parseURL(feedUrl);
      rssLogger.info(`📋 RSS: ${feed.title || feedUrl} - найдено ${feed.items?.length || 0} новостей`);

      if (!feed.items || feed.items.length === 0) {
        rssLogger.warn(`⚠️ В RSS-ленте ${feedUrl} нет новостей`);
        return;
      }

      const keywords = await this.getKeywordsCached();
      const MAX_ITEMS_PER_FEED = 10;
      const recentItems = feed.items.slice(0, MAX_ITEMS_PER_FEED);

      if (feed.items && feed.items.length > 50) {
        rssLogger.warn(`⚠️ ВНИМАНИЕ: ${feedUrl} вернул ${feed.items.length} новостей! Обрабатываю только ${MAX_ITEMS_PER_FEED}`);
      }

      let processedItems = 0;

      for (const item of recentItems) {
        try {
          const newsId = item.guid || item.link;
          if (!newsId) {
            rssLogger.warn(`⚠️ Пропущена новость без ID: ${item.title?.substring(0, 50)}`);
            continue;
          }

          const isSent = await db.isNewsSent(newsId);
          if (isSent) continue;

          if (this.matchesKeywords(item, keywords)) {
            await this.processNewsItem(item, feed.title || feedUrl);
            processedItems++;
          }
        } catch (itemError) {
          errorHandler.handleError(
            itemError,
            `newsService: processFeed item error in ${feedUrl}`,
            'WARN'
          );
          rssLogger.error(`❌ Ошибка обработки новости из ${feedUrl}: ${itemError.message}`);
        }
      }

      if (processedItems > 0) {
        rssLogger.info(`✅ Обработано ${processedItems} новостей из ${feedUrl}`);
      }
    } catch (error) {
      errorHandler.handleError(error, `newsService: processFeed ${feedUrl}`, 'ERROR');
      rssLogger.error(`❌ Критическая ошибка парсинга ${feedUrl}: ${error.message}`);
      throw error;
    }
  }

  matchesKeywords(item, keywords) {
    if (keywords.length === 0) return true;
    const content = `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''} ${item.description || ''}`.toLowerCase();
    return keywords.some(keyword => content.includes(keyword.toLowerCase()));
  }

  async processNewsItem(item, feedTitle) {
    const newsId = item.guid || item.link;

    if (item.content && item.content.length > 10000) {
      rssLogger.info(`📏 Новость слишком большая (${item.content.length} символов), обрезаю`);
      item.content = item.content.substring(0, 10000) + '...';
    }

    try {
      const isSent = await db.isNewsSent(newsId);
      if (isSent) {
        rssLogger.warn(`⚠️ Новость уже была отправлена ранее: ${item.title?.substring(0, 100) || 'без названия'}`);
        return;
      }

      const message = this.formatNewsMessage(item, feedTitle);

      if (this.sendFunction) {
        const sent = await this.sendFunction(message);
        if (sent) {
          await db.addSentNews(newsId, item.title || 'Без названия', item.link || '');
          rssLogger.info(`✅ Отправлена новость: ${item.title?.substring(0, 100) || 'без названия'}...`);
        } else {
          rssLogger.warn(`⚠️ Не удалось отправить новость: ${item.title?.substring(0, 100) || 'без названия'}`);
        }
      } else {
        rssLogger.error('❌ Функция отправки не установлена, новость не отправлена');
      }
    } catch (error) {
      errorHandler.handleError(
        error,
        `newsService: processNewsItem "${item.title || 'без названия'}"`,
        'ERROR'
      );
      rssLogger.error(`❌ Ошибка обработки новости "${item.title || 'без названия'}": ${error.message}`);
    }
  }

  formatNewsMessage(item, feedTitle) {
    const title = item.title || 'Без названия';
    let content = item.contentSnippet || item.description || item.content || '';
    content = content.replace(/<[^>]*>/g, '').trim();

    const MAX_CONTENT_LENGTH = 500;
    if (content.length > MAX_CONTENT_LENGTH) {
      content = content.substring(0, MAX_CONTENT_LENGTH) + '...';
    }
    if (!content) {
      content = title;
    }

    const link = item.link || '';
    const source = feedTitle || 'Неизвестный источник';

    const safeTitle = this.escapeHtml(title);
    const safeContent = this.escapeHtml(content);
    const safeSource = this.escapeHtml(source);

    let safeLink = '';
    if (link) {
      if (link.startsWith('http://') || link.startsWith('https://')) {
        safeLink = `🔗 <a href="${link}">Читать полностью</a>`;
      } else {
        safeLink = `🔗 Ссылка: ${this.escapeHtml(link)}`;
      }
    }

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
      .replace(/\$/g, '&#36;')
      .replace(/`/g, '&#96;')
      .replace(/\|/g, '&#124;');
  }

  async manualCheck() {
    rssLogger.info('🔧 Запуск ручной проверки RSS...');
    try {
      await this.checkAllFeeds();
    } catch (error) {
      errorHandler.handleError(error, 'newsService: manualCheck');
    }
  }
}

module.exports = new NewsService();