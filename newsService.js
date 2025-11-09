const axios = require('axios');
const Parser = require('rss-parser');
const config = require('./config');
const db = require('./db');

// 📡 НАСТРОЙКА RSS-ПАРСЕРА
const rssParser = new Parser();

// 🚀 ОСНОВНОЙ КЛАСС ДЛЯ РАБОТЫ С НОВОСТЯМИ
class NewsService {
  constructor() {
    this.newsApiKey = config.NEWS_API_KEY;
  }

  // 🔍 ПОИСК НОВОСТЕЙ ЧЕРЕЗ NEWSAPI (ВСЕ ЯЗЫКИ МИРА)
  async searchNews(keywords, pageSize = 20) {
    try {
      const query = keywords.join(' OR ');
      console.log(`🔍 NewsAPI поиск: ${query}`);
      
      const response = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: query,
          pageSize: pageSize,
          sortBy: 'publishedAt',
          // ❗ ЯВНО НЕ УКАЗЫВАЕМ ЯЗЫК - поиск на всех языках!
          apiKey: this.newsApiKey
        }
      });

      return response.data.articles || [];
    } catch (error) {
      console.error('❌ Ошибка при поиске новостей:', error.message);
      if (error.response) {
        console.error('Детали ошибки:', error.response.data);
      }
      return [];
    }
  }

  // 📡 ПОЛУЧЕНИЕ НОВОСТЕЙ ИЗ RSS-ЛЕНТ
  async getRSSNews() {
    const allNews = [];
    
    console.log(`📡 Загрузка RSS из ${config.RSS_FEEDS.length} источников...`);
    
    for (const feedUrl of config.RSS_FEEDS) {
      try {
        const feed = await rssParser.parseURL(feedUrl);
        const newsItems = feed.items.slice(0, 10).map(item => ({
          title: item.title,
          description: item.contentSnippet || item.content || item.summary,
          url: item.link,
          urlToImage: this.extractImageFromRSS(item),
          publishedAt: item.pubDate || item.isoDate,
          source: { name: feed.title || 'RSS Feed' },
          isRSS: true
        }));
        
        allNews.push(...newsItems);
        console.log(`✅ RSS загружен: ${feed.title} (${newsItems.length} новостей)`);
      } catch (error) {
        console.error(`❌ Ошибка при парсинге RSS ${feedUrl}:`, error.message);
      }
    }
    
    return allNews;
  }

  // 🖼️ ИЗВЛЕЧЕНИЕ ИЗОБРАЖЕНИЯ ИЗ RSS (если есть)
  extractImageFromRSS(item) {
    if (item.enclosure && item.enclosure.type && item.enclosure.type.startsWith('image/')) {
      return item.enclosure.url;
    }
    if (item.content && item.content.includes('<img')) {
      const match = item.content.match(/<img[^>]+src="([^">]+)"/);
      if (match) return match[1];
    }
    return null;
  }

  // 🌟 ПОЛУЧЕНИЕ ТОП НОВОСТЕЙ СО ВСЕГО МИРА
  async getTopNews() {
    try {
      console.log('🌟 Поиск топ новостей по категориям...');
      
      // Ищем новости из разных категорий
      const [generalNews, technologyNews, businessNews] = await Promise.all([
        this.getTopNewsByCategory('general'),
        this.getTopNewsByCategory('technology'),
        this.getTopNewsByCategory('business')
      ]);

      // Объединяем все новости
      const allNews = [...generalNews, ...technologyNews, ...businessNews];
      
      // Удаляем дубликаты (если одна новость в нескольких категориях)
      const uniqueNews = this.removeDuplicates(allNews);
      
      console.log(`✅ Найдено ${uniqueNews.length} уникальных топ новостей`);
      return uniqueNews.slice(0, 10);
    } catch (error) {
      console.error('❌ Ошибка при получении топ новостей:', error.message);
      return [];
    }
  }

  // 📰 ПОЛУЧЕНИЕ ТОП НОВОСТЕЙ ПО КАТЕГОРИИ
  async getTopNewsByCategory(category) {
    try {
      const response = await axios.get('https://newsapi.org/v2/top-headlines', {
        params: {
          category: category,
          pageSize: 10,
          // Не указываем страну - получаем международные новости
          apiKey: this.newsApiKey
        }
      });

      return response.data.articles || [];
    } catch (error) {
      console.error(`❌ Ошибка при получении новостей категории ${category}:`, error.message);
      return [];
    }
  }

  // 🗑️ УДАЛЕНИЕ ДУБЛИКАТОВ НОВОСТЕЙ
  removeDuplicates(news) {
    const seen = new Set();
    return news.filter(item => {
      const identifier = item.url || item.title;
      if (seen.has(identifier)) {
        return false;
      }
      seen.add(identifier);
      return true;
    });
  }

  // 🎯 ФИЛЬТРАЦИЯ НОВОСТЕЙ ПО КЛЮЧЕВЫМ СЛОВАМ (ВСЕ ЯЗЫКИ)
  async getFilteredNews() {
    const keywords = await db.getKeywords();
    if (keywords.length === 0) {
      console.log('📭 Нет ключевых слов для поиска');
      return [];
    }

    console.log(`🔍 Поиск новостей по ${keywords.length} ключевым словам...`);

    // Получаем новости из разных источников
    const [newsApiResults, rssNews] = await Promise.all([
      this.searchNews(keywords, 30), // Увеличиваем лимит для большего охвата
      this.getRSSNews()
    ]);

    const allNews = [...newsApiResults, ...rssNews];
    console.log(`📊 Всего найдено новостей: ${allNews.length}`);
    
    // Фильтруем по ключевым словам (регистронезависимо, все языки)
    const keywordFilteredNews = allNews.filter(news => 
      this.containsKeywords(news, keywords)
    );
    
    console.log(`📊 После фильтрации по ключевым словам: ${keywordFilteredNews.length}`);
    
    // Фильтруем уже отправленные новости
    const filteredNews = [];
    for (const news of keywordFilteredNews) {
      const newsId = this.generateNewsId(news);
      const isSent = await db.isNewsSent(newsId);
      
      if (!isSent && news.title && news.url) {
        filteredNews.push(news);
      }
    }

    console.log(`📊 Новых уникальных новостей: ${filteredNews.length}`);
    
    // Сортируем по дате публикации (новые первыми)
    return filteredNews.sort((a, b) => 
      new Date(b.publishedAt) - new Date(a.publishedAt)
    );
  }

  // 🔎 ПРОВЕРКА СОДЕРЖАНИЯ КЛЮЧЕВЫХ СЛОВ (РЕГИСТРОНЕЗАВИСИМО)
  containsKeywords(news, keywords) {
    const searchText = `${news.title || ''} ${news.description || ''}`.toLowerCase();
    return keywords.some(keyword => 
      searchText.includes(keyword.toLowerCase())
    );
  }

  // 🆔 ГЕНЕРАЦИЯ УНИКАЛЬНОГО ID ДЛЯ НОВОСТИ
  generateNewsId(news) {
    return Buffer.from(news.url).toString('base64').slice(0, 100);
  }

  // ✅ ОТМЕТИТЬ НОВОСТЬ КАК ОТПРАВЛЕННУЮ
  async markAsSent(news) {
    const newsId = this.generateNewsId(news);
    await db.addSentNews(newsId, news.title, news.url);
  }
}

// 📤 ЭКСПОРТ ЕДИНСТВЕННОГО ЭКЗЕМПЛЯРА КЛАССА
module.exports = new NewsService();
