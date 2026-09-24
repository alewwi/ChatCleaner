import { cleanChat, DEFAULT_SETTINGS } from './cleaner.js';

const MODULE = 'chatCleaner';
// Папку берём из адреса модуля: расширение работает под любым именем папки и при установке «для всех».
const FOLDER = decodeURIComponent(new URL('.', import.meta.url).pathname)
    .match(/\/scripts\/extensions\/(.+?)\/?$/)?.[1] ?? 'third-party/ChatCleaner';
const TITLE = 'Очистка чата';

let busy = false;

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE] || typeof extensionSettings[MODULE] !== 'object') {
        extensionSettings[MODULE] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = extensionSettings[MODULE];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(value);
    }
    if (!Array.isArray(settings.rules)) settings.rules = [];
    if (settings.rules.some(rule => !rule || typeof rule !== 'object')) {
        settings.rules = settings.rules.filter(rule => rule && typeof rule === 'object');
    }
    return settings;
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// Для окон. Тосты SillyTavern экранирует сам (escapeHtml: true в настройках toastr).
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mb = bytes => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1048576).toFixed(1)} МБ`);

// ---------- Правила ----------

function renderRules() {
    const settings = getSettings();
    const list = $('#chat_cleaner_rules').empty();
    settings.rules.forEach((rule, index) => {
        const row = $(`
            <div class="chat-cleaner-rule">
                <input type="checkbox" class="chat-cleaner-enabled" title="Правило включено">
                <input type="text" class="text_pole chat-cleaner-marker" placeholder="<тег> или [МЕТКА]">
                <select class="text_pole chat-cleaner-mode">
                    <option value="whole">Весь блок</option>
                    <option value="code">Только код</option>
                </select>
                <div class="menu_button fa-solid fa-trash-can" title="Удалить правило"></div>
            </div>`);
        row.find('.chat-cleaner-enabled').prop('checked', rule.enabled !== false)
            .on('change', e => { rule.enabled = e.target.checked; save(); });
        row.find('.chat-cleaner-marker').val(rule.marker ?? '')
            .on('input', e => { rule.marker = e.target.value; save(); });
        row.find('.chat-cleaner-mode').val(rule.mode === 'code' ? 'code' : 'whole')
            .on('change', e => { rule.mode = e.target.value; save(); });
        row.find('.fa-trash-can').on('click', () => {
            settings.rules.splice(index, 1);
            save();
            renderRules();
        });
        list.append(row);
    });
}

function bindSettings() {
    const settings = getSettings();
    $('#chat_cleaner_keep_last').val(settings.keepLast)
        .on('input', e => {
            // Пустое поле — это «ещё печатаю», а не ноль: иначе очистка задела бы свежие сообщения.
            const value = String(e.target.value).trim();
            const number = Math.floor(Number(value));
            if (value === '' || !Number.isFinite(number) || number < 0) return;
            settings.keepLast = number;
            save();
        })
        .on('change blur', e => { e.target.value = settings.keepLast; });
    $('#chat_cleaner_swipes').prop('checked', settings.cleanSwipes).on('change', e => {
        settings.cleanSwipes = e.target.checked;
        save();
    });
    $('#chat_cleaner_backup_mode').val(settings.backupMode).on('change', e => {
        settings.backupMode = e.target.value;
        save();
    });
    $('#chat_cleaner_backup_target').val(settings.backupTarget).on('change', e => {
        settings.backupTarget = e.target.value;
        save();
    });
    $('#chat_cleaner_strip_html').prop('checked', settings.stripHtml).on('change', e => {
        settings.stripHtml = e.target.checked;
        save();
    });
    $('#chat_cleaner_protected').val(settings.protectedBlocks).on('input', e => {
        settings.protectedBlocks = e.target.value;
        save();
    });
    $('#chat_cleaner_add_rule').on('click', () => {
        getSettings().rules.push({ marker: '', mode: 'whole', enabled: true });
        save();
        renderRules();
        $('#chat_cleaner_rules .chat-cleaner-marker').last().trigger('focus');
    });
    $('#chat_cleaner_analyze').on('click', () => analyze());
    $('#chat_cleaner_run').on('click', () => runCleaning());
    renderRules();
}

// ---------- Отчёт ----------

function renderReport(stats, title) {
    const rows = [];
    const row = (label, value) => rows.push(`<tr><td>${label}</td><td>${value}</td></tr>`);
    row('Сообщений в чате', stats.messages);
    row('Нетронутые последние', stats.messages - stats.keepFrom);
    row('Сообщений изменится', stats.touched);
    row('Свайпов удалится', stats.swipes);
    if (stats.swipeFixes) row('Сбитых указателей свайпа починится', stats.swipeFixes);
    for (const [label, count] of Object.entries(stats.blocks)) row(`Блоков ${escapeHtml(label)}`, count);
    row('HTML-тегов снимется', stats.htmlTags);
    row('Размер', `${mb(stats.bytesBefore)} → ${mb(stats.bytesAfter)}`);

    const warnings = [];
    if (stats.swipeSkipped) {
        warnings.push(`В ${stats.swipeSkipped} сообщ. не нашёлся свайп, совпадающий с текстом. Их свайпы оставлены как есть.`);
    }
    if (stats.conflicts.length) {
        warnings.push(`Правила ${stats.conflicts.map(escapeHtml).join(', ')} пропущены: эти блоки в списке защищённых.`);
    }
    if (stats.protectedSkipped) {
        warnings.push(`В ${stats.protectedSkipped} сообщ. очистка задела бы защищённый блок. Эти сообщения оставлены как есть.`);
    }
    return `
        <div class="chat-cleaner-report">
            <h3>${title}</h3>
            <table>${rows.join('')}</table>
            ${warnings.map(w => `<p class="chat-cleaner-warn">${w}</p>`).join('')}
        </div>`;
}

// ---------- Бэкап ----------

function downloadJsonl(name, data) {
    const blob = new Blob([data.map(line => JSON.stringify(line)).join('\n')], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.jsonl`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Копирует файл чата с диска. Перед этим сверяет файл с открытым чатом:
 * SillyTavern не сообщает об ошибках сохранения, и без сверки бэкап мог бы оказаться устаревшим.
 * @returns {Promise<{where: string, downloaded: boolean}>}
 */
async function makeBackup(ctx) {
    const settings = getSettings();
    const chatId = ctx.getCurrentChatId();
    const isGroup = Boolean(ctx.groupId);
    const character = isGroup ? null : ctx.characters[ctx.characterId];
    if (!isGroup && !character) throw new Error('не найден персонаж открытого чата');

    const response = await fetch(isGroup ? '/api/chats/group/get' : '/api/chats/get', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify(isGroup
            ? { id: chatId }
            : { ch_name: character.name, file_name: chatId, avatar_url: character.avatar }),
    });
    if (!response.ok) throw new Error(`не удалось прочитать чат с диска (${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) throw new Error('файл чата на диске пуст или не найден');
    const onDisk = data.slice(1);
    if (onDisk.length !== ctx.chat.length || onDisk.some((msg, i) => msg?.mes !== ctx.chat[i]?.mes)) {
        throw new Error('чат на диске отличается от открытого — похоже, он не сохранился');
    }

    const name = `${chatId} - backup ${ctx.humanizedDateTime()}`;
    if (isGroup || settings.backupTarget === 'download') {
        downloadJsonl(name, data);
        return { where: `файл «${name}.jsonl»`, downloaded: true };
    }

    const saved = await fetch('/api/chats/save', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ ch_name: character.name, file_name: name, chat: data, avatar_url: character.avatar, force: true }),
    });
    if (!saved.ok) throw new Error(`не удалось сохранить бэкап (${saved.status})`);
    return { where: `чат «${name}» в списке чатов персонажа`, downloaded: false };
}

// ---------- Запуск ----------

/** Причина, по которой сейчас чистить нельзя, или null. */
function blockedReason(ctx) {
    if (!ctx.getCurrentChatId() || !Array.isArray(ctx.chat) || !ctx.chat.length) return 'Сначала откройте чат.';
    if ($('#mes_stop').is(':visible')) return 'Дождитесь окончания генерации.';
    const swipeState = ctx.swipe?.state?.();
    if (swipeState && swipeState !== 'none') return 'Дождитесь окончания свайпа.';
    if (document.querySelector('#chat .edit_textarea')) return 'Сначала закончите редактирование сообщения.';
    return null;
}

function checkReady(ctx) {
    const reason = blockedReason(ctx);
    if (reason) toastr.warning(reason, TITLE);
    return !reason;
}

async function analyze() {
    if (busy) return;
    const ctx = SillyTavern.getContext();
    if (!checkReady(ctx)) return;
    const stats = cleanChat(ctx.chat, getSettings(), { apply: false });
    const title = stats.touched ? 'Что будет удалено' : 'Чистить нечего';
    await ctx.callGenericPopup(renderReport(stats, title), ctx.POPUP_TYPE.TEXT, '', { wide: false });
}

/** Отмена очистки с сообщением пользователю. */
class Abort extends Error {}

/**
 * То, что меняет очистка: текст, число свайпов и копия текста для показа.
 * swipe_info не берём: SillyTavern сам достраивает его при загрузке.
 */
const fingerprint = msg => JSON.stringify([msg?.mes, msg?.swipes?.length ?? 0, msg?.extra?.display_text ?? '']);

async function runCleaning() {
    if (busy) return;
    const ctx = SillyTavern.getContext();
    if (!checkReady(ctx)) return;
    const settings = getSettings();
    const chatId = ctx.getCurrentChatId();
    // Пока идёт бэкап, пользователь мог открыть другой чат: SillyTavern подменяет содержимое того же массива chat.
    const assertSameChat = () => {
        if (ctx.getCurrentChatId() !== chatId) throw new Abort('Чат сменился, очистка отменена.');
        const reason = blockedReason(ctx);
        if (reason) throw new Abort(`${reason} Очистка отменена.`);
    };

    busy = true;
    let applied = false;
    try {
        const preview = cleanChat(ctx.chat, settings, { apply: false });
        if (!preview.touched) {
            toastr.info('В этом чате чистить нечего.', TITLE);
            return;
        }

        const backupNote = {
            auto: '<p>Перед очисткой будет сделан бэкап.</p>',
            ask: '',
            off: '<p class="chat-cleaner-warn">Бэкапы отключены: удалённое вернуть не получится.</p>',
        }[settings.backupMode] ?? '';
        const popup = new ctx.Popup(renderReport(preview, 'Очистить чат?') + backupNote, ctx.POPUP_TYPE.CONFIRM, '', {
            okButton: 'Очистить',
            cancelButton: 'Отмена',
            customInputs: settings.backupMode === 'ask'
                ? [{ id: 'chat_cleaner_do_backup', label: 'Сделать бэкап перед очисткой', type: 'checkbox', defaultState: true }]
                : null,
        });
        if (await popup.show() !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
        assertSameChat();

        const doBackup = settings.backupMode === 'auto'
            || (settings.backupMode === 'ask' && Boolean(popup.inputResults?.get('chat_cleaner_do_backup')));

        // Сначала сохраняем чат, чтобы бэкап взял с диска всё, что есть в памяти.
        await ctx.saveChat();
        assertSameChat();
        if (doBackup) {
            let backup;
            try {
                backup = await makeBackup(ctx);
            } catch (error) {
                console.error('[ChatCleaner] backup failed', error);
                throw new Abort(`Бэкап не удался: ${error.message}. Чат не тронут.`);
            }
            if (backup.downloaded) {
                // Скачивание может заблокировать браузер, а узнать об этом из страницы нельзя.
                const confirmed = await ctx.callGenericPopup(
                    `<p>Бэкап скачивается как ${escapeHtml(backup.where)}.</p><p>Убедитесь, что файл сохранился, и только потом продолжайте.</p>`,
                    ctx.POPUP_TYPE.CONFIRM, '', { okButton: 'Файл сохранён, очистить', cancelButton: 'Отмена' });
                if (confirmed !== ctx.POPUP_RESULT.AFFIRMATIVE) throw new Abort('Очистка отменена. Чат не тронут.');
            } else {
                toastr.success(`Бэкап: ${backup.where}`, TITLE);
            }
            assertSameChat();
        }

        const stats = cleanChat(ctx.chat, settings, { apply: true });
        applied = true;
        const expected = ctx.chat.map(fingerprint);
        await ctx.saveChat();
        await ctx.reloadCurrentChat();
        applied = false;

        // SillyTavern глотает ошибки сохранения, поэтому проверяем, что на диске действительно новая версия.
        const reloaded = SillyTavern.getContext();
        const persisted = reloaded.getCurrentChatId() === chatId
            && reloaded.chat.length === expected.length
            && reloaded.chat.every((msg, i) => fingerprint(msg) === expected[i]);
        if (!persisted) {
            toastr.error('Очистка не сохранилась: SillyTavern не записал чат на диск. Открыт прежний чат, попробуйте ещё раз.', TITLE, { timeOut: 15000 });
            return;
        }
        toastr.success(`Готово: ${mb(stats.bytesBefore)} → ${mb(stats.bytesAfter)}`, TITLE);
    } catch (error) {
        if (error instanceof Abort) {
            toastr.warning(error.message, TITLE, { timeOut: 10000 });
        } else {
            console.error('[ChatCleaner] cleaning failed', error);
            toastr.error(`Очистка прервана: ${error?.message ?? error}`, TITLE, { timeOut: 10000 });
        }
        if (applied) {
            // Очищенный чат остался только в памяти. Возвращаем то, что на диске, чтобы автосохранение его не записало.
            await ctx.reloadCurrentChat().catch(e => console.error('[ChatCleaner] reload failed', e));
        }
    } finally {
        busy = false;
    }
}

jQuery(async () => {
    try {
        const { renderExtensionTemplateAsync } = SillyTavern.getContext();
        const html = await renderExtensionTemplateAsync(FOLDER, 'settings');
        $('#extensions_settings2').append(html);
        bindSettings();
    } catch (error) {
        console.error(`[ChatCleaner] не удалось загрузить панель из ${FOLDER}`, error);
    }
});
