const { Telegraf, Markup } = require('telegraf');
const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const newsService = require('./newsService');

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
let botUserId = null;

// 🎛️ МЕНЮ КОМАНД БОТА
const mainMenu = Markup.keyboard([
  ['📋 Ключевые слова', '🎯 Целевые каналы'],
  ['🌐 Мониторинг каналов', '🔍 Найти новости'],
  ['⚙️ Настройки', '📊 Статистика'],
  ['🔄 Тестовый поиск']
]).resize();

const keywordsMenu = Markup.keyboard([
  ['📝 Добавить ключевое слово', '🗑️ Удалить ключевое слово'],
  ['📋 Список ключевых слов', '🏠 Главное меню']
]).resize();

const targetChannelsMenu = Markup.keyboard([
  ['➕ Добавить целевой канал', '➖ Удалить целевой канал'],
  ['📋 Список целевых каналов', '🏠 Главное меню']
]).resize();

const monitoredChannelsMenu = Markup.keyboard([
  ['➕ Добавить канал для отслеживания', '➖ Удалить канал отслеживания'],
  ['📋 Список отслеживаемых каналов', '🔧 Вкл/Выкл мониторинг'],
  ['🏠 Главное меню']
]).resize();

const settingsMenu = Markup.keyboard([
  ['⏰ Изменить интервал', '🔧 Вкл/Выкл автопостинг'],
  ['🏠 Главное меню']
]).resize();

const backMenu = Markup.keyboard([
  ['🏠 Главное меню']
]).resize();

const userStates = new Map();

// 🔍 ПОЛУЧЕНИЕ ИНФОРМАЦИИ О БОТЕ
async function getBotInfo() {
  try {
    const botInfo = await bot.telegram.getMe();
    botUserId = botInfo.id;
    console.log(`✅ Информация о боте получена: ${botInfo.first_name} (@${botInfo.username})`);
    return botInfo;
  } catch (error) {
    console.error('❌ Ошибка при получении информации о боте:', error.message);
    throw error;
  }
}

// 👑 ПРОВЕРКА ПРАВ БОТА В ЦЕЛЕВЫХ КАНАЛАХ
async function checkBotAdmin() {
  try {
    console.log('🔍 Проверка прав бота в целевых каналах...');
    
    if (!botUserId) await getBotInfo();
    
    const targetChannels = await db.getTargetChannels();
    
    if (targetChannels.length === 0) {
      console.log('📭 Нет целевых каналов для проверки');
      return true;
    }
    
    let allChannelsOk = true;
    
    for (const channel of targetChannels) {
      try {
        const chat = await bot.telegram.getChat(channel.channel_id);
        console.log(`📢 Проверка канала: ${chat.title} (${chat.id})`);
        
        const members = await bot.telegram.getChatAdministrators(channel.channel_id);
        const botMember = members.find(member => member.user.id === botUserId);
        
        if (!botMember) {
          console.error(`❌ Бот не является администратором канала: ${chat.title}`);
          allChannelsOk = false;
        } else {
          console.log(`✅ Права OK: ${chat.title}`);
        }
      } catch (error) {
        console.error(`❌ Ошибка доступа к каналу ${channel.channel_id}:`, error.message);
        allChannelsOk = false;
      }
    }
    
    return allChannelsOk;
  } catch (error) {
    console.error('❌ Ошибка при проверке прав бота:', error.message);
    return false;
  }
}

// 🔎 ПРОВЕРКА СОДЕРЖИТ ЛИ ТЕКСТ КЛЮЧЕВЫЕ СЛОВА
function containsKeywords(text, keywords) {
  if (!text) return false;
  const searchText = text.toLowerCase();
  return keywords.some(keyword => searchText.includes(keyword.toLowerCase()));
}

// 🔄 ПЕРЕСЫЛКА СООБЩЕНИЯ ИЗ КАНАЛА ВО ВСЕ ЦЕЛЕВЫЕ КАНАЛЫ
async function forwardMessageFromChannel(ctx, sourceChannelId) {
  try {
    const monitoringEnabled = await db.getSetting('channel_monitoring_enabled');
    if (monitoringEnabled !== 'true') return;

    const keywords = await db.getKeywords();
    if (keywords.length === 0) return;

    const messageText = ctx.channelPost.text || ctx.channelPost.caption || '';
    
    if (!containsKeywords(messageText, keywords)) return;

    // Проверяем, не пересылали ли уже это сообщение
    const isForwarded = await db.isMessageForwarded(ctx.channelPost.message_id, sourceChannelId);
    if (isForwarded) return;

    // ПОЛУЧАЕМ ВСЕ ЦЕЛЕВЫЕ КАНАЛЫ
    const targetChannels = await db.getTargetChannels();
    
    if (targetChannels.length === 0) {
      console.log('📭 Нет целевых каналов для пересылки');
      return;
    }

    let successCount = 0;
    
    // Пересылаем во все целевые каналы
    for (const targetChannel of targetChannels) {
      try {
        await ctx.forwardMessage(targetChannel.channel_id, sourceChannelId, ctx.channelPost.message_id);
        successCount++;
        console.log(`✅ Переслано в канал: ${targetChannel.channel_title || targetChannel.channel_id}`);
        
        // Небольшая задержка между отправками
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`❌ Ошибка пересылки в ${targetChannel.channel_id}:`, error.message);
      }
    }
    
    // Сохраняем в базу что переслали
    if (successCount > 0) {
      await db.addForwardedMessage(ctx.channelPost.message_id, sourceChannelId);
      console.log(`✅ Переслано сообщение из ${sourceChannelId} в ${successCount} каналов`);
    }
  } catch (error) {
    console.error('❌ Ошибка при пересылке сообщения:', error.message);
  }
}

// 📨 ОБРАБОТЧИК СООБЩЕНИЙ ИЗ КАНАЛОВ
bot.on('channel_post', async (ctx) => {
  const channelId = ctx.channelPost.chat.id.toString();
  const monitoredChannels = await db.getMonitoredChannels();
  
  const isMonitored = monitoredChannels.some(channel => 
    channel.channel_id === channelId
  );
  
  if (isMonitored) {
    await forwardMessageFromChannel(ctx, channelId);
  }
});

// 📝 ФОРМАТИРОВАНИЕ СООБЩЕНИЯ С НОВОСТЬЮ
function formatNewsMessage(news, index = null) {
  const title = news.title || 'Без заголовка';
  const description = news.description ? `\n\n${news.description.slice(0, 200)}...` : '';
  const source = news.source?.name ? `\n\n📰 Источник: ${news.source.name}` : '';
  const number = index !== null ? `📰 Новость #${index + 1}\n\n` : '';
  
  const message = `${number}**${title}**${description}${source}`;

  // Создаем inline-кнопки
  const buttons = [
    [Markup.button.url('📖 Читать полностью', news.url)]
  ];

  // Кнопка "Похожие новости" только если есть заголовок
  if (news.title) {
    const searchQuery = encodeURIComponent(news.title.split(' ').slice(0, 3).join(' '));
    buttons.push([Markup.button.url('🔍 Похожие новости', `https://news.google.com/search?q=${searchQuery}`)]);
  }

  return {
    text: message,
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    parse_mode: 'Markdown'
  };
}

// 📤 ОТПРАВКА НОВОСТИ ВО ВСЕ ЦЕЛЕВЫЕ КАНАЛЫ
async function sendNewsToChannels(news) {
  try {
    const messageConfig = formatNewsMessage(news);
    
    // ПОЛУЧАЕМ ВСЕ ЦЕЛЕВЫЕ КАНАЛЫ
    const targetChannels = await db.getTargetChannels();
    
    if (targetChannels.length === 0) {
      console.log('📭 Нет целевых каналов для отправки');
      return false;
    }

    let successCount = 0;
    
    // Отправляем во все целевые каналы
    for (const channel of targetChannels) {
      try {
        // Если есть изображение, отправляем с фото
        if (news.urlToImage) {
          await bot.telegram.sendPhoto(channel.channel_id, news.urlToImage, {
            caption: messageConfig.text,
            reply_markup: messageConfig.reply_markup,
            parse_mode: 'Markdown'
          });
        } else {
          await bot.telegram.sendMessage(channel.channel_id, messageConfig.text, {
            reply_markup: messageConfig.reply_markup,
            parse_mode: 'Markdown'
          });
        }
        
        successCount++;
        console.log(`✅ Отправлена новость в: ${channel.channel_title || channel.channel_id}`);
        
        // Задержка между отправками
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`❌ Ошибка отправки в ${channel.channel_id}:`, error.message);
      }
    }
    
    // Отмечаем новость как отправленную
    if (successCount > 0) {
      await newsService.markAsSent(news);
      console.log(`✅ Новость отправлена в ${successCount} каналов: ${news.title}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Ошибка при отправке новости:', error.message);
    return false;
  }
}

// 🤖 АВТОМАТИЧЕСКАЯ ПРОВЕРКА И ОТПРАВКА НОВОСТЕЙ
async function autoPostNews() {
  try {
    const autoPostEnabled = await db.getSetting('auto_post_enabled');
    if (autoPostEnabled !== 'true') {
      console.log('⏸️ Автопостинг выключен');
      return;
    }

    console.log('🔍 Автоматический поиск новых новостей...');
    const news = await newsService.getFilteredNews();
    
    if (news.length > 0) {
      // Отправляем только самую свежую новость
      await sendNewsToChannels(news[0]);
      console.log(`📬 Найдено ${news.length} новых новостей`);
    } else {
      console.log('📭 Новых новостей не найдено');
    }
  } catch (error) {
    console.error('❌ Ошибка в autoPostNews:', error);
  }
}

// 🌟 ОТПРАВКА ТОП-5 НОВОСТЕЙ ВО ВСЕ КАНАЛЫ
async function sendTopNews() {
  try {
    console.log('🌟 Поиск топ новостей со всего мира...');
    const topNews = await newsService.getTopNews();
    
    if (topNews.length > 0) {
      const top5News = topNews.slice(0, 5);
      
      // ОТПРАВЛЯЕМ ВО ВСЕ ЦЕЛЕВЫЕ КАНАЛЫ
      const targetChannels = await db.getTargetChannels();
      
      for (const channel of targetChannels) {
        try {
          await bot.telegram.sendMessage(
            channel.channel_id, 
            `🌟 **Топ-5 мировых новостей за сегодня:**\n\n` +
            top5News.map((news, index) => 
              `${index + 1}. [${news.title}](${news.url})`
            ).join('\n\n'),
            { parse_mode: 'Markdown' }
          );
          console.log(`✅ Топ новости отправлены в: ${channel.channel_title || channel.channel_id}`);
        } catch (error) {
          console.error(`❌ Ошибка отправки топ новостей в ${channel.channel_id}:`, error.message);
        }
      }
      
      console.log(`✅ Отправлены топ-${top5News.length} мировых новостей в ${targetChannels.length} каналов`);
    } else {
      console.log('📭 Топ новости не найдены');
    }
  } catch (error) {
    console.error('❌ Ошибка при отправке топ новостей:', error);
  }
}

// 🛠️ ПОЛНОСТЬЮ ПЕРЕПИСАННАЯ ФУНКЦИЯ ДЛЯ УДАЛЕНИЯ КАНАЛА
async function removeChannelWithDebug(ctx, userText, channelType) {
  console.log(`\n🔍 НАЧАЛО УДАЛЕНИЯ КАНАЛА ТИПА: ${channelType}`);
  console.log(`📝 ВВЕДЕННЫЙ ТЕКСТ: "${userText}"`);
  
  const isTarget = channelType === 'target';
  const getChannelsFunc = isTarget ? db.getTargetChannels : db.getMonitoredChannels;
  const removeChannelFunc = isTarget ? db.removeTargetChannel : db.removeMonitoredChannel;
  const successMenu = isTarget ? targetChannelsMenu : monitoredChannelsMenu;
  const channelTypeName = isTarget ? 'целевой' : 'отслеживаемый';

  try {
    // Получаем все каналы
    const channels = await getChannelsFunc();
    console.log(`📊 КАНАЛОВ В БАЗЕ: ${channels.length}`);
    
    if (channels.length === 0) {
      await ctx.reply(`📭 Нет ${channelTypeName} каналов для удаления`, successMenu);
      return true;
    }

    // Выводим отладочную информацию о каналах
    console.log(`📋 СПИСОК КАНАЛОВ В БАЗЕ:`);
    channels.forEach((ch, index) => {
      console.log(`   ${index + 1}. ID: "${ch.channel_id}", Title: "${ch.channel_title}", Username: "${ch.channel_username}"`);
    });

    let channelToRemove = null;

    // Случай 1: Пользователь ввел номер из списка
    const channelNumber = parseInt(userText.trim());
    if (!isNaN(channelNumber) && channelNumber >= 1 && channelNumber <= channels.length) {
      console.log(`🔢 ПОЛЬЗОВАТЕЛЬ ВВЕЛ НОМЕР: ${channelNumber}`);
      channelToRemove = channels[channelNumber - 1];
      console.log(`🎯 КАНАЛ ДЛЯ УДАЛЕНИЯ ПО НОМЕРУ: "${channelToRemove.channel_title}" (ID: ${channelToRemove.channel_id})`);
    }
    // Случай 2: Поиск по ID, username или названию
    else {
      console.log(`🔍 ПРОБУЕМ НАЙТИ КАНАЛ ПО ТЕКСТУ: "${userText}"`);
      
      const cleanUserInput = userText.replace('@', '').toLowerCase().trim();
      
      channelToRemove = channels.find(ch => {
        const cleanUsername = ch.channel_username ? ch.channel_username.replace('@', '').toLowerCase().trim() : '';
        const cleanTitle = ch.channel_title ? ch.channel_title.toLowerCase().trim() : '';
        const cleanId = ch.channel_id ? ch.channel_id.toString().toLowerCase().trim() : '';
        
        return (
          cleanId === cleanUserInput ||
          cleanUsername === cleanUserInput ||
          cleanTitle === cleanUserInput ||
          (cleanTitle && cleanTitle.includes(cleanUserInput)) ||
          (cleanUsername && cleanUsername.includes(cleanUserInput))
        );
      });

      if (channelToRemove) {
        console.log(`🎯 НАЙДЕН КАНАЛ: "${channelToRemove.channel_title}" (ID: ${channelToRemove.channel_id})`);
      }
    }

    // Если канал не найден
    if (!channelToRemove) {
      console.log(`❌ КАНАЛ НЕ НАЙДЕН`);
      
      const channelsList = channels.map((ch, index) => {
        let info = `${index + 1}. `;
        if (ch.channel_title) info += `"${ch.channel_title}"`;
        if (ch.channel_username) info += ` (@${ch.channel_username})`;
        info += ` - ID: ${ch.channel_id}`;
        return info;
      }).join('\n');

      await ctx.reply(
        `❌ Канал "${userText}" не найден.\n\n` +
        `📋 Доступные ${channelTypeName} каналы:\n${channelsList}\n\n` +
        `💡 Для удаления введите:\n` +
        `• Номер из списка (1, 2, 3...)\n` +
        `• ID канала\n` +
        `• @username канала\n` +
        `• Название канала`,
        backMenu
      );
      return false;
    }

    // ВЫПОЛНЯЕМ УДАЛЕНИЕ
    const channelInfo = `"${channelToRemove.channel_title || channelToRemove.channel_username || channelToRemove.channel_id}"`;
    console.log(`🗑️ ВЫПОЛНЯЕМ УДАЛЕНИЕ КАНАЛА: ${channelInfo} (ID: ${channelToRemove.channel_id})`);
    
    // Удаляем канал
    const removeResult = await removeChannelFunc(channelToRemove.channel_id);
    console.log(`📊 РЕЗУЛЬТАТ УДАЛЕНИЯ: ${removeResult} изменений`);

    // Проверяем результат
    if (removeResult > 0) {
      console.log(`✅ УСПЕХ: КАНАЛ УДАЛЕН ИЗ БАЗЫ ДАННЫХ!`);
      await ctx.reply(`✅ ${channelTypeName} канал ${channelInfo} удален!`, successMenu);
      return true;
    } else {
      console.log(`❌ ОШИБКА: КАНАЛ НЕ БЫЛ УДАЛЕН ИЗ БАЗЫ!`);
      await ctx.reply(`❌ Ошибка: не удалось удалить канал ${channelInfo} из базы данных`, successMenu);
      return false;
    }

  } catch (error) {
    console.error(`❌ ОШИБКА ПРИ УДАЛЕНИИ ${channelTypeName} КАНАЛА:`, error);
    await ctx.reply(`❌ Произошла ошибка при удалении канала: ${error.message}`, successMenu);
    return false;
  }
}

// 🎛️ ОБРАБОТЧИКИ КОМАНД МЕНЮ

// 🚀 СТАРТОВАЯ КОМАНДА
bot.command('start', (ctx) => {
  const welcomeMessage = `
🤖 **Добро пожаловать в News Bot!**

🌍 **Мощный бот для автоматизации новостей:**

📰 **Поиск новостей:**
• На всех языках мира
• Из NewsAPI и RSS-лент
• По вашим ключевым словам

🔍 **Мониторинг каналов:**
• Отслеживание Telegram-каналов
• Автопересылка по ключевым словам
• Защита от дублирования

🎯 **Множественные каналы:**
• Добавляйте несколько целевых каналов
• Автоотправка во все каналы сразу
• Гибкая настройка

📋 **Используйте кнопки ниже для управления:**`;
  
  ctx.reply(welcomeMessage, { parse_mode: 'Markdown', ...mainMenu });
});

// 🏠 ГЛАВНОЕ МЕНЮ
bot.hears('🏠 Главное меню', (ctx) => {
  userStates.delete(ctx.from.id);
  ctx.reply('🏠 Вы в главном меню:', mainMenu);
});

// 🔑 РАЗДЕЛ КЛЮЧЕВЫХ СЛОВ
bot.hears('📋 Ключевые слова', (ctx) => {
  ctx.reply('🔑 Управление ключевыми словами для поиска:', keywordsMenu);
});

bot.hears('📝 Добавить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_add');
  ctx.reply('📝 Введите ключевое слово для добавления:', backMenu);
});

bot.hears('🗑️ Удалить ключевое слово', async (ctx) => {
  const keywords = await db.getKeywords();
  if (keywords.length === 0) {
    return ctx.reply('📭 Список ключевых слов пуст', keywordsMenu);
  }
  
  userStates.set(ctx.from.id, 'waiting_for_keyword_remove');
  ctx.reply(`🗑️ Введите ключевое слово для удаления:\n\nТекущие слова:\n${keywords.map(kw => `• ${kw}`).join('\n')}`, backMenu);
});

bot.hears('📋 Список ключевых слов', async (ctx) => {
  try {
    const keywords = await db.getKeywords();
    if (keywords.length === 0) {
      return ctx.reply('📭 Список ключевых слов пуст', keywordsMenu);
    }
    
    ctx.reply(`📋 Ключевые слова (поиск на всех языках):\n\n${keywords.map(kw => `• ${kw}`).join('\n')}`, keywordsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении списка ключевых слов', keywordsMenu);
  }
});

// 🎯 РАЗДЕЛ ЦЕЛЕВЫХ КАНАЛОВ (куда отправляем)
bot.hears('🎯 Целевые каналы', (ctx) => {
  ctx.reply('🎯 Управление каналами для отправки новостей:', targetChannelsMenu);
});

bot.hears('➕ Добавить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_add');
  ctx.reply('🎯 Перешлите любое сообщение из канала, куда бот должен отправлять новости, или отправьте @username канала:', backMenu);
});

// 🎯 ОБРАБОТЧИК ДЛЯ УДАЛЕНИЯ ЦЕЛЕВОГО КАНАЛА
bot.hears('➖ Удалить целевой канал', async (ctx) => {
  try {
    const channels = await db.getTargetChannels();
    console.log(`📊 Запрос на удаление целевого канала. Всего каналов: ${channels.length}`);
    
    if (channels.length === 0) {
      return ctx.reply('📭 Нет целевых каналов для удаления', targetChannelsMenu);
    }
    
    userStates.set(ctx.from.id, 'waiting_for_target_channel_remove');
    
    const channelsList = channels.map((ch, index) => {
      let info = `${index + 1}. `;
      if (ch.channel_title) info += `"${ch.channel_title}"`;
      if (ch.channel_username) info += ` (@${ch.channel_username})`;
      info += ` - ID: ${ch.channel_id}`;
      return info;
    }).join('\n');
    
    await ctx.reply(
      `🗑️ <b>Удаление целевого канала</b>\n\n` +
      `📋 <b>Доступные каналы:</b>\n${channelsList}\n\n` +
      `💡 <b>Для удаления введите:</b>\n` +
      `• <b>Номер</b> из списка (1, 2, 3...)\n` +
      `• <b>ID</b> канала\n` +
      `• <b>@username</b> канала\n` +
      `• <b>Название</b> канала\n\n` +
      `<i>Пример: "1" или "@my_channel" или "Мой Канал"</i>`,
      { parse_mode: 'HTML', ...backMenu }
    );
  } catch (error) {
    console.error('❌ Ошибка при получении списка целевых каналов:', error);
    await ctx.reply('❌ Ошибка при получении списка каналов', targetChannelsMenu);
  }
});

bot.hears('📋 Список целевых каналов', async (ctx) => {
  try {
    const channels = await db.getTargetChannels();
    if (channels.length === 0) {
      return ctx.reply('📭 Нет целевых каналов', targetChannelsMenu);
    }
    
    const channelsList = channels.map((ch, index) => 
      `${index + 1}. ${ch.channel_title || 'Без названия'}\n   📍 ID: ${ch.channel_id}${ch.channel_username ? `\n   👤 @${ch.channel_username}` : ''}`
    ).join('\n\n');
    
    ctx.reply(`🎯 Целевые каналы:\n\n${channelsList}`, targetChannelsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении списка каналов', targetChannelsMenu);
  }
});

// 📡 РАЗДЕЛ ОТСЛЕЖИВАЕМЫХ КАНАЛОВ (откуда берем)
bot.hears('🌐 Мониторинг каналов', (ctx) => {
  ctx.reply('🌐 Управление отслеживаемыми каналами:', monitoredChannelsMenu);
});

bot.hears('➕ Добавить канал для отслеживания', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_add');
  ctx.reply('🌐 Перешлите любое сообщение из канала, который хотите отслеживать, или отправьте @username канала:', backMenu);
});

// 🌐 ОБРАБОТЧИК ДЛЯ УДАЛЕНИЯ ОТСЛЕЖИВАЕМОГО КАНАЛА
bot.hears('➖ Удалить канал отслеживания', async (ctx) => {
  try {
    const channels = await db.getMonitoredChannels();
    console.log(`📊 Запрос на удаление отслеживаемого канала. Всего каналов: ${channels.length}`);
    
    if (channels.length === 0) {
      return ctx.reply('📭 Нет отслеживаемых каналов для удаления', monitoredChannelsMenu);
    }
    
    userStates.set(ctx.from.id, 'waiting_for_monitored_channel_remove');
    
    const channelsList = channels.map((ch, index) => {
      let info = `${index + 1}. `;
      if (ch.channel_title) info += `"${ch.channel_title}"`;
      if (ch.channel_username) info += ` (@${ch.channel_username})`;
      info += ` - ID: ${ch.channel_id}`;
      return info;
    }).join('\n');
    
    await ctx.reply(
      `🗑️ <b>Удаление отслеживаемого канала</b>\n\n` +
      `📋 <b>Доступные каналы:</b>\n${channelsList}\n\n` +
      `💡 <b>Для удаления введите:</b>\n` +
      `• <b>Номер</b> из списка (1, 2, 3...)\n` +
      `• <b>ID</b> канала\n` +
      `• <b>@username</b> канала\n` +
      `• <b>Название</b> канала\n\n` +
      `<i>Пример: "1" или "@my_channel" или "Мой Канал"</i>`,
      { parse_mode: 'HTML', ...backMenu }
    );
  } catch (error) {
    console.error('❌ Ошибка при получении списка отслеживаемых каналов:', error);
    await ctx.reply('❌ Ошибка при получении списка каналов', monitoredChannelsMenu);
  }
});

bot.hears('📋 Список отслеживаемых каналов', async (ctx) => {
  try {
    const channels = await db.getMonitoredChannels();
    if (channels.length === 0) {
      return ctx.reply('📭 Нет отслеживаемых каналов', monitoredChannelsMenu);
    }
    
    const channelsList = channels.map((ch, index) => 
      `${index + 1}. ${ch.channel_title || 'Без названия'}\n   📍 ID: ${ch.channel_id}${ch.channel_username ? `\n   👤 @${ch.channel_username}` : ''}`
    ).join('\n\n');
    
    ctx.reply(`🌐 Отслеживаемые каналы:\n\n${channelsList}`, monitoredChannelsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении списка каналов', monitoredChannelsMenu);
  }
});

bot.hears('🔧 Вкл/Выкл мониторинг', async (ctx) => {
  try {
    const current = await db.getSetting('channel_monitoring_enabled');
    const newValue = current === 'true' ? 'false' : 'true';
    
    await db.setSetting('channel_monitoring_enabled', newValue);
    ctx.reply(`✅ Мониторинг каналов ${newValue === 'true' ? 'включен' : 'выключен'}`, monitoredChannelsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при переключении мониторинга', monitoredChannelsMenu);
  }
});

// 🔍 ПОИСК НОВОСТЕЙ
bot.hears('🔍 Найти новости', async (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_news_count');
  ctx.reply('🔢 Сколько новостей отправить? (1-5):', backMenu);
});

bot.hears('🔄 Тестовый поиск', async (ctx) => {
  try {
    await ctx.reply('🔍 Тестовый поиск новостей на всех языках...', mainMenu);
    const news = await newsService.getFilteredNews();
    
    if (news.length === 0) {
      return ctx.reply('📭 Новостей не найдено', mainMenu);
    }
    
    const testNews = news.slice(0, 3);
    let response = `🔍 Найдено ${news.length} новостей. Примеры:\n\n`;
    
    testNews.forEach((item, index) => {
      response += `${index + 1}. ${item.title}\n`;
      response += `   📍 ${item.source?.name || 'Неизвестно'}\n\n`;
    });
    
    ctx.reply(response, mainMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при тестовом поиске новостей', mainMenu);
  }
});

// ⚙️ НАСТРОЙКИ
bot.hears('⚙️ Настройки', (ctx) => {
  ctx.reply('⚙️ Настройки бота:', settingsMenu);
});

bot.hears('⏰ Изменить интервал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_interval');
  ctx.reply('⏰ Введите интервал проверки в минутах (минимум 5):', backMenu);
});

bot.hears('🔧 Вкл/Выкл автопостинг', async (ctx) => {
  try {
    const current = await db.getSetting('auto_post_enabled');
    const newValue = current === 'true' ? 'false' : 'true';
    
    await db.setSetting('auto_post_enabled', newValue);
    ctx.reply(`✅ Автопостинг ${newValue === 'true' ? 'включен' : 'выключен'}`, settingsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при переключении автопостинга', settingsMenu);
  }
});

// 📊 СТАТИСТИКА
bot.hears('📊 Статистика', async (ctx) => {
  try {
    const keywords = await db.getKeywords();
    const monitoredChannels = await db.getMonitoredChannels();
    const targetChannels = await db.getTargetChannels();
    const autoPost = await db.getSetting('auto_post_enabled');
    const monitoring = await db.getSetting('channel_monitoring_enabled');
    const interval = await db.getSetting('check_interval');
    
    ctx.reply(
      `📊 **Статистика бота:**\n\n` +
      `🔑 **Ключевых слов:** ${keywords.length}\n` +
      `🎯 **Целевых каналов:** ${targetChannels.length}\n` +
      `🌐 **Отслеживаемых каналов:** ${monitoredChannels.length}\n` +
      `🔧 **Автопостинг:** ${autoPost === 'true' ? 'включен' : 'выключен'}\n` +
      `👁️ **Мониторинг каналов:** ${monitoring === 'true' ? 'включен' : 'выключен'}\n` +
      `⏰ **Интервал проверки:** ${interval} минут\n` +
      `🌍 **Поиск:** Все языки мира`,
      mainMenu
    );
  } catch (error) {
    ctx.reply('❌ Ошибка при получении статистики', mainMenu);
  }
});

// 📨 ОБРАБОТКА ПЕРЕСЛАННЫХ СООБЩЕНИЙ ДЛЯ ДОБАВЛЕНИЯ КАНАЛОВ
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  
  // Обработка пересланных сообщений для добавления каналов
  if ((state === 'waiting_for_target_channel_add' || state === 'waiting_for_monitored_channel_add') && 
      ctx.message.forward_from_chat) {
    
    const chat = ctx.message.forward_from_chat;
    if (chat.type === 'channel') {
      try {
        if (state === 'waiting_for_target_channel_add') {
          await db.addTargetChannel(chat.id.toString(), chat.username, chat.title);
          userStates.delete(userId);
          ctx.reply(`✅ Целевой канал "${chat.title}" (@${chat.username || chat.id}) добавлен!`, targetChannelsMenu);
        } else {
          await db.addMonitoredChannel(chat.id.toString(), chat.username, chat.title);
          userStates.delete(userId);
          ctx.reply(`✅ Канал для отслеживания "${chat.title}" (@${chat.username || chat.id}) добавлен!`, monitoredChannelsMenu);
        }
      } catch (error) {
        ctx.reply('❌ Ошибка при добавлении канала', state === 'waiting_for_target_channel_add' ? targetChannelsMenu : monitoredChannelsMenu);
      }
    } else {
      ctx.reply('❌ Это не канал! Перешлите сообщение из Telegram-канала.', backMenu);
    }
    return;
  }
});

// 📝 ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ (для состояний)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userText = ctx.message.text;
  const state = userStates.get(userId);

  // Если нет активного состояния, показываем меню
  if (!state) {
    return ctx.reply('Используйте кнопки меню для управления ботом:', mainMenu);
  }

  try {
    switch (state) {
      // 🔑 ДОБАВЛЕНИЕ КЛЮЧЕВОГО СЛОВА
      case 'waiting_for_keyword_add':
        if (userText === '🏠 Главное меню') {
          userStates.delete(userId);
          return ctx.reply('🏠 Вы в главном меню:', mainMenu);
        }
        
        const result = await db.addKeyword(userText);
        if (result > 0) {
          ctx.reply(`✅ Ключевое слово "${userText}" добавлено!`, keywordsMenu);
        } else {
          ctx.reply(`ℹ️ Ключевое слово "${userText}" уже существует`, keywordsMenu);
        }
        userStates.delete(userId);
        break;

      // 🔑 УДАЛЕНИЕ КЛЮЧЕВОГО СЛОВА
      case 'waiting_for_keyword_remove':
        if (userText === '🏠 Главное меню') {
          userStates.delete(userId);
          return ctx.reply('🏠 Вы в главном меню:', mainMenu);
        }
        
        const removeResult = await db.removeKeyword(userText);
        if (removeResult > 0) {
          ctx.reply(`✅ Ключевое слово "${userText}" удалено`, keywordsMenu);
        } else {
          ctx.reply(`❌ Ключевое слово "${userText}" не найдено`, keywordsMenu);
        }
        userStates.delete(userId);
        break;

      // 🎯 ДОБАВЛЕНИЕ ЦЕЛЕВОГО КАНАЛА ПО USERNAME
      case 'waiting_for_target_channel_add':
        if (userText === '🏠 Главное меню') {
          userStates.delete(userId);
          return ctx.reply('🏠 Вы в главном меню:', mainMenu);
        }
        
        // Обработка username канала
        if (userText.startsWith('@')) {
          try {
            const chat = await ctx.telegram.getChat(userText);
            if (chat.type === 'channel') {
              await db.addTargetChannel(chat.id.toString(), chat.username, chat.title);
              userStates.delete(userId);
              ctx.reply(`✅ Целевой канал "${chat.title}" добавлен!`, targetChannelsMenu);
            } else {
              ctx.reply('❌ Это не канал! Укажите @username канала.', backMenu);
            }
          } catch (error) {
            ctx.reply('❌ Не удалось найти канал. Убедитесь, что бот добавлен в канал как администратор.', backMenu);
          }
        } else {
          ctx.reply('❌ Укажите @username канала (начинается с @) или перешлите сообщение из канала.', backMenu);
        }
        break;

      // 🎯 УДАЛЕНИЕ ЦЕЛЕВОГО КАНАЛА
      case 'waiting_for_target_channel_remove':
        if (userText === '🏠 Главное меню') {
          userStates.delete(userId);
          return ctx.reply('🏠 Вы в главном меню:', mainMenu);
        }
        
        console.log(`🎯 Начало обработки удаления целевого канала: "${userText}"`);
        const targetSuccess = await removeChannelWithDebug(ctx, userText, 'target');
        if (targetSuccess) {
          userStates.delete(userId);
        }
        break;

      // 🌐 ДОБАВЛЕНИЕ ОТСЛЕЖИВАЕМОГО КАНАЛА ПО USERNAME
      case 'waiting_for_monitored_channel_add':
        if (userText === '🏠 Главное меню') {
          userStates.delete(userId);
          return ctx.reply('🏠 Вы в главном меню:', mainMenu);
        }
        
        if (userText.startsWith('@')) {
          try {
            const chat = await ctx.telegram.getChat(userText);
            if (chat.type === 'channel') {
              await db.addMonitoredChannel(chat.id.toString(), chat.username, chat.title);
              userStates.delete(userId);
              ctx.reply(`✅ Канал для отслеживания "${chat.title}" добавлен!`, monitoredChannelsMenu);
            } else {
              ctx.reply('❌ Это не канал! Укажите @username канала.', backMenu);
            }
          } catch (error) {
            ctx.reply('❌ Не удалось найти канал.', backMenu);
          }
        } else {
          ctx.reply('❌ Укажите @username канала (начинается с @) или перешлите сообщение из канала.', backMenu);
        }
        break;

      // 🌐 УДАЛЕНИЕ ОТСЛЕЖИВАЕМОГО КАНАЛА
      case 'waiting_for_monitored_channel_remove':
        if (userText === '🏠 Главное меню') {
          userStates.delete(userId);
          return ctx.reply('🏠 Вы в главном меню:', mainMenu);
        }
        
        console.log(`🌐 Начало обработки удаления отслеживаемого канала: "${userText}"`);
        const monitoredSuccess = await removeChannelWithDebug(ctx, userText, 'monitored');
        if (monitoredSuccess) {
          userStates.delete(userId);
        }
        break;

      // 🔍 ОТПРАВКА НОВОСТЕЙ
      case 'waiting_for_news_count':
        if (userText === '🏠 Главное меню') {
          userStates.delete(userId);
          return ctx.reply('🏠 Вы в главном меню:', mainMenu);
        }
        
        const count = parseInt(userText);
        if (isNaN(count) || count < 1 || count > 5) {
          return ctx.reply('❌ Введите число от 1 до 5:', backMenu);
        }
        
        await ctx.reply(`🔍 Поиск ${count} новостей...`, mainMenu);
        const news = await newsService.getFilteredNews();
        
        if (news.length === 0) {
          ctx.reply('📭 Новых новостей не найдено', mainMenu);
        } else {
          const newsToSend = news.slice(0, count);
          let sentCount = 0;
          
          for (const newsItem of newsToSend) {
            const success = await sendNewsToChannels(newsItem);
            if (success) sentCount++;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
          ctx.reply(`✅ Отправлено ${sentCount} новостей во все целевые каналы`, mainMenu);
        }
        userStates.delete(userId);
        break;

      // ⏰ ИЗМЕНЕНИЕ ИНТЕРВАЛА
      case 'waiting_for_interval':
        if (userText === '🏠 Главное меню') {
          userStates.delete(userId);
          return ctx.reply('🏠 Вы в главном меню:', mainMenu);
        }
        
        const minutes = parseInt(userText);
        if (!minutes || minutes < 5) {
          return ctx.reply('❌ Введите число (минимум 5):', backMenu);
        }
        
        await db.setSetting('check_interval', minutes.toString());
        clearInterval(autoPostInterval);
        autoPostInterval = setInterval(autoPostNews, minutes * 60 * 1000);
        ctx.reply(`✅ Интервал проверки установлен на ${minutes} минут`, settingsMenu);
        userStates.delete(userId);
        break;

      default:
        userStates.delete(userId);
        ctx.reply('Используйте кнопки меню для управления ботом:', mainMenu);
    }
  } catch (error) {
    console.error('❌ Общая ошибка обработки сообщения:', error);
    await ctx.reply('❌ Произошла ошибка. Попробуйте снова.', mainMenu);
    userStates.delete(userId);
  }
});

// 🔧 КОМАНДА ДЛЯ ОТЛАДКИ БАЗЫ ДАННЫХ
bot.command('debug_channels', async (ctx) => {
  try {
    const targetChannels = await db.getTargetChannels();
    const monitoredChannels = await db.getMonitoredChannels();
    
    let debugInfo = `🔧 <b>Отладочная информация о каналах</b>\n\n`;
    
    debugInfo += `<b>🎯 Целевые каналы (${targetChannels.length}):</b>\n`;
    if (targetChannels.length === 0) {
      debugInfo += `   Нет целевых каналов\n\n`;
    } else {
      targetChannels.forEach((ch, index) => {
        debugInfo += `   ${index + 1}. ID: <code>${ch.channel_id}</code>\n`;
        debugInfo += `      Title: "${ch.channel_title || 'нет'}"\n`;
        debugInfo += `      Username: @${ch.channel_username || 'нет'}\n\n`;
      });
    }
    
    debugInfo += `<b>🌐 Отслеживаемые каналы (${monitoredChannels.length}):</b>\n`;
    if (monitoredChannels.length === 0) {
      debugInfo += `   Нет отслеживаемых каналов\n`;
    } else {
      monitoredChannels.forEach((ch, index) => {
        debugInfo += `   ${index + 1}. ID: <code>${ch.channel_id}</code>\n`;
        debugInfo += `      Title: "${ch.channel_title || 'нет'}"\n`;
        debugInfo += `      Username: @${ch.channel_username || 'нет'}\n\n`;
      });
    }
    
    await ctx.reply(debugInfo, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(`❌ Ошибка отладки: ${error.message}`);
  }
});

// 🚀 ЗАПУСК БОТА
let autoPostInterval;

async function startBot() {
  try {
    console.log('🚀 Запуск бота с ИСПРАВЛЕННЫМ УДАЛЕНИЕМ КАНАЛОВ...');
    console.log('🌍 Режим: поиск на всех языках + мониторинг каналов + множественные целевые каналы');
    
    // Инициализация базы данных
    await db.initializeDB();
    console.log('✅ База данных инициализирована');
    
    // Получение информации о боте
    await getBotInfo();
    
    // Проверка прав бота в целевых каналах
    const isAdmin = await checkBotAdmin();
    if (!isAdmin) {
      console.log('⚠️  Продолжаем запуск, но отправка в некоторые каналы может не работать');
    }
    
    // Запуск бота
    await bot.launch();
    console.log('✅ Бот запущен');
    
    // Загружаем информацию о каналах
    const targetChannels = await db.getTargetChannels();
    const monitoredChannels = await db.getMonitoredChannels();
    console.log(`✅ Загружено: ${targetChannels.length} целевых каналов, ${monitoredChannels.length} отслеживаемых каналов`);
    
    // Настройка автоматической проверки новостей
    const interval = parseInt(await db.getSetting('check_interval')) || config.DEFAULT_INTERVAL;
    autoPostInterval = setInterval(autoPostNews, interval * 60 * 1000);
    console.log(`✅ Автопостинг настроен с интервалом ${interval} минут`);
    
    // Настройка ежедневной отправки топ новостей
    cron.schedule(config.DAILY_TOP_NEWS_TIME, sendTopNews);
    console.log('✅ Ежедневная отправка топ новостей настроена');
    
    // Первоначальная проверка новостей
    setTimeout(autoPostNews, 5000);
    
    console.log('\n🎉 Бот успешно запущен!');
    console.log('💡 Теперь доступны:');
    console.log('   🌍 Поиск новостей на всех языках');
    console.log('   🎯 Множественные целевые каналы');
    console.log('   🌐 Мониторинг Telegram-каналов');
    console.log('   📱 Удобное меню с кнопками');
    console.log('   🐛 Команда /debug_channels для отладки');
    console.log('   🔧 ИСПРАВЛЕННОЕ УДАЛЕНИЕ КАНАЛОВ!');
    
  } catch (error) {
    console.error('❌ Критическая ошибка при запуске бота:', error);
    process.exit(1);
  }
}

// 🛑 GRACEFUL SHUTDOWN - корректная остановка бота
process.once('SIGINT', () => {
  console.log('\n🛑 Остановка бота...');
  clearInterval(autoPostInterval);
  bot.stop('SIGINT');
  console.log('👋 Бот остановлен');
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Остановка бота...');
  clearInterval(autoPostInterval);
  bot.stop('SIGTERM');
  console.log('👋 Бот остановлен');
});

// 🚀 ЗАПУСК ПРИЛОЖЕНИЯ
startBot();