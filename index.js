// index.js

const TelegramBot = require('node-telegram-bot-api');

// --- 1. КОНФИГУРАЦИЯ ---
const TOKEN = '8585291816:AAEccYuGINy4U4ByAInVLfbVmNOBTO2irps'; 
const MIN_PLAYERS = 4; // Минимальное количество игроков для старта
const MIN_PLAYERS_FOR_2_MAFIA = 6; // Минимальное количество для 2 мафиози (Дон + Мафия)

if (!TOKEN) {
    console.error("❌ Ошибка: Переменная окружения BOT_TOKEN не установлена.");
    process.exit(1); 
}

const bot = new TelegramBot(TOKEN, { polling: true }); 
console.log('✅ Бот Мафия запущен...');

// --- 2. ХРАНЕНИЕ СОСТОЯНИЯ ИГРЫ И ЛОКАЛИЗАЦИЯ ---
const activeGames = {};

const ROLE_NAMES = {
    'MAFIA': 'МАФИЯ',
    'DON_MAFIA': 'ДОН МАФИИ',
    'DOCTOR': 'ДОКТОР',
    'SHERIFF': 'ШЕРИФ',
    'CIVILIAN': 'МИРНЫЙ ЖИТЕЛЬ'
};

// --- 3. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

const getAlivePlayers = (game) => game.players.filter(p => p.isAlive);

const createPlayerButtons = (players, excludeUserId = null) => {
    return players
        .filter(p => p.isAlive && p.userId !== excludeUserId)
        .map(p => [{
            text: p.username, 
            callback_data: `vote_${p.userId}` 
        }]);
};

const checkWinCondition = (game) => {
    const alivePlayers = getAlivePlayers(game);
    const mafiaCount = alivePlayers.filter(p => p.role === 'MAFIA' || p.role === 'DON_MAFIA').length;
    const civilianCount = alivePlayers.length - mafiaCount;

    if (mafiaCount === 0) {
        return 'CIVILIANS';
    }
    if (mafiaCount >= civilianCount) {
        return 'MAFIA';
    }
    return null;
};

const distributeRoles = (players, mafiaCountChoice) => {
    let roles = [];
    
    if (mafiaCountChoice === 2) {
        roles.push('DON_MAFIA', 'MAFIA', 'SHERIFF', 'DOCTOR');
    } else { 
        roles.push('MAFIA', 'SHERIFF', 'DOCTOR');
    }
    
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
        // *** НОВОЕ ПОЛЕ ***
        selfHealedOnce: false, // Отслеживание самолечения Доктора
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
    
    // --- МЕНЮ АДМИНИСТРАТОРА ---
    if (game && game.status !== 'finished') {
        const aliveCount = getAlivePlayers(game).length;
        
        const adminKeyboard = [
            [{ text: '🔄 Статус игры', callback_data: 'admin_status' }],
            ...(game.status === 'introduction'
                ? [[{ text: '🌙 Начать НОЧЬ (Только Админ)', callback_data: 'start_night_admin' }]]
                : []
            ),
            ...(game.status === 'night_end' || game.status === 'day_announcement'
                ? [[{ text: '▶️ Начать ДНЕВНОЕ ГОЛОСОВАНИЕ (Только Админ)', callback_data: 'start_day_admin' }]]
                : []
            ),
            ...(game.status === 'registration' 
                ? [[{ text: `▶️ Начать игру (${game.players.length}/${MIN_PLAYERS}+)`, callback_data: 'start_game_choice' }]]
                : []
            ),
            [{ text: '❌ Перезапустить/Сбросить игру', callback_data: 'admin_reset' }] 
        ];
        
        return bot.sendMessage(chatId, 
            `**🛠️ МЕНЮ УПРАВЛЕНИЯ ИГРОЙ**\n\nТекущий статус: **${game.status.toUpperCase()}** (Раунд ${game.round}). Живых: ${aliveCount}.`,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: adminKeyboard } }
        );
    }
    
    // --- НАЧАЛО РЕГИСТРАЦИИ ---
    activeGames[chatId] = {
        chatId: chatId,
        adminId: userId,
        status: 'registration',
        round: 0,
        players: [],
        night: {
            mafiaKillTargetId: null, 
            mafiaCheckTargetId: null,
            doctorSaveId: null,
            sheriffCheckId: null,
        },
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
                    [{ text: 'Начать игру (Только Админ)', callback_data: 'start_game_choice' }]
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

    // --- A.1. Сброс/Перезапуск Игры (admin_reset) ---
    if (data === 'admin_reset') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может сбросить игру.', show_alert: true });
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
            selfHealedOnce: false, // Инициализация
        });
        
        const count = game.players.length;
        bot.editMessageReplyMarkup({
            inline_keyboard: [
                [{ text: `Присоединиться (${count}/${MIN_PLAYERS}+)`, callback_data: 'join_game' }],
                [{ text: 'Начать игру (Только Админ)', callback_data: 'start_game_choice' }]
            ]
        }, {
            chat_id: chatId,
            message_id: message.message_id
        });
        
        return bot.answerCallbackQuery(callbackQuery.id, { text: `Вы присоединились! Всего: ${count}` });
    }

    // --- B. Выбор количества мафии (start_game_choice) ---
    if (data === 'start_game_choice' && game.status === 'registration') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может начать игру.', show_alert: true });
        }

        if (game.players.length < MIN_PLAYERS) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: `Нужно минимум ${MIN_PLAYERS} игроков. Сейчас: ${game.players.length}`, show_alert: true });
        }
        
        let keyboard = [
            [{ text: '1 игрок Мафии (МАФИЯ)', callback_data: 'start_game_1' }],
        ];

        if (game.players.length >= MIN_PLAYERS_FOR_2_MAFIA) {
            keyboard.push([{ text: '2 игрока Мафии (ДОН + МАФИЯ)', callback_data: 'start_game_2' }]);
        }

        return bot.editMessageText(`🛠️ **НАСТРОЙКА ИГРЫ**\n\nВыберите количество игроков Мафии:`, {
            chat_id: chatId,
            message_id: message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    // --- B1. Старт ИГРЫ (start_game_1/2) ---
    if (data.startsWith('start_game_') && game.status === 'registration') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может начать игру.', show_alert: true });
        }
        
        const mafiaCountChoice = parseInt(data.split('_')[2]); // 1 или 2
        
        game.players = distributeRoles(game.players, mafiaCountChoice);
        game.status = 'introduction'; 
        game.round = 1;
        
        const playersList = game.players.map(p => `• ${p.username}`).join('\n');
        
        bot.editMessageText(
            `\n\n\n🚀 **ИГРА НАЧАЛАСЬ!** 🚀\n\nУчаствуют: ${game.players.length} человек. (Мафии: ${mafiaCountChoice}) \n**Проверьте свои личные сообщения** — вам отправлены ваши роли!\n\n**Список участников:**\n${playersList}`,
            {
                chat_id: chatId,
                message_id: message.message_id,
                parse_mode: 'Markdown',
            }
        );
        
        startIntroduction(game);

        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Игра запущена!' });
    }

    // --- B2. ПЕРЕХОД К НОЧИ (start_night_admin) ---
    if (data === 'start_night_admin' && game.status === 'introduction') {
        if (userId !== game.adminId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может начать ночь.', show_alert: true });
        }

        bot.editMessageText(`🌙 **НАСТУПАЕТ НОЧЬ!** Все уснули.`, {
             chat_id: chatId,
             message_id: message.message_id,
        });

        startNight(game);
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Начинается первая ночь.' });
    }

    // --- C.1. Действие ДОНА МАФИИ: Проверка Шерифа (night_action_check_TARGETID) ---
    if (data.startsWith('night_action_check_') && game.status === 'night') {
        const targetId = parseInt(data.split('_')[3]);
        const player = game.players.find(p => p.userId === userId);

        if (!player || player.role !== 'DON_MAFIA' || !player.isAlive) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Вы не Дон Мафии или не в игре.' });
        }
        
        const targetPlayer = game.players.find(p => p.userId === targetId);
        
        game.night.mafiaCheckTargetId = targetId;

        const result = targetPlayer.role === 'SHERIFF' ? 'ШЕРИФ' : 'НЕ ШЕРИФ';
        await bot.sendMessage(userId, `🔎 Результат проверки:\nИгрок **${targetPlayer.username}** — **${result}**!`, { parse_mode: 'Markdown' });

        await bot.editMessageText(`✅ Вы выбрали ${targetPlayer.username} для проверки.`, {
            chat_id: userId,
            message_id: message.message_id
        });
        
        return startMafiaKillVote(game, userId);
    }
    
    // --- C.2. Действия Мафии: Первоначальный выбор жертвы (night_action_mafia_vote_TARGETID) ---
    if (data.startsWith('night_action_mafia_vote_') && game.status === 'night') {
        const targetId = parseInt(data.split('_')[4]); 
        const player = game.players.find(p => p.userId === userId);
        
        if (!player || !(player.role === 'MAFIA' || player.role === 'DON_MAFIA') || !player.isAlive) {
             return bot.answerCallbackQuery(callbackQuery.id, { text: 'Вы не Мафия или не в игре.' });
        }
        
        game.night.mafiaKillTargetId = targetId;

        if (game.players.filter(p => (p.role === 'MAFIA' || p.role === 'DON_MAFIA') && p.isAlive).length === 1) {
            player.nightAction = targetId;
            await bot.editMessageText(`✅ Вы выбрали **${game.players.find(p => p.userId === targetId).username}**. Ожидаем завершения действий других ролей.`, {
                chat_id: userId,
                message_id: message.message_id,
                parse_mode: 'Markdown'
            });
            checkNightActions(game);
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Ваш выбор учтен.' });
        }

        if (player.role === 'DON_MAFIA') {
             await bot.editMessageText(`✅ Вы (Дон Мафии) предложили убить **${game.players.find(p => p.userId === targetId).username}**. Ожидаем согласия напарника.`, {
                chat_id: userId,
                message_id: message.message_id,
                parse_mode: 'Markdown'
             });
        } else if (player.role === 'MAFIA') {
             await bot.editMessageText(`✅ Вы (Мафия) предложили убить **${game.players.find(p => p.userId === targetId).username}**. Ожидаем согласия Дона Мафии.`, {
                chat_id: userId,
                message_id: message.message_id,
                parse_mode: 'Markdown'
             });
        }
        
        return sendMafiaAgreementRequest(game, userId, targetId);
    }

    // --- C.3. Согласие / Предложение (night_action_agree / night_action_propose) ---
    if (data.startsWith('night_action_agree_') && game.status === 'night') {
        const targetId = game.night.mafiaKillTargetId;
        if (!targetId) return bot.answerCallbackQuery(callbackQuery.id, { text: 'Цель для убийства не выбрана.' });
        
        const player = game.players.find(p => p.userId === userId);
        player.nightAction = targetId; 

        bot.editMessageText(`✅ Вы согласились на убийство **${game.players.find(p => p.userId === targetId).username}**. Ожидаем завершения действий других ролей.`, {
            chat_id: userId,
            message_id: message.message_id,
            parse_mode: 'Markdown'
        });
        
        const proposer = game.players.find(p => p.userId !== userId && p.role in {'MAFIA':1, 'DON_MAFIA':1} && p.isAlive);
        if (proposer) proposer.nightAction = targetId;
        
        checkNightActions(game); 
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Согласие учтено.' });
    }

    if (data.startsWith('night_action_propose_') && game.status === 'night') {
        const player = game.players.find(p => p.userId === userId);
        
        game.night.mafiaKillTargetId = null; 
        
        const otherMafia = game.players.find(p => 
            (p.role === 'MAFIA' || p.role === 'DON_MAFIA') && p.isAlive && p.userId !== userId
        );
        if (otherMafia) {
            bot.sendMessage(otherMafia.userId, `Ваш напарник (**${player.username}**) предложил иного игрока. Ждите нового предложения.`);
        }
        
        await bot.editMessageText(`❌ Предложите новую жертву:`, {
            chat_id: userId,
            message_id: message.message_id,
            parse_mode: 'Markdown'
        });

        startMafiaKillVote(game, userId);
        
        return bot.answerCallbackQuery(callbackQuery.id, { text: 'Переголосование начато.' });
    }
    
    // --- C.4. Действия Доктора/Шерифа/Мирного ---
    if (data.startsWith('night_action_') && game.status === 'night') {
        const parts = data.split('_'); 
        const role = parts[2]; 
        const targetId = parseInt(parts[3]); 

        const player = game.players.find(p => p.userId === userId);
        
        if (!player || !player.isAlive || player.role === 'DON_MAFIA' || player.role === 'MAFIA') { 
             return bot.answerCallbackQuery(callbackQuery.id, { text: 'Неверная роль или вы не в игре.' });
        }
        
        const targetPlayer = game.players.find(p => p.userId === targetId);
        
        if (role === 'DOCTOR') {
            game.night.doctorSaveId = targetId;
            // *** ЛОГИКА САМОЛЕЧЕНИЯ ***
            if (targetId === userId) {
                player.selfHealedOnce = true;
                await bot.sendMessage(userId, `💉 Вы **использовали** свою единственную возможность вылечить себя за игру!`, { parse_mode: 'Markdown' });
            }
        } else if (role === 'SHERIFF') {
            game.night.sheriffCheckId = targetId;
            const result = (targetPlayer.role === 'MAFIA' || targetPlayer.role === 'DON_MAFIA') ? 'МАФИЯ' : 'МИРНЫЙ';
            await bot.sendMessage(userId, `🔎 Результат проверки:\nИгрок **${targetPlayer.username}** — это **${result}**!`, { parse_mode: 'Markdown' });
        } 
        
        player.nightAction = targetId; 

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
        
        const messageId = message.message_id;
        showNightResult(game, messageId);
        
        return bot.answerCallbackQuery(callbackQuery.id);
    }
    
    // --- E. Начало ДНЯ (start_day_admin) ---
     if (data === 'start_day_admin' && (game.status === 'day_announcement' || game.status === 'night_end')) {
         if (userId !== game.adminId) {
             return bot.answerCallbackQuery(callbackQuery.id, { text: 'Только администратор может начать голосование.', show_alert: true });
         }
         
         bot.editMessageReplyMarkup(
             { inline_keyboard: [] },
             { chat_id: chatId, message_id: message.message_id }
         ).catch(() => {});

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
        
        bot.editMessageText(`✅ Вы проголосовали против **${target.username}**. Ожидаем остальных...`, {
            chat_id: userId,
            message_id: message.message_id,
            parse_mode: 'Markdown'
        });

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
    
    return bot.answerCallbackQuery(callbackQuery.id, { text: 'Неизвестное действие.' });
});

/**
 * 4.3. Команда /reset
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
    
    const donMafia = game.players.find(p => p.role === 'DON_MAFIA' && p.isAlive);
    const simpleMafia = game.players.find(p => p.role === 'MAFIA' && p.isAlive);
    
    const mafiaCountTotal = game.players.filter(p => p.role === 'DON_MAFIA' || p.role === 'MAFIA').length;

    for (const player of game.players) {
        let privateMessage;

        switch (player.role) {
            case 'DON_MAFIA':
                const mafiaNameForDon = simpleMafia ? simpleMafia.username : 'ОДИН ИГРОК';
                privateMessage = 
                    `**Ваша роль:** ${ROLE_NAMES['DON_MAFIA']}\n` +
                    `**Ваши действия:** вы глава мафии и принимаете окончательное решение во всех делах, каждую ночь вы можете проверить одного игрока является ли он **ШЕРИФОМ** и получите ответ, а также вместе с игроком **МАФИЯ (${mafiaNameForDon})** выбираете жертву которую хотите убить.\n\n` +
                    (simpleMafia ? `МАФИЯ: ${simpleMafia.username}` : '');
                break;

            case 'MAFIA':
                if (mafiaCountTotal === 2) {
                    const donNameForMafia = donMafia ? donMafia.username : 'ОДИН ИГРОК';
                    privateMessage = 
                        `**Ваша роль:** ${ROLE_NAMES['MAFIA']}\n` +
                        `**Ваши действия:** каждую ночь вы вместе с игроком **ДОНОМ МАФИИ (${donNameForMafia})** выбираете жертву которую хотите убить.\n` +
                        `ДОН МАФИИ: ${donMafia.username}`;
                } else {
                    privateMessage = 
                        `**Ваша роль:** ${ROLE_NAMES['MAFIA']}\n` +
                        `**Ваши действия:** каждую ночь вы выбираете жертву которую хотите убить.`;
                }
                break;
                
            case 'DOCTOR':
                privateMessage = 
                    `**Ваша роль:** ${ROLE_NAMES['DOCTOR']}\n` +
                    `**Ваши действия:** каждую ночь вы можете выбрать одного игрока которого вы хотите вылечить. Вы можете **вылечить себя только один раз** за игру.`;
                break;
                
            case 'SHERIFF':
                privateMessage = 
                    `**Ваша роль:** ${ROLE_NAMES['SHERIFF']}\n` +
                    `**Ваши действия:** каждую ночью вы можете проверить одного игрока и узнать его роль в игре (Мафия или Мирный).`;
                break;
                
            case 'CIVILIAN':
                privateMessage = 
                    `**Ваша роль:** ${ROLE_NAMES['CIVILIAN']}\n` +
                    `**Ваши действия:** ночью у вас нет дел вы можете спать спокойно.`;
                break;
            default:
                continue;
        }

        bot.sendMessage(player.userId, privateMessage, { 
            parse_mode: 'Markdown'
        }).catch(err => {
             console.error(`Не удалось отправить сообщение ${player.username}:`, err.response?.body?.description || err.message);
             bot.sendMessage(game.chatId, `⚠️ Не могу связаться с ${player.username}. Пожалуйста, начните диалог со мной в ЛС!`);
        });
    }

    bot.sendMessage(game.chatId,
        `\n\n**ЗНАКОМСТВО**\n\n` + 
        `Город знакомится с жителями...`,
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
    game.night = {
        mafiaKillTargetId: null,
        mafiaCheckTargetId: null,
        doctorSaveId: null,
        sheriffCheckId: null,
    }; 
    game.killedThisNight = null;

    game.players.forEach(p => p.nightAction = null);
    game.round++; 

    bot.sendMessage(game.chatId, 
        `\n\n🌙 **РАУНД ${game.round}: НАСТУПАЕТ НОЧЬ!**\n\nВсе мирные жители спят. Активные роли делают свой выбор в личных сообщениях.`
    );

    const alivePlayers = getAlivePlayers(game);

    for (const player of alivePlayers) {
        
        let excludeId = null;

        switch (player.role) {
            case 'DON_MAFIA':
                sendDonMafiaCheckRequest(game, player.userId, alivePlayers);
                continue; 
                
            case 'MAFIA':
                const donMafia = game.players.find(p => p.role === 'DON_MAFIA');
                if (donMafia && donMafia.isAlive) {
                    bot.sendMessage(player.userId, `🔪 **МАФИЯ**. Ждите распоряжения **Дона Мафии** (${donMafia.username}).`, { parse_mode: 'Markdown' });
                    continue;
                } else {
                    startMafiaKillVote(game, player.userId);
                    continue;
                }
                
            case 'DOCTOR':
                // *** ЛОГИКА ОГРАНИЧЕНИЯ САМОЛЕЧЕНИЯ ***
                if (player.selfHealedOnce) {
                    // Если Доктор уже лечил себя, исключаем его из списка целей
                    excludeId = player.userId;
                    bot.sendMessage(player.userId, `⚠️ **Внимание!** Вы уже использовали свою единственную возможность вылечить себя. Выберите другого игрока.`, { parse_mode: 'Markdown' });
                }
                sendGenericNightActionRequest(game, player.userId, 'DOCTOR', alivePlayers, excludeId);
                break;
                
            case 'SHERIFF':
                sendGenericNightActionRequest(game, player.userId, 'SHERIFF', alivePlayers, player.userId);
                break;
                
            case 'CIVILIAN':
                sendGenericNightActionRequest(game, player.userId, 'CIVILIAN', alivePlayers);
                break;
            default:
                continue;
        }
    }
}

function sendDonMafiaCheckRequest(game, userId, alivePlayers) {
    const buttons = createPlayerButtons(alivePlayers, userId);
    const inlineKeyboard = buttons.map(row => 
        row.map(btn => {
            const targetIdFromVote = btn.callback_data.split('_')[1]; 
            return {
                text: btn.text,
                callback_data: `night_action_check_${targetIdFromVote}_group_${game.chatId}` 
            };
        })
    );
        
    bot.sendMessage(userId, `👑 **ДОН МАФИИ**, выберите игрока для **ПРОВЕРКИ НА ШЕРИФА**:`, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
    }).catch(() => {});
}

function startMafiaKillVote(game, initiatingUserId) {
    const alivePlayers = getAlivePlayers(game);
    const player = game.players.find(p => p.userId === initiatingUserId);
    const isDon = player.role === 'DON_MAFIA';
    
    const excludeId = getAlivePlayers(game).filter(p => p.role === 'MAFIA' || p.role === 'DON_MAFIA').length > 1 ? initiatingUserId : null;
    
    const buttons = createPlayerButtons(alivePlayers, excludeId);
    
    const inlineKeyboard = buttons.map(row => 
        row.map(btn => {
            const targetIdFromVote = btn.callback_data.split('_')[1]; 
            return {
                text: btn.text,
                callback_data: `night_action_mafia_vote_${targetIdFromVote}_group_${game.chatId}` 
            };
        })
    );
    
    bot.sendMessage(initiatingUserId, 
        `${isDon ? '🔥 **ДОН МАФИИ**' : '🔪 **МАФИЯ**'}, выберите **ЖЕРТВУ** на эту ночь:`, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
    }).catch(() => {});
}

function sendGenericNightActionRequest(game, userId, role, alivePlayers, excludeId = null) {
    // В отличие от стандартного createPlayerButtons, здесь excludeId используется
    // для исключения цели, которую нельзя выбрать (например, Доктор себя)
    const buttons = createPlayerButtons(alivePlayers, excludeId);
    const actionData = `night_action_${role}`;

    const inlineKeyboard = buttons.map(row => 
        row.map(btn => {
            const targetIdFromVote = btn.callback_data.split('_')[1]; 
            return {
                text: btn.text,
                callback_data: `${actionData}_${targetIdFromVote}_group_${game.chatId}` 
            };
        })
    );
    
    const privateMessage = (role === 'DOCTOR' ? '🩺 **ДОКТОР**' : role === 'SHERIFF' ? '🕵️‍♂️ **ШЕРИФ**' : '🏘️ **МИРНЫЙ ЖИТЕЛЬ**') + `, сделайте свой выбор:`;
        
    bot.sendMessage(userId, privateMessage, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: inlineKeyboard }
    }).catch(() => {});
}


function sendMafiaAgreementRequest(game, proposerId, targetId) {
    const proposer = game.players.find(p => p.userId === proposerId);
    const target = game.players.find(p => p.userId === targetId);
    
    const otherMafia = game.players.find(p => 
        (p.role === 'MAFIA' || p.role === 'DON_MAFIA') && p.isAlive && p.userId !== proposerId
    );

    if (!otherMafia) {
        proposer.nightAction = targetId; 
        return checkNightActions(game);
    }
    
    const proposerRoleName = proposer.role === 'DON_MAFIA' ? 'ДОН МАФИИ' : 'МАФИЯ';

    const requestMessage = 
        `Ваш напарник (**${proposerRoleName}, ${proposer.username}**) предложил убить этой ночью **${target.username}**.\n\nСогласны?`;

    const keyboard = [
        [{ text: '✅ Согласиться', callback_data: `night_action_agree_${targetId}_group_${game.chatId}` }],
        [{ text: '❌ Предложить иного игрока', callback_data: `night_action_propose_group_${game.chatId}` }]
    ];
    
    bot.sendMessage(otherMafia.userId, requestMessage, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {});
}


// 5.2. Проверка действий ночи и переход к результату 
function checkNightActions(game) {
    const alivePlayers = getAlivePlayers(game);
    
    const allMafia = alivePlayers.filter(p => p.role === 'MAFIA' || p.role === 'DON_MAFIA');
    const nonMafia = alivePlayers.filter(p => p.role !== 'MAFIA' && p.role !== 'DON_MAFIA');
    
    const allNonMafiaDone = nonMafia.every(p => p.nightAction !== null);

    let mafiaDone;
    
    if (allMafia.length === 1) {
        mafiaDone = allMafia.every(p => p.nightAction !== null);
    } else if (allMafia.length >= 2) {
        const donMafia = allMafia.find(p => p.role === 'DON_MAFIA');
        const donCheckDone = donMafia ? (game.night.mafiaCheckTargetId !== null) : true;
        const allMafiaVoted = allMafia.every(p => p.nightAction !== null);
        
        mafiaDone = donCheckDone && allMafiaVoted;
    } else {
        mafiaDone = true; 
    }
    
    if (allNonMafiaDone && mafiaDone) {
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
    
    const targetId = game.night.mafiaKillTargetId;
    const savedId = game.night.doctorSaveId;

    let resultMessage;

    if (!targetId || targetId === savedId) {
        resultMessage = targetId ? 
            `Мафия сделала свой выбор, но **Доктор** оказался рядом и спас жителя! Никто не погиб.` :
            'Мафия не смогла договориться и никого не убила! Город в безопасности.';
    } else {
        const targetPlayer = game.players.find(p => p.userId === targetId);

        game.killedThisNight = targetId;
        targetPlayer.isAlive = false;
        
        const roleInRussian = ROLE_NAMES[targetPlayer.role] || targetPlayer.role;
        
        resultMessage = `Мафия сделала свой выбор: 🩸 **${targetPlayer.username}** (роль: **${roleInRussian}**) был убит этой ночью.`;
        
        const winner = checkWinCondition(game);
        if (winner) {
            return endGame(game, winner);
        }
    }
    
    const finalNightMessage = 
        `--- 📰 НОЧНЫЕ НОВОСТИ ---\n${resultMessage}\n------------------\n\n${getAlivePlayers(game).length} игроков остаются в игре.`;

    bot.editMessageText(finalNightMessage, {
        chat_id: game.chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
    }).catch(err => {
        if (err.response && err.response.statusCode !== 400) {
            bot.sendMessage(game.chatId, finalNightMessage, { parse_mode: 'Markdown' });
        }
    });
    
    game.status = 'day_announcement';
    
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
    
    const statusText = 
        `🗳️ **ГОЛОСОВАНИЕ:** ${votedCount} / ${aliveCount} (${voterUsername}) проголосовал против **${targetUsername}**.`;
    
    bot.sendMessage(game.chatId, statusText, { parse_mode: 'Markdown' }).then(() => {
        if (votedCount === aliveCount) {
            game.status = 'day_end';
            
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
            `⚖️ **НИЧЬЯ!** Игроки **${candidatesNames.join('** и **')}** набрали одинаковое количество голосов (${maxVotes}). Город отправляется на дополнительное голосование!`,
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

    const executedPlayer = game.players.find(p => p.userId === leadingCandidates[0].id);
    executedPlayer.isAlive = false;
    
    const roleInRussian = ROLE_NAMES[executedPlayer.role] || executedPlayer.role;

    bot.sendMessage(game.chatId, 
        `\n\n🔨 **РЕЗУЛЬТАТ СУДА**\n\nЖители сделали свой выбор: **${executedPlayer.username}** (роль: **${roleInRussian}**) был казнен!`, 
        { parse_mode: 'Markdown' }
    ).then(() => {
        const winner = checkWinCondition(game);
        if (winner) {
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