// ==========================
// 🤖 TELEGRAM BOT
// ==========================
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const config = require('./config');
const newsService = require('./newsService');
const fs = require('fs');
const path = require('path');

// Логирование в файл
const logStream = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'a' });
function log(msg) {
  const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
  const logMsg = `[${timestamp}] ${msg}\n`;
  logStream.write(logMsg);
  console.log(logMsg);
}

// Инициализация бота
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// Временное хранение состояния пользователя (например, ожидание ввода)
const userStates = new Map();

// Главное меню
const mainMenu = Markup.keyboard([
  ['📈 Статистика', '🗝️ Ключевые слова'],
  ['🎯 Целевые каналы', '📡 Мониторинг каналов'],
  ['🔄 Запустить пересылку', '⏹️ Остановить пересылку']
]).resize();

// Меню ключевых слов
const keywordsMenu = Markup.keyboard([
  ['➕ Добавить ключевое слово', '🗑️ Удалить ключевое слово'],
  ['⬅️ Назад']
]).resize();

// Меню целевых каналов
const targetChannelsMenu = Markup.keyboard([
  ['➕ Добавить целевой канал', '🗑️ Удалить целевой канал'],
  ['⬅️ Назад']
]).resize();

// Меню мониторинга каналов
const monitoredChannelsMenu = Markup.keyboard([
  ['➕ Добавить отслеживаемый канал', '🗑️ Удалить отслеживаемый канал'],
  ['⬅️ Назад']
]).resize();

// Флаг активности пересылки
let isForwardingActive = false;

// ==========================
// 🔄 ФУНКЦИИ ПЕРЕСЫЛКИ И ОТПРАВКИ
// ==========================

// Функция для отправки сообщения в целевые каналы
async function sendMessageToTargetChannels(message, options = {}) {
  try {
    const targetChannels = await db.getTargetChannels();
    
    if (targetChannels.length === 0) {
      log('⚠️ Нет целевых каналов для отправки сообщения');
      return false;
    }

    let successCount = 0;
    for (const targetChannel of targetChannels) {
      try {
        await bot.telegram.sendMessage(targetChannel.channel_id, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: false,
          ...options
        });
        log(`✅ Отправлено сообщение в канал ${targetChannel.channel_title || targetChannel.channel_id}`);
        successCount++;
        
        // Задержка между отправками чтобы избежать лимитов
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        log(`❌ Ошибка отправки в канал ${targetChannel.channel_id}: ${error.message}`);
        
        // Если ошибка связана с правами, удаляем канал из базы
        if (error.description && (
          error.description.includes('bot was blocked') || 
          error.description.includes('chat not found') ||
          error.description.includes('no rights')
        )) {
          log(`🗑️ Удаляем недоступный канал: ${targetChannel.channel_id}`);
          await db.removeTargetChannel(targetChannel.channel_id);
        }
      }
    }
    
    return successCount > 0;
  } catch (error) {
    log(`❌ Критическая ошибка в sendMessageToTargetChannels: ${error.message}`);
    return false;
  }
}

// Функция для пересылки сообщений из отслеживаемых каналов
async function forwardMessageFromChannel(channelId, messageId) {
  try {
    const targetChannels = await db.getTargetChannels();
    const isAlreadyForwarded = await db.isMessageForwarded(messageId, channelId);
    
    if (isAlreadyForwarded) {
      log(`⚠️ Сообщение ${messageId} из канала ${channelId} уже было переслано`);
      return;
    }

    if (targetChannels.length === 0) {
      log('⚠️ Нет целевых каналов для пересылки');
      return;
    }

    // Получаем ключевые слова для фильтрации
    const keywords = await db.getKeywords();
    
    // Если есть ключевые слова, нужно получить текст сообщения для проверки
    let shouldForward = true;
    if (keywords.length > 0) {
      try {
        // Пытаемся получить сообщение для проверки текста
        const message = await bot.telegram.getMessage(channelId, messageId);
        const messageText = (message.text || message.caption || '').toLowerCase();
        
        if (messageText) {
          const hasKeyword = keywords.some(keyword => 
            messageText.includes(keyword.toLowerCase())
          );
          if (!hasKeyword) {
            log(`⏩ Сообщение ${messageId} не содержит ключевых слов, пропускаем`);
            shouldForward = false;
          }
        }
      } catch (error) {
        log(`⚠️ Не удалось проверить ключевые слова для сообщения ${messageId}: ${error.message}`);
      }
    }

    if (!shouldForward) return;

    let successCount = 0;
    for (const targetChannel of targetChannels) {
      try {
        await bot.telegram.forwardMessage(
          targetChannel.channel_id,
          channelId,
          messageId
        );
        log(`✅ Переслано сообщение ${messageId} в канал ${targetChannel.channel_title || targetChannel.channel_id}`);
        successCount++;
        
        // Задержка между отправками чтобы избежать лимитов
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        log(`❌ Ошибка пересылки в канал ${targetChannel.channel_id}: ${error.message}`);
        
        // Если ошибка связана с правами, удаляем канал из базы
        if (error.description && (
          error.description.includes('bot was blocked') || 
          error.description.includes('chat not found') ||
          error.description.includes('no rights')
        )) {
          log(`🗑️ Удаляем недоступный целевой канал: ${targetChannel.channel_id}`);
          await db.removeTargetChannel(targetChannel.channel_id);
        }
      }
    }
    
    // Если хотя бы одна пересылка успешна, отмечаем сообщение как пересланное
    if (successCount > 0) {
      await db.addForwardedMessage(messageId, channelId);
    }
    
  } catch (error) {
    log(`❌ Ошибка в forwardMessageFromChannel: ${error.message}`);
  }
}

// ==========================
// 🔧 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================

// Функция для получения информации о канале
async function getChannelInfo(channelIdentifier) {
  try {
    // Удаляем @ если есть
    const cleanIdentifier = channelIdentifier.replace('@', '');
    
    // Пробуем получить информацию о канале
    const chat = await bot.telegram.getChat(`@${cleanIdentifier}`);
    
    return {
      id: chat.id.toString(),
      username: chat.username ? `@${chat.username}` : null,
      title: chat.title,
      type: chat.type
    };
  } catch (error) {
    log(`⚠️ Не удалось получить информацию о канале ${channelIdentifier}: ${error.message}`);
    
    // Если не удалось получить информацию, используем идентификатор как ID
    return {
      id: channelIdentifier,
      username: channelIdentifier.startsWith('@') ? channelIdentifier : null,
      title: channelIdentifier,
      type: 'channel'
    };
  }
}

// Функция для добавления канала с получением информации
async function addChannelWithInfo(channelIdentifier, channelType) {
  try {
    const channelInfo = await getChannelInfo(channelIdentifier);
    
    let result;
    if (channelType === 'target') {
      result = await db.addTargetChannel(channelInfo.id, channelInfo.username, channelInfo.title);
    } else {
      result = await db.addMonitoredChannel(channelInfo.id, channelInfo.username, channelInfo.title);
    }
    
    return {
      success: result > 0,
      channelInfo: channelInfo,
      message: result > 0 ? 
        `✅ Канал "${channelInfo.title || channelInfo.username || channelInfo.id}" добавлен как ${channelType === 'target' ? 'целевой' : 'отслеживаемый'}` :
        `⚠️ Канал "${channelIdentifier}" уже существует в базе`
    };
  } catch (error) {
    log(`❌ Ошибка добавления канала ${channelIdentifier}: ${error.message}`);
    return {
      success: false,
      message: `❌ Ошибка добавления канала: ${error.message}`
    };
  }
}

// Улучшенная функция удаления каналов
async function removeChannelWithDebug(ctx, userText, type) {
  const isTarget = type === 'target';
  const getFunc = isTarget ? db.getTargetChannels : db.getMonitoredChannels;
  const removeFunc = isTarget ? db.removeTargetChannel : db.removeMonitoredChannel;
  const menu = isTarget ? targetChannelsMenu : monitoredChannelsMenu;

  try {
    const allChannels = await getFunc();
    const cleanInput = userText.replace('@', '').toLowerCase().trim();

    if (allChannels.length === 0) {
      ctx.reply(`❌ Нет ${isTarget ? 'целевых' : 'отслеживаемых'} каналов для удаления.`, menu);
      return;
    }

    log(`🔍 Поиск канала для удаления: "${userText}" (очищенный: "${cleanInput}")`);
    log(`📋 Всего каналов в базе: ${allChannels.length}`);

    const found = allChannels.find(ch => {
      const id = ch.channel_id?.toString().toLowerCase().trim() || '';
      const username = ch.channel_username?.replace('@', '').toLowerCase().trim() || '';
      const title = ch.channel_title?.toLowerCase().trim() || '';
      
      const match = id.includes(cleanInput) ||
                   username.includes(cleanInput) ||
                   title.includes(cleanInput);
      
      if (match) {
        log(`🎯 Найден канал: ID="${id}", username="${username}", title="${title}"`);
      }
      
      return match;
    });

    if (!found) {
      const availableChannels = allChannels.map(ch => 
        `- ${ch.channel_title || 'Без названия'} (${ch.channel_username || ch.channel_id})`
      ).join('\n');
      
      ctx.reply(
        `❌ Канал "${userText}" не найден.\n\nДоступные каналы:\n${availableChannels}`,
        menu
      );
      return;
    }

    log(`🗑️ Удаляем канал: ${found.channel_id}`);
    const removed = await removeFunc(found.channel_id);
    
    if (removed > 0) {
      ctx.reply(
        `✅ Канал "${found.channel_title || found.channel_username || found.channel_id}" удалён.`,
        menu
      );
    } else {
      ctx.reply(`⚠️ Не удалось удалить канал "${userText}".`, menu);
    }
  } catch (err) {
    log(`❌ Ошибка при удалении канала: ${err.message}`);
    ctx.reply('❌ Произошла ошибка при удалении канала. Проверьте лог.', menu);
  }
}

// ==========================
// ⚙️ ОБРАБОТЧИКИ КОМАНД
// ==========================

bot.start(async (ctx) => {
  try {
    await db.initializeDB();
    // Инициализируем newsService после установки sendFunction
    newsService.setSendFunction(sendMessageToTargetChannels);
    ctx.reply('👋 Привет! Я бот для мониторинга и пересылки новостей.', mainMenu);
  } catch (error) {
    log(`❌ Ошибка в команде start: ${error.message}`);
    ctx.reply('❌ Произошла ошибка при инициализации бота.');
  }
});

// Главное меню
bot.hears('⬅️ Назад', (ctx) => ctx.reply('🏠 Главное меню', mainMenu));

// Запуск пересылки
bot.hears('🔄 Запустить пересылку', async (ctx) => {
  isForwardingActive = true;
  newsService.setSendFunction(sendMessageToTargetChannels);
  await newsService.startMonitoring();
  ctx.reply('✅ Пересылка сообщений активирована! Бот теперь будет пересылать сообщения из отслеживаемых каналов и новости из RSS.', mainMenu);
  log('🔄 Пересылка сообщений активирована пользователем');
});

// Остановка пересылки
bot.hears('⏹️ Остановить пересылку', async (ctx) => {
  isForwardingActive = false;
  await newsService.stopMonitoring();
  ctx.reply('⏹️ Пересылка сообщений остановлена!', mainMenu);
  log('⏹️ Пересылка сообщений остановлена пользователем');
});

// Меню ключевых слов
bot.hears('🗝️ Ключевые слова', async (ctx) => {
  try {
    const keywords = await db.getKeywords();
    const list = keywords.length ? keywords.map(k => `🔹 ${k}`).join('\n') : '— нет —';
    ctx.reply(`📜 Текущие ключевые слова:\n${list}`, keywordsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении ключевых слов.');
  }
});

// Добавление ключевого слова
bot.hears('➕ Добавить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_add');
  ctx.reply('✏️ Введите ключевое слово для добавления:');
});

// Удаление ключевого слова
bot.hears('🗑️ Удалить ключевое слово', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_keyword_remove');
  ctx.reply('🗑️ Введите ключевое слово для удаления:');
});

// Меню целевых каналов
bot.hears('🎯 Целевые каналы', async (ctx) => {
  try {
    const channels = await db.getTargetChannels();
    const list = channels.length
      ? channels.map(c => `🔹 ${c.channel_title || 'Без названия'} (${c.channel_username || c.channel_id})`).join('\n')
      : '— нет —';
    ctx.reply(`🎯 Целевые каналы:\n${list}`, targetChannelsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении списка целевых каналов.');
  }
});

// Добавление целевого канала
bot.hears('➕ Добавить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_add');
  ctx.reply('✏️ Введите @username или ID целевого канала для добавления:\n\nУбедитесь, что бот добавлен в канал как администратор!');
});

// Удаление целевого канала
bot.hears('🗑️ Удалить целевой канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_target_channel_remove');
  ctx.reply('🗑️ Введите @username, ID или часть названия целевого канала для удаления:');
});

// Меню мониторинга каналов
bot.hears('📡 Мониторинг каналов', async (ctx) => {
  try {
    const channels = await db.getMonitoredChannels();
    const list = channels.length
      ? channels.map(c => `🔹 ${c.channel_title || 'Без названия'} (${c.channel_username || c.channel_id})`).join('\n')
      : '— нет —';
    ctx.reply(`📡 Отслеживаемые каналы:\n${list}`, monitoredChannelsMenu);
  } catch (error) {
    ctx.reply('❌ Ошибка при получении списка отслеживаемых каналов.');
  }
});

// Добавление отслеживаемого канала
bot.hears('➕ Добавить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_add');
  ctx.reply('✏️ Введите @username или ID канала для отслеживания:\n\nУбедитесь, что бот добавлен в канал!');
});

// Удаление отслеживаемого канала
bot.hears('🗑️ Удалить отслеживаемый канал', (ctx) => {
  userStates.set(ctx.from.id, 'waiting_for_monitored_channel_remove');
  ctx.reply('🗑️ Введите @username, ID или часть названия отслеживаемого канала для удаления:');
});

bot.hears('📈 Статистика', async (ctx) => {
  try {
    const keywordsCount = (await db.getKeywords()).length;
    const targetChannelsCount = (await db.getTargetChannels()).length;
    const monitoredChannelsCount = (await db.getMonitoredChannels()).length;
    const forwardedCount = await db.countForwardedMessages();
    const sentNewsCount = await db.countSentNews();

    const msg = `
📊 Статистика бота:

🗝️ Ключевых слов: ${keywordsCount}
🎯 Целевых каналов: ${targetChannelsCount}
📡 Отслеживаемых каналов: ${monitoredChannelsCount}
📤 Пересланных сообщений: ${forwardedCount}
📰 Отправленных новостей: ${sentNewsCount}
🔄 Пересылка: ${isForwardingActive ? '✅ Активна' : '❌ Остановлена'}
    `;
    ctx.reply(msg, mainMenu);

  } catch (err) {
    console.error('❌ Ошибка при получении статистики:', err);
    ctx.reply('⚠️ Не удалось получить статистику.');
  }
});

// ==========================
// 📨 ОБРАБОТКА СООБЩЕНИЙ ИЗ КАНАЛОВ
// ==========================

// Обработчик новых сообщений в каналах
bot.on('channel_post', async (ctx) => {
  if (!isForwardingActive) {
    log('⏹️ Пересылка отключена, игнорируем channel_post');
    return;
  }

  try {
    const channelPost = ctx.channelPost;
    if (!channelPost) return;

    const channelId = channelPost.chat.id.toString();
    const messageId = channelPost.message_id;

    log(`📨 Получен channel_post из канала ${channelPost.chat.title || channelId} (${channelId}): ${messageId}`);

    // Проверяем, отслеживается ли этот канал
    const monitoredChannels = await db.getMonitoredChannels();
    const isMonitored = monitoredChannels.some(ch => 
      ch.channel_id === channelId || 
      (ch.channel_username && channelPost.chat.username && ch.channel_username.replace('@', '') === channelPost.chat.username)
    );

    if (isMonitored) {
      log(`🎯 Канал ${channelId} отслеживается, пересылаем сообщение ${messageId}`);
      await forwardMessageFromChannel(channelId, messageId);
    } else {
      log(`⏩ Канал ${channelId} не отслеживается, пропускаем`);
    }
  } catch (error) {
    log(`❌ Ошибка обработки channel_post: ${error.message}`);
  }
});

// Альтернативный обработчик для сообщений из каналов
bot.on('message', async (ctx) => {
  // Пропускаем если это не сообщение из канала или пересылка отключена
  if (!isForwardingActive || !ctx.message || ctx.message.chat.type !== 'channel') {
    return;
  }

  try {
    const channelId = ctx.message.chat.id.toString();
    const messageId = ctx.message.message_id;

    log(`📨 Получено message из канала ${ctx.message.chat.title || channelId} (${channelId}): ${messageId}`);

    // Проверяем, отслеживается ли этот канал
    const monitoredChannels = await db.getMonitoredChannels();
    const isMonitored = monitoredChannels.some(ch => 
      ch.channel_id === channelId || 
      (ch.channel_username && ctx.message.chat.username && ch.channel_username.replace('@', '') === ctx.message.chat.username)
    );

    if (isMonitored) {
      log(`🎯 Канал ${channelId} отслеживается, пересылаем сообщение ${messageId}`);
      await forwardMessageFromChannel(channelId, messageId);
    }
  } catch (error) {
    log(`❌ Ошибка обработки сообщения из канала: ${error.message}`);
  }
});

// ==========================
// 🧠 ОБРАБОТКА ВВОДА ПОЛЬЗОВАТЕЛЯ
// ==========================
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  const text = ctx.message.text?.trim();
  
  // Пропускаем если нет текста или это сообщение из канала
  if (!text || (ctx.message.chat && ctx.message.chat.type === 'channel')) return;

  try {
    // ➕ Добавление ключевого слова
    if (state === 'waiting_for_keyword_add') {
      const added = await db.addKeyword(text);
      userStates.delete(userId);
      if (added > 0) {
        ctx.reply(`✅ Ключевое слово "${text}" добавлено.`, keywordsMenu);
      } else {
        ctx.reply(`⚠️ Слово "${text}" уже существует.`, keywordsMenu);
      }
      return;
    }

    // 🗑️ Удаление ключевого слова
    if (state === 'waiting_for_keyword_remove') {
      const keywords = await db.getKeywords();
      const keywordToRemove = keywords.find(k => k.toLowerCase() === text.toLowerCase());
      if (!keywordToRemove) {
        ctx.reply(`❌ Слово "${text}" не найдено.`, keywordsMenu);
      } else {
        await db.removeKeyword(keywordToRemove);
        ctx.reply(`✅ Ключевое слово "${keywordToRemove}" удалено.`, keywordsMenu);
      }
      userStates.delete(userId);
      return;
    }

    // ➕ Добавление целевого канала
    if (state === 'waiting_for_target_channel_add') {
      const result = await addChannelWithInfo(text, 'target');
      userStates.delete(userId);
      ctx.reply(result.message, targetChannelsMenu);
      return;
    }

    // ➕ Добавление отслеживаемого канала
    if (state === 'waiting_for_monitored_channel_add') {
      const result = await addChannelWithInfo(text, 'monitored');
      userStates.delete(userId);
      ctx.reply(result.message, monitoredChannelsMenu);
      return;
    }

    // 🗑️ Удаление целевого канала
    if (state === 'waiting_for_target_channel_remove') {
      await removeChannelWithDebug(ctx, text, 'target');
      userStates.delete(userId);
      return;
    }

    // 🗑️ Удаление отслеживаемого канала
    if (state === 'waiting_for_monitored_channel_remove') {
      await removeChannelWithDebug(ctx, text, 'monitored');
      userStates.delete(userId);
      return;
    }

  } catch (err) {
    console.error('❌ Ошибка при обработке ввода:', err);
    ctx.reply('⚠️ Произошла ошибка. Проверьте лог.');
  }
});

// ==========================
// 🚀 ЗАПУСК
// ==========================
async function startBot() {
  try {
    log('🚀 Запуск бота...');
    
    // Сначала инициализируем базу данных
    await db.initializeDB();
    log('✅ База данных инициализирована');
    
    // Затем инициализируем newsService без передачи функции
    await newsService.initialize();
    log('✅ Сервис новостей инициализирован');
    
    // Запускаем бота
    await bot.launch();
    log('✅ Бот запущен и готов к работе.');
    
    // Устанавливаем функцию отправки после запуска бота
    newsService.setSendFunction(sendMessageToTargetChannels);
    log('✅ Функция отправки установлена');
    
    // Тестовая отправка при запуске
    const targetChannels = await db.getTargetChannels();
    if (targetChannels.length > 0) {
      log(`🎯 Найдено ${targetChannels.length} целевых каналов`);
    } else {
      log('⚠️ Целевые каналы не настроены! Добавьте целевые каналы через меню.');
    }
    
    const monitoredChannels = await db.getMonitoredChannels();
    if (monitoredChannels.length > 0) {
      log(`📡 Найдено ${monitoredChannels.length} отслеживаемых каналов`);
    } else {
      log('⚠️ Отслеживаемые каналы не настроены! Добавьте каналы для отслеживания через меню.');
    }
    
  } catch (error) {
    log(`❌ Критическая ошибка запуска бота: ${error.message}`);
    log(`❌ Stack trace: ${error.stack}`);
    process.exit(1);
  }
}

// Обработчик необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
  log(`❌ Необработанное отклонение promise: ${reason}`);
  log(`❌ Promise: ${promise}`);
});

process.on('uncaughtException', (error) => {
  log(`❌ Непойманное исключение: ${error.message}`);
  log(`❌ Stack: ${error.stack}`);
  process.exit(1);
});

// Запускаем бота
startBot();

// Корректное завершение работы
process.once('SIGINT', () => {
  log('⏹️ Остановка бота по SIGINT');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  log('⏹️ Остановка бота по SIGTERM');
  bot.stop('SIGTERM');
  process.exit(0);
});