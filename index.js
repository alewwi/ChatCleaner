import { cleanChat, DEFAULT_SETTINGS } from './cleaner.js';

const MODULE = 'chatCleaner';
const FOLDER = 'third-party/ChatCleaner';

let busy = false;

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = extensionSettings[MODULE];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(value);
    }
    return settings;
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

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
        row.find('.chat-cleaner-marker').val(rule.marker)
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
    $('#chat_cleaner_keep_last').val(settings.keepLast).on('input', e => {
        settings.keepLast = Math.max(0, Math.floor(Number(e.target.value) || 0));
        save();
    });
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
        settings.rules.push({ marker: '', mode: 'whole', enabled: true });
        save();
        renderRules();
        $('#chat_cleaner_rules .chat-cleaner-marker').last().trigger('focus');
    });
    $('#chat_cleaner_analyze').on('click', () => analyze());
    $('#chat_cleaner_run').on('click', () => runCleaning());
    renderRules();
}

// ---------- Отчёт ----------

function hasChanges(stats) {
    return stats.touched > 0;
}

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

/** Копирует файл чата с диска: бэкап совпадает с сохранённым файлом байт в байт по содержимому. */
async function makeBackup(ctx) {
    const settings = getSettings();
    const chatId = ctx.getCurrentChatId();
    const isGroup = Boolean(ctx.groupId);
    const character = isGroup ? null : ctx.characters[ctx.characterId];

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
    if (data.length - 1 !== ctx.chat.length) {
        throw new Error(`на диске ${data.length - 1} сообщ., в открытом чате ${ctx.chat.length}`);
    }

    const name = `${chatId} - backup ${ctx.humanizedDateTime()}`;
    if (isGroup || settings.backupTarget === 'download') {
        downloadJsonl(name, data);
        return `скачан файл «${name}.jsonl»`;
    }

    const saved = await fetch('/api/chats/save', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ ch_name: character.name, file_name: name, chat: data, avatar_url: character.avatar, force: true }),
    });
    if (!saved.ok) throw new Error(`не удалось сохранить бэкап (${saved.status})`);
    return `чат «${name}» в списке чатов персонажа`;
}

// ---------- Запуск ----------

function isGenerating() {
    return $('#mes_stop').is(':visible');
}

function checkReady(ctx) {
    if (!ctx.getCurrentChatId() || !Array.isArray(ctx.chat) || !ctx.chat.length) {
        toastr.warning('Сначала откройте чат.', 'Очистка чата');
        return false;
    }
    if (isGenerating()) {
        toastr.warning('Дождитесь окончания генерации.', 'Очистка чата');
        return false;
    }
    return true;
}

async function analyze() {
    const ctx = SillyTavern.getContext();
    if (!checkReady(ctx)) return;
    const stats = cleanChat(ctx.chat, getSettings(), { apply: false });
    const title = hasChanges(stats) ? 'Что будет удалено' : 'Чистить нечего';
    await ctx.callGenericPopup(renderReport(stats, title), ctx.POPUP_TYPE.TEXT, '', { wide: false });
}

async function runCleaning() {
    if (busy) return;
    const ctx = SillyTavern.getContext();
    if (!checkReady(ctx)) return;
    const settings = getSettings();

    busy = true;
    try {
        const chatId = ctx.getCurrentChatId();
        const preview = cleanChat(ctx.chat, settings, { apply: false });
        if (!hasChanges(preview)) {
            toastr.info('В этом чате чистить нечего.', 'Очистка чата');
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
        const result = await popup.show();
        if (result !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
        if (ctx.getCurrentChatId() !== chatId) {
            toastr.warning('Чат сменился, очистка отменена.', 'Очистка чата');
            return;
        }
        if (!checkReady(ctx)) return;

        const doBackup = settings.backupMode === 'auto'
            || (settings.backupMode === 'ask' && Boolean(popup.inputResults?.get('chat_cleaner_do_backup')));

        // Сначала сохраняем чат, чтобы бэкап взял с диска всё, что есть в памяти.
        await ctx.saveChat();
        if (doBackup) {
            try {
                const where = await makeBackup(ctx);
                toastr.success(`Бэкап: ${where}`, 'Очистка чата');
            } catch (error) {
                console.error('[ChatCleaner] backup failed', error);
                toastr.error(`Бэкап не удался: ${error.message}. Чат не тронут.`, 'Очистка чата', { timeOut: 10000 });
                return;
            }
        }

        const stats = cleanChat(ctx.chat, settings, { apply: true });
        await ctx.saveChat();
        await ctx.reloadCurrentChat();
        toastr.success(`Готово: ${mb(stats.bytesBefore)} → ${mb(stats.bytesAfter)}`, 'Очистка чата');
    } catch (error) {
        console.error('[ChatCleaner] cleaning failed', error);
        toastr.error(`Очистка прервана: ${error.message}`, 'Очистка чата', { timeOut: 10000 });
    } finally {
        busy = false;
    }
}

jQuery(async () => {
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();
    const html = await renderExtensionTemplateAsync(FOLDER, 'settings');
    $('#extensions_settings2').append(html);
    bindSettings();
});
