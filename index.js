// index.js

const TelegramBot = require('node-telegram-bot-api');

// --- 1. КОНФИГУРАЦИЯ ---
// !!! ВСТАВЬТЕ СЮДА ВАШ ТОКЕН !!!
const TOKEN = '8585291816:AAEccYuGINy4U4ByAInVLfbVmNOBTO2irps'; 
const MIN_PLAYERS = 4;

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('Бот Мафия запущен...');

// --- 2. ХРАНЕНИЕ СОСТОЯНИЯ ИГРЫ И ЛОКАЛИЗАЦИЯ ---
const activeGames = {};

const ROLE_NAMES = {
    'MAFIA': 'МАФИЯ',
    'DOCTOR': 'ДОКТОР',
    'SHERIFF': 'ШЕРИФ',
    'CIVILIAN': 'МИРНЫЙ ЖИТЕЛЬ'
};

// ... (Описание объекта игры без изменений) ...


// --- 3. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

// Функция для получения списка живых игроков
const getAlivePlayers = (game) => game.players.filter(p => p.isAlive);

// Функция для создания кнопок игроков (inline_keyboard)
const createPlayerButtons = (players, excludeUserId = null) => {
    return players
        .filter(p => p.isAlive && p.userId !== excludeUserId)
        .map(p => [{
            text: p.username, 
            callback_data: `vote_${p.userId}` 
        }]);
};

// Функция для проверки условий победы
const checkWinCondition = (game) => {
    const alivePlayers = getAlivePlayers(game);
    const mafiaCount = alivePlayers.filter(p => p.role === 'MAFIA').length;
    const civilianCount = alivePlayers.length - mafiaCount;

    if (mafiaCount === 0) {
        return 'CIVILIANS';
    }
    if (mafiaCount >= civilianCount) {
        return 'MAFIA';
    }
    return null;
};

// Функция распределения ролей
const distributeRoles = (players) => {
    let roles = ['MAFIA', 'SHERIFF', 'DOCTOR'];
    for (let i = roles.length; i < players.length; i++) {
        roles.push('CIVILIAN');
    }
    roles.sort(() => Math.random() - 0.5);

    return players.map((player, index) => ({
        ...player,
        role: roles[index],
        isAlive: true,
        nightAction: null, 
        dayVote: null,
    }));
};

// --- 4. ОСНОВНЫЕ ОБРАБОТЧИКИ КОМАНД И СОБЫТИЙ ---

/**
 * 4.1. Команда /start - Инициация игры или Меню Администратора
 */
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const game = activeGames[chatId];
    const isGroupChat = chatId < 0; 

    if (!isGroupChat) {
        return bot.sendMessage(chatId, 
            `Привет! Я бот для игры в Мафию. Запустите меня в групповом чате командой /start, чтобы начать игру.`
        );
    }
    
    // --- МЕНЮ АДМИНИСТРАТОРА (Для Групповых чатов) ---
    if (game && game.status !== 'finished') {
        const aliveCount = getAlivePlayers(game).length;
        
        const adminKeyboard = [
            [{ text: '🔄 Статус игры', callback_data: 'admin_status' }],
            // Добавляем кнопки в зависимости от текущей фазы
            ...(game.status === 'introduction'
                ? [[{ text: '🌙 Начать НОЧЬ (Только Админ)', callback_data: 'start_night_admin' }]]
                : []
            ),
            ...(game.status === 'night_end' || game.status === 'day_announcement'
                ? [[{ text: '▶️ Начать ДНЕВНОЕ ГОЛОСОВАНИЕ (Только Админ)', callback_data: 'start_day_admin' }]]
                : []
            ),
            // Кнопка для старта игры (только если идет регистрация)
            ...(game.status === 'registration' 
                ? [[{ text: `▶️ Начать игру (${game.players.length}/${MIN_PLAYERS}+)`, callback_data: 'start_game_admin' }]]
                : []
            ),
            [{ text: '❌ Перезапустить/Сбросить игру', callback_data: 'admin_reset' }]
        ];
        
        return bot.sendMessage(chatId, 
            `**🛠️ МЕНЮ УПРАВЛЕНИЯ ИГРОЙ**\n\nТекущий статус: **${game.status.toUpperCase()}** (Раунд ${game.round}). Живых: ${aliveCount}.`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: adminKeyboard } }
        );
    }
    
    // --- НАЧАЛО РЕГИСТРАЦИИ (Если игра неактивна) ---
    activeGames[chatId] = {
        chatId: chatId,
        adminId: userId,
        status: 'registration',
        round: 0,
        players: [],
        night: {},
        dayVotes: {},
        killedThisNight: null,
    };

    bot.sendMessage(chatId, 
        `🎭 **Игра Мафия**\n\nАдминистратор: ${msg.from.first_name || '@' + msg.from.username}\n\nНажмите "Присоединиться", чтобы участвовать!`, 
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Присоединиться (0/${MIN_PLAYERS}+)`, callback_data: 'join_game' }],
                    [{ text: 'Начать игру (Только Админ)', callback_data: 'start_game_admin' }]
                ]
            }
        }
    );
});


/**
 * 4.2. Обработка нажатий на кнопки (callback_query)
 */
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;
    
    let chatId;
    let game;

    if (data.includes('_group_')) {
        const groupChatIdStr = data.split('_group_')[1];
        chatId = parseInt(groupChatIdStr);
        game = activeGames[chatId];
    } else {
        chatId = message.chat.id;
        game = activeGames[chatId];
    }
    
    if (!game) return bot.answerCallbackQuery(callbackQuery.id, { text: 'Игра неактивна или не найдена.', show_alert: true });

    // --- 0. КОМАНДЫ АДМИНИСТРАТОРА ИЗ МЕНЮ ---
    
    if (data === 'admin_status') {
         if (userId !== game.adminId) {
             return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может смотреть статус.', show_alert: true });
         }
         const aliveCount = getAlivePlayers(game).length;
         const initialCount = game.players.length;

         let statusText = `
### 📊 Статус Игры "Мафия"
* **Раунд:** ${game.round === 0 ? 'Регистрация' : game.round}
* **Этап:** ${game.status.toUpperCase()}
* **Игроков (Живых/Начало):** ${aliveCount} / ${initialCount}
* **Администратор:** ${game.players.find(p => p.userId === game.adminId)?.username || game.adminId}
         `;

         return bot.answerCallbackQuery(callbackQuery.id, statusText, { show_alert: true, parse_mode: 'Markdown' });
    }
    
    if (data === 'admin_reset') {
         if (userId !== game.adminId) {
             return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может перезапустить игру.', show_alert: true });
         }
         
         delete activeGames[chatId];
         bot.sendMessage(chatId, '❌ **Игра сброшена.** Начните новую игру командой /start.');
         return bot.answerCallbackQuery(callbackQuery.id, { text: 'Игра сброшена.' });
    }

    // --- A. Этап РЕГИСТРАЦИИ (join_game) ---
    if (data === 'join_game' && game.status === 'registration') {
        const existingPlayer = game.players.find(p => p.userId === userId);
        
        if (existingPlayer) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Вы уже присоединились к игре!' });
        }
        
        const playerName = callbackQuery.from.first_name || callbackQuery.from.username;

        game.players.push({
            userId: userId,
            username: playerName, 
            role: null,
            isAlive: true,
            nightAction: null, 
            dayVote: null,
        });
        
        const count = game.players.length;
        bot.editMessageReplyMarkup({
            inline_keyboard: [
                [{ text: `Присоединиться (${count}/${MIN_PLAYERS}+)`, callback_data: 'join_game' }],
                [{ text: 'Начать игру (Только Админ)', callback_data: 'start_game_admin' }]
            ]
        }, {
            chat_id: chatId,
            message_id: message.message_id
        });
        
        return bot.answerCallbackQuery(callbackQuery.id, { text: `Вы присоединились! Всего: ${count}` });
    }
    
    // --- B. Старт ИГРЫ (start_game_admin) ---
    if (data === 'start_game_admin' && game.status === 'registration') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может начать игру.', show_alert: true });
        }

        if (game.players.length < MIN_PLAYERS) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: `Нужно минимум ${MIN_PLAYERS} игроков. Сейчас: ${game.players.length}`, show_alert: true });
        }

        game.players = distributeRoles(game.players);
        game.status = 'introduction'; 
        game.round = 1;
        
        // 1. Отправляем сообщение о начале игры и списке
        const playersList = game.players.map(p => `• ${p.username}`).join('\n');
        
        bot.editMessageText(
            `\n\n\n🚀 **ИГРА НАЧАЛАСЬ!** 🚀\n\nУчаствуют: ${game.players.length} человек.\n**Проверьте свои личные сообщения** — вам отправлены ваши роли!\n\n**Список участников:**\n${playersList}`,
            {
                chat_id: chatId,
                message_id: message.message_id,
                parse_mode: 'Markdown',
            }
        );
        
        // 2. Запускаем фазу знакомства (отправка ЛС + сообщение в чат с кнопкой)
        startIntroduction(game);

        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Игра запущена!' });
    }

    // --- B2. ПЕРЕХОД К НОЧИ (start_night_admin) ---
    if (data === 'start_night_admin' && game.status === 'introduction') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может начать ночь.', show_alert: true });
        }

        // Удаляем кнопку "Начать ночь" и переходим к фазе ночи
        bot.editMessageText(`🌙 **НАСТУПАЕТ НОЧЬ!** Все уснули.`, {
             chat_id: chatId,
             message_id: message.message_id,
        });

        startNight(game);
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Начинается первая ночь.' });
    }

    // --- C. Действия НОЧЬЮ (night_action_ROLE_TARGETID_group_GROUPID) ---
    if (data.startsWith('night_action_') && game.status === 'night') {
        const parts = data.split('_'); 
        const role = parts[2]; 
        const targetId = parseInt(parts[3]); 

        const player = game.players.find(p => p.userId === userId);
        
        if (!player || !player.isAlive) {
             return bot.answerCallbackQuery(callbackQuery.id, { text: 'Вы не в игре.' });
        }
        
        const targetPlayer = game.players.find(p => p.userId === targetId);
        
        // --- ЗАПИСЬ ДЕЙСТВИЯ ---
        if (role === 'MAFIA') {
            game.night.mafiaTargetId = targetId;
        } else if (role === 'DOCTOR') {
            game.night.doctorSaveId = targetId;
        } else if (role === 'SHERIFF') {
            game.night.sheriffCheckId = targetId;
            const result = targetPlayer.role === 'MAFIA' ? 'МАФИЯ' : 'МИРНЫЙ';
            await bot.sendMessage(userId, `🔎 Результат проверки:\nИгрок **${targetPlayer.username}** — это **${result}**!`, { parse_mode: 'Markdown' });
        } 
        
        // Все игроки (включая мирных) записывают nightAction
        player.nightAction = targetId; 

        // --- ОБНОВЛЕНИЕ КНОПКИ В ЛС ---
        let confirmationMessage;
        if (role === 'CIVILIAN') {
             confirmationMessage = `✅ Вы выбрали игрока ${targetPlayer.username} и пожелали ему спокойной ночи.`;
        } else {
             confirmationMessage = `✅ Вы выбрали игрока ${targetPlayer.username}. Ожидаем остальных...`;
        }

        bot.editMessageText(confirmationMessage, {
            chat_id: userId,
            message_id: message.message_id
        });
        
        checkNightActions(game);
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Ваш выбор учтен.' });
    }
    
    // --- D. Результат НОЧИ (show_night_result_admin) ---
    if (data === 'show_night_result_admin' && game.status === 'night_end') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может показать результат.', show_alert: true });
        }
        
        // Заменяем сообщение с кнопкой на сообщение о результате и переходим в фазу дня
        const messageId = message.message_id;
        showNightResult(game, messageId);
        
        return bot.answerCallbackQuery(callbackQuery.id);
    }
    
    // --- E. Начало ДНЯ (start_day_admin) ---
     if (data === 'start_day_admin' && (game.status === 'day_announcement' || game.status === 'night_end')) {
         if (userId !== game.adminId) {
             return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может начать голосование.', show_alert: true });
         }
         
         // Удаляем кнопку "Начать голосование"
         bot.editMessageReplyMarkup(
             { inline_keyboard: [] },
             { chat_id: chatId, message_id: message.message_id }
         ).catch(() => {}); // Игнорируем ошибку, если сообщение уже отредактировано

         startDay(game);
         return bot.answerCallbackQuery(callbackQuery.id, { text: 'Начинается дневное голосование.' });
     }


    // --- F. Голосование ДНЕМ (day_vote) ---
    if (data.startsWith('day_vote_') && (game.status === 'day' || game.status === 'runoff')) {
        const parts = data.split('_');
        const targetId = parseInt(parts[2]);
        
        const voter = game.players.find(p => p.userId === userId);
        const target = game.players.find(p => p.userId === targetId);

        if (!voter || !voter.isAlive) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Вы не можете голосовать.' });
        }

        voter.dayVote = targetId;
        
        // Сообщение в ЛС об успешном голосовании
        bot.editMessageText(`✅ Вы проголосовали против **${target.username}**. Ожидаем остальных...`, {
            chat_id: userId,
            message_id: message.message_id,
            parse_mode: 'Markdown'
        });

        // Обновляем статус голосования в общем чате и проверяем завершение
        updateVotingStatus(game, voter.username, target.username);
        
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Ваш голос учтен.' });
    }
    
    // --- G. Результат ДНЯ (show_day_result_admin) ---
    if (data === 'show_day_result_admin' && game.status === 'day_end') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может показать результат.', show_alert: true });
        }
        
        const messageId = message.message_id;
        showDayResult(game, messageId);

        return bot.answerCallbackQuery(callbackQuery.id);
    }
    
    // --- H. Завершить Игру (end_game_admin) ---
    if (data === 'end_game_admin') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может завершить игру.', show_alert: true });
        }
        
        delete activeGames[chatId];
        bot.sendMessage(chatId, 'Игра полностью завершена. Спасибо за участие! Начните новую игру: /start');
        return bot.answerCallbackQuery(callbackQuery.id);
    }
});

/**
 * 4.3. Команда /reset - Быстрый сброс игры
 */
bot.onText(/\/reset/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const game = activeGames[chatId];
    
    if (!game) {
        return bot.sendMessage(chatId, 'Нет активной игры для сброса.');
    }
    
    if (userId !== game.adminId) {
        return bot.sendMessage(chatId, 'Только администратор, начавший игру, может сбросить ее.');
    }
    
    delete activeGames[chatId];
    bot.sendMessage(chatId, '❌ **Игра сброшена.** Начните новую игру командой /start.');
});


// --- 5. ЛОГИКА ФАЗ ИГРЫ ---

/**
 * 5.0. Фаза Знакомства (Introduction)
 */
function startIntroduction(game) {
    const roleDescriptions = {
        'MAFIA': {
            title: ROLE_NAMES['MAFIA'],
            description: 'каждую ночь вы выбираете жертву которую хотите убить'
        },
        'DOCTOR': {
            title: ROLE_NAMES['DOCTOR'],
            description: 'каждую ночь вы можете выбрать одного игрока которого вы хотите вылечить'
        },
        'SHERIFF': {
            title: ROLE_NAMES['SHERIFF'],
            description: 'каждую ночью вы можете проверить одного игрока и узнать его роль в игре'
        },
        'CIVILIAN': {
            title: ROLE_NAMES['CIVILIAN'],
            description: 'ночью у вас нет дел вы можете спать спокойно'
        }
    };

    for (const player of game.players) {
        const roleInfo = roleDescriptions[player.role];
        const privateMessage = 
            `**Ваша роль:** ${roleInfo.title}\n` +
            `**Ваши действия:** ${roleInfo.description}`;
        
        bot.sendMessage(player.userId, privateMessage, { 
            parse_mode: 'Markdown'
        }).catch(err => {
             console.error(`Не удалось отправить сообщение ${player.username}:`, err.response?.body?.description || err.message);
             bot.sendMessage(game.chatId, `⚠️ Не могу связаться с ${player.username}. Пожалуйста, начните диалог со мной в ЛС!`);
        });
    }

    // Сообщение в общий чат (с кнопкой в конце)
    bot.sendMessage(game.chatId,
        `\n\n**ЗНАКОМСТВО**\n\n` + 
        `Город знакомится с жителями, каждый представляется мирным, но впереди наступит ночь и тогда мафия сделает свой первый выстрел.`,
        { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '🌙 Начать НОЧЬ (Только Админ)', callback_data: 'start_night_admin' }]]
            }
        }
    );
}


// 5.1. Начало Ночи
function startNight(game) {
    game.status = 'night';
    game.night = {}; 
    game.killedThisNight = null;

    // Сброс ночных действий для всех игроков
    game.players.forEach(p => p.nightAction = null);

    // Увеличиваем раунд, так как это новая ночь
    game.round++; 

    bot.sendMessage(game.chatId, 
        `\n\n🌙 **РАУНД ${game.round}: НАСТУПАЕТ НОЧЬ!**\n\nВсе мирные жители спят. Мафия, Доктор и Шериф делают свой выбор в личных сообщениях.`
    );

    const alivePlayers = getAlivePlayers(game);

    for (const player of alivePlayers) {
        let excludeId = null;
        let privateMessage;
        let actionData;
        
        switch (player.role) {
            case 'MAFIA':
                privateMessage = `😈 **МАФИЯ**, выберите жертву на эту ночь:`;
                actionData = 'night_action_MAFIA';
                excludeId = player.userId;
                break;
            case 'DOCTOR':
                privateMessage = `🩺 **ДОКТОР**, выберите, кого вы спасете этой ночью (включая себя):`;
                actionData = 'night_action_DOCTOR';
                break;
            case 'SHERIFF':
                privateMessage = `🕵️‍♂️ **ШЕРИФ**, выберите, кого вы проверите:`;
                actionData = 'night_action_SHERIFF';
                excludeId = player.userId;
                break;
            case 'CIVILIAN':
                privateMessage = `🏘️ **МИРНЫЙ ЖИТЕЛЬ**, ночью у вас нет дел, вы можете спать спокойно. Выберите игрока, которому пожелаете спокойной ночи.`;
                actionData = 'night_action_CIVILIAN';
                break;
        }
        
       const buttons = createPlayerButtons(alivePlayers, excludeId);

       const inlineKeyboard = buttons.map(row => 
            row.map(btn => {
                const targetIdFromVote = btn.callback_data.split('_')[1]; 
                
                return {
                    text: btn.text,
                    callback_data: `${actionData}_${targetIdFromVote}_group_${game.chatId}` 
                };
            })
        );
            
        bot.sendMessage(player.userId, privateMessage, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard }
        }).catch(err => {
             console.error(`Не удалось отправить сообщение ${player.username}:`, err.response?.body?.description || err.message);
             bot.sendMessage(game.chatId, `⚠️ Не могу связаться с ${player.username}. Пожалуйста, начните диалог со мной в ЛС!`);
        });
    }
}

// 5.2. Проверка действий ночи и переход к результату
function checkNightActions(game) {
    const alivePlayers = getAlivePlayers(game);
    // Проверяем, что ВСЕ живые игроки сделали nightAction
    const allPlayersDone = alivePlayers.every(p => p.nightAction !== null);
    
    // Проверка действия Шерифа (отдельно, т.к. его результат отправляется сразу)
    const sheriffNeeded = game.players.find(p => p.role === 'SHERIFF' && p.isAlive);
    const sheriffDone = sheriffNeeded ? (game.night.sheriffCheckId !== undefined) : true;
    
    // Проверка действия Мафии и Доктора (через их поля в game.night)
    const mafiaNeeded = game.players.find(p => p.role === 'MAFIA' && p.isAlive);
    const doctorNeeded = game.players.find(p => p.role === 'DOCTOR' && p.isAlive);
    
    const mafiaDone = mafiaNeeded ? (game.night.mafiaTargetId !== undefined) : true;
    const doctorDone = doctorNeeded ? (game.night.doctorSaveId !== undefined) : true;
    
    // Ночь завершена, если ВСЕ игроки (включая мирных) сделали ход
    if (allPlayersDone && mafiaDone && doctorDone && sheriffDone) {
        game.status = 'night_end';
        
        bot.sendMessage(game.chatId, 
            `📰 **Ночь прошла и наступило утро.**\n\nУ нас есть новости для жителей города.`, 
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Показать результат (Только Админ)', callback_data: 'show_night_result_admin' }]
                    ]
                }
            }
        );
    }
}

// 5.3. Объявление результата ночи
function showNightResult(game, messageId) {
    
    const targetId = game.night.mafiaTargetId;
    const savedId = game.night.doctorSaveId;

    let resultMessage;

    if (!targetId) {
        resultMessage = 'Мафия не смогла договориться и никого не убила! Город в безопасности.';
    } else {
        const targetPlayer = game.players.find(p => p.userId === targetId);

        if (targetId === savedId) {
            // Скрываем имя игрока, если Доктор спас
            resultMessage = `Мафия сделала свой выбор, но **Доктор** оказался рядом и спас жителя! Никто не погиб.`;
        } else {
            game.killedThisNight = targetId;
            targetPlayer.isAlive = false;
            
            // Локализация роли убитого игрока
            const roleInRussian = ROLE_NAMES[targetPlayer.role] || targetPlayer.role;
            
            resultMessage = `Мафия сделала свой выбор: 🩸 **${targetPlayer.username}** (роль: **${roleInRussian}**) был убит этой ночью.`;
            
            const winner = checkWinCondition(game);
            if (winner) {
                // Если игра завершена, то завершаем ее сразу
                return endGame(game, winner);
            }
        }
    }
    
    // Формируем финальное сообщение о ночи
    const finalNightMessage = 
        `--- 📰 НОЧНЫЕ НОВОСТИ ---\n${resultMessage}\n------------------\n\n${getAlivePlayers(game).length} игроков остаются в игре.`;

    // Редактируем предыдущее сообщение, убирая кнопку "Показать результат"
    bot.editMessageText(finalNightMessage, {
        chat_id: game.chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
    }).catch(err => {
        if (err.response && err.response.statusCode !== 400) {
            bot.sendMessage(game.chatId, finalNightMessage, { parse_mode: 'Markdown' });
        }
    });
    
    // Переход в фазу объявления дня (пауза перед голосованием)
    game.status = 'day_announcement';
    
    // Новое сообщение с кнопкой начала голосования
    bot.sendMessage(game.chatId, 
        `\n\n☀️ **НАСТУПАЕТ ДЕНЬ**\n\nГород собирается на суд! Обсудите, кто из вас Мафия, и начните голосование в личных сообщениях.`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '▶️ Начать ГОЛОСОВАНИЕ (Только Админ)', callback_data: 'start_day_admin' }]
                ]
            }
        }
    );
}

// 5.4. Начало Дня (Голосование)
function startDay(game) {
    game.status = 'day';
    game.players.forEach(p => p.dayVote = null);
    
    const alivePlayers = getAlivePlayers(game);
    const playerButtons = createPlayerButtons(alivePlayers);

    // Рассылка ЛС для голосования
    for (const player of alivePlayers) {
        const inlineKeyboard = playerButtons.map(row => 
            row.map(btn => {
                 const targetIdFromVote = btn.callback_data.split('_')[1];
                 return {
                    text: btn.text,
                    callback_data: `day_vote_${targetIdFromVote}_group_${game.chatId}` 
                 };
            })
        );

        bot.sendMessage(player.userId, `🏛️ **СУД**. Выберите, кого вы подозреваете и хотите повесить:`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard }
        }).catch(() => {});
    }
}

// 5.5. Обновление статуса голосования
function updateVotingStatus(game, voterUsername, targetUsername) {
    const alivePlayers = getAlivePlayers(game);
    const aliveCount = alivePlayers.length;
    const votedCount = alivePlayers.filter(p => p.dayVote !== null).length;
    
    // 1. Формируем сообщение о текущем голосе
    const statusText = 
        `🗳️ **ГОЛОСОВАНИЕ:** ${votedCount} / ${aliveCount} (${voterUsername}) проголосовал против **${targetUsername}**.`;
    
    // 2. Отправляем статус голосования
    bot.sendMessage(game.chatId, statusText, { parse_mode: 'Markdown' }).then(() => {
        // 3. После того как сообщение о голосе отправлено, проверяем, завершено ли голосование.
        if (votedCount === aliveCount) {
            game.status = 'day_end';
            
            // 4. Отправляем финальное сообщение о завершении голосования
            bot.sendMessage(game.chatId, '📢 Все проголосовали. Результат готов!', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Показать результат голосования (Только Админ)', callback_data: 'show_day_result_admin' }]
                    ]
                }
            });
        }
    }).catch(err => console.error("Ошибка при отправке статуса голосования:", err));
}

// 5.6. Проверка голосов и переход к результату Дня (Эта функция теперь пустая, так как логика перенесена в updateVotingStatus)
function checkDayVotes(game) {
    // Эта функция теперь не нужна, так как вся логика перенесена в updateVotingStatus
    // для гарантированного порядка сообщений.
}

// 5.7. Объявление результата Дня
function showDayResult(game, messageId) {
    const alivePlayers = getAlivePlayers(game);
    const votes = {}; 

    for (const player of alivePlayers) {
        if (player.dayVote) {
            votes[player.dayVote] = (votes[player.dayVote] || 0) + 1;
        }
    }

    const voteEntries = Object.entries(votes).map(([id, count]) => ({ id: parseInt(id), count }));
    voteEntries.sort((a, b) => b.count - a.count);

    const maxVotes = voteEntries.length > 0 ? voteEntries[0].count : 0;
    const leadingCandidates = voteEntries.filter(e => e.count === maxVotes);

    // 1. Удаляем кнопку "Показать результат"
    bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: game.chatId, message_id: messageId }
    ).catch(() => {});

    if (maxVotes === 0 || leadingCandidates.length === 0) {
        bot.sendMessage(game.chatId, 'Голосование завершилось без явного лидера. Город не смог принять решение.');
        return startNight(game);
    }

    if (leadingCandidates.length > 1) {
        game.status = 'runoff';
        const candidatesNames = leadingCandidates.map(c => game.players.find(p => p.userId === c.id).username);
        
        bot.sendMessage(game.chatId, 
            `⚖️ **НИЧЬЯ!** Игроки **${candidatesNames.join('** и **')}** набрали одинаковое количество голосов (${maxVotes}). Город отправляется на дополнительное голосование! (Только между ними)`,
            { parse_mode: 'Markdown' }
        );
        
        const runoffPlayers = leadingCandidates.map(c => game.players.find(p => p.userId === c.id));
        
        for (const player of alivePlayers) {
            player.dayVote = null; 
            
            const runoffButtons = runoffPlayers.map(p => 
                [{ text: p.username, callback_data: `day_vote_${p.userId}_group_${game.chatId}` }]
            );

            bot.sendMessage(player.userId, `🔥 **ДОПОЛНИТЕЛЬНОЕ ГОЛОСОВАНИЕ!** Выберите только из этих кандидатов:`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: runoffButtons }
            }).catch(() => {});
        }
        return;
    }

    // --- ОБЪЯВЛЕНИЕ РЕЗУЛЬТАТА КАЗНИ ---
    
    const executedPlayer = game.players.find(p => p.userId === leadingCandidates[0].id);
    executedPlayer.isAlive = false;
    
    // Локализация роли казненного игрока
    const roleInRussian = ROLE_NAMES[executedPlayer.role] || executedPlayer.role;

    // 2. Объявляем результат казни
    bot.sendMessage(game.chatId, 
        `\n\n🔨 **РЕЗУЛЬТАТ СУДА**\n\nЖители подозревали каждого, но сделали свой выбор: **${executedPlayer.username}** (роль: **${roleInRussian}**) был казнен!`, 
        { parse_mode: 'Markdown' }
    ).then(() => {
        // 3. Проверяем условие победы и переходим дальше
        const winner = checkWinCondition(game);
        if (winner) {
            // Вызов endGame после того, как объявлен результат суда
            return endGame(game, winner);
        }
        
        startNight(game);
    });
}

// 5.8. Завершение Игры
function endGame(game, winner) {
    game.status = 'finished';
    
    let resultMessage;
    if (winner === 'MAFIA') {
        resultMessage = '🔪 **ПОБЕДИЛА МАФИЯ!** Город пал. Выжили: ' + getAlivePlayers(game).map(p => p.username).join(', ');
    } else {
        resultMessage = '🛡️ **ПОБЕДИЛИ МИРНЫЕ ЖИТЕЛИ!** Город очищен от зла.';
    }
    
    // Локализация всех ролей для финального списка
    const allRoles = game.players.map(p => `• ${p.username}: ${ROLE_NAMES[p.role] || p.role}`).join('\n');

    bot.sendMessage(game.chatId, 
        `\n\n🎉 **ИГРА ЗАВЕРШЕНА!** 🎉\n${resultMessage}\n\n**Все роли:**\n${allRoles}`, 
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Завершить игру (Только Админ)', callback_data: 'end_game_admin' }]
                ]
            }
        }
    );
}