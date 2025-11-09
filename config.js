// Конфигурация бота - замените значения на свои
module.exports = {
  // Токен бота от @BotFather
  TELEGRAM_BOT_TOKEN: '8028331417:AAFCiYwEJLCdGTDvXRJKBSBIasDF01l_12o',
  
  // API ключ от NewsAPI (получите на https://newsapi.org/)
  NEWS_API_KEY: 'e37f781c03b243ee83454e83d957f320',
  
  // Интервал проверки новостей в минутах
  DEFAULT_INTERVAL: 10,
  
  // Время для отправки топ-5 новостей (формат: '0 9 * * *' - каждый день в 9:00)
  DAILY_TOP_NEWS_TIME: '0 9 * * *',
  
  // Настройки RSS
  RSS_FEEDS: [
    'https://lenta.ru/rss/news',
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    'https://www.theverge.com/rss/index.xml',
    'https://www.vox.com/rss/index.xml',
    'https://www.ipgu.org/rss',
    'https://nativenewsonline.net/currents/feed/rss/',
    'https://media.rss.com/sovereignstories/feed.xml',
    'https://adcmemorial.org/en/feed/',
    'https://www.turantoday.com/feeds/posts/default/-/feed?alt=rss',
    'http://217.154.1.212:8080/rss/UC6NxANDfwFCWqRSfW-3e2WQ.xml',
    'http://217.154.1.212:8080/rss/UChXE1ElIcWSDYL7t-7Xe0iQ.xml',
    'http://217.154.1.212:8080/rss/UCU7CcJqFh6WT6FMicmCR5hA.xml',
    'http://217.154.1.212:8080/rss/UCwm0Mvq8GOt5B1wT5Lc9pvg.xml',
    'http://217.154.1.212:8080/rss/UCV3QBORgbX-tilCsRkmYlfQ.xml',
    'http://217.154.1.212:8080/rss/UCPGq5JbnJ4Ax668we-WjP0w.xml',
    'http://217.154.1.212:8080/rss/UCwhtt0GHo1qAv1ffq_FYY5w.xml',
    'http://217.154.1.212:8080/rss/UC0tNsrySZMDn44q8c9j76Ww.xml',
    'http://217.154.1.212:8080/rss/UCgJaHOCVuY-8Bss5AHH2efQ.xml',
    'http://217.154.1.212:8080/rss/UCu8xmiC7pSsVWpREcGGhxWA.xml',
    'http://217.154.1.212:8080/rss/UCl83JJytQa_bFsBnZDJq0dg.xml'
  ]
};
