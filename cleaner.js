// Логика очистки чата. Без зависимостей от SillyTavern: модуль можно гонять в node на файлах .jsonl.

// Текстовые поля в extra, которые HUD и ExtBlocks хранят рядом с mes. SillyTavern рендерит
// display_text вместо mes, поэтому чистить только mes бесполезно.
export const TEXT_EXTRA_KEYS = ['display_text', 'reproRaw', 'extblocks'];

export const DEFAULT_SETTINGS = Object.freeze({
    keepLast: 10,
    cleanSwipes: true,
    backupMode: 'auto',        // auto | ask | off
    backupTarget: 'chat',      // chat | download
    stripHtml: true,
    protectedBlocks: '',
    rules: [],
});

// Элементы, которые вырезаются вместе с содержимым: внутри них только код.
const CODE_ELEMENTS = ['style', 'script', 'html', 'head', 'svg', 'iframe', 'canvas', 'video', 'audio', 'noscript', 'template', 'object'];
// Теги без текста.
const VOID_TAGS = ['img', 'input', 'source', 'track', 'meta', 'link', 'base', 'embed', 'param', 'wbr', 'area', 'col'];
// Блочные теги: снимаются, на их месте остаётся перевод строки.
const BLOCK_TAGS = ['body', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'header', 'footer', 'article',
    'aside', 'main', 'nav', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
    'blockquote', 'pre', 'details', 'summary', 'figure', 'figcaption', 'form', 'fieldset', 'legend', 'dl', 'dt', 'dd',
    'center', 'address', 'menu', 'dialog', 'textarea', 'select', 'option'];
// Строчные теги: снимаются бесследно. <time> здесь нет намеренно: в ролевых чатах это сюжетный тег.
const INLINE_TAGS = ['span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'font', 'a', 'small', 'big',
    'sub', 'sup', 'mark', 'abbr', 'cite', 'q', 'code', 'kbd', 'samp', 'var', 'button', 'label', 'tt', 'dfn', 'bdi',
    'bdo', 'ruby', 'rt', 'rp', 'output', 'meter', 'progress'];

// Конец имени тега: `<b>` не должен цеплять `<body>`, а `<head>` — `<header>`.
const NAME_END = '(?![\\w:.-])';
const tagAlt = list => list.join('|');

const RE_DOCTYPE = /<!DOCTYPE[^>]*>/gi;
const RE_CODE_ELEMENT = new RegExp(`<(${tagAlt(CODE_ELEMENTS)})${NAME_END}[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
const RE_CODE_LEFTOVER = new RegExp(`<\\/?(?:${tagAlt(CODE_ELEMENTS)})${NAME_END}[^>]*>`, 'gi');
const RE_VOID = new RegExp(`<\\/?(?:${tagAlt(VOID_TAGS)})${NAME_END}[^>]*>`, 'gi');
const RE_BREAK = new RegExp(`<\\/?(?:br|hr)${NAME_END}[^>]*>`, 'gi');
const RE_BLOCK = new RegExp(`<\\/?(?:${tagAlt(BLOCK_TAGS)})${NAME_END}[^>]*>`, 'gi');
const RE_INLINE = new RegExp(`<\\/?(?:${tagAlt(INLINE_TAGS)})${NAME_END}[^>]*>`, 'gi');
const RE_FENCE = /```[^\n`]*\n[\s\S]*?```/g;

// Заглушки для защищённых блоков: символы из Private Use Area в тексте чата не встречаются.
const PH_OPEN = '';
const PH_CLOSE = '';
const RE_PLACEHOLDER = /(\d+)/g;

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Убирает переносы и пробелы, оставшиеся после вырезания. */
function tidy(s) {
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Снимает HTML-оформление, оставляя текст. Код (<style>, <script>, <html>, <svg>…) удаляется целиком.
 * @param {string} text
 * @param {{fences?: boolean}} options fences — удалять и блоки ```код```
 * @param {object|null} stats сюда добавляется число снятых тегов
 */
export function stripHtml(text, { fences = false } = {}, stats = null) {
    let count = 0;
    const drop = () => { count++; return ''; };
    const newline = () => { count++; return '\n'; };
    let s = text.replace(RE_DOCTYPE, drop).replace(RE_CODE_ELEMENT, drop).replace(RE_CODE_LEFTOVER, drop);
    if (fences) s = s.replace(RE_FENCE, drop);
    s = s.replace(RE_VOID, drop).replace(RE_BREAK, newline).replace(RE_BLOCK, newline).replace(RE_INLINE, drop);
    if (!count) return text;
    if (stats) stats.htmlTags += count;
    // Отступы от вложенной вёрстки markdown принял бы за блок кода, поэтому снимаем их.
    return tidy(s.replace(/^[ \t]+/gm, ''));
}

/**
 * Разбирает то, что ввёл пользователь: `<тег>`, `[МЕТКА]`, `[МЕТКА С ПРОБЕЛОМ]` или слово без скобок.
 * @returns {{kind: 'tag'|'bracket'|'any', name: string, label: string}|null}
 */
export function parseMarker(raw) {
    const str = String(raw ?? '').trim();
    if (!str) return null;
    let m;
    if (str.startsWith('<')) {
        m = str.match(/^<\s*\/?\s*([A-Za-z][\w:.-]*)/);
        return m ? { kind: 'tag', name: m[1], label: `<${m[1]}>` } : null;
    }
    if (str.startsWith('[')) {
        m = str.match(/^\[\s*\/?\s*([^\]|:]+?)\s*(?:[\]|:]|$)/);
        return m ? { kind: 'bracket', name: m[1], label: `[${m[1]}]` } : null;
    }
    if (/^[A-Za-z][\w:.-]*$/.test(str)) return { kind: 'any', name: str, label: str };
    return { kind: 'bracket', name: str, label: `[${str}]` };
}

export function parseMarkerList(text) {
    return String(text ?? '').split(/[,\n]+/).map(parseMarker).filter(Boolean);
}

/** `<тег>…</тег>` с учётом вложенности, плюс самозакрывающиеся `<тег/>`. */
function collectTagRanges(text, name, withOrphans, out) {
    const re = new RegExp(`<(\\/?)${escapeRegex(name)}${NAME_END}[^>]*>`, 'gi');
    const stack = [];
    for (const m of text.matchAll(re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (m[1]) {
            if (stack.length) out.push([stack.pop()[0], end]);
            else if (withOrphans) out.push([start, end]);
        } else if (/\/\s*>$/.test(m[0])) {
            out.push([start, end]);
        } else {
            stack.push([start, end]);
        }
    }
    // Незакрытый открывающий тег — сломанная вёрстка, убираем сам тег.
    if (withOrphans) out.push(...stack);
}

/** Конец блока `[…]` с учётом вложенных скобок, или -1. */
function matchBracket(text, start) {
    let depth = 0;
    const limit = Math.min(text.length, start + 200000);
    for (let i = start; i < limit; i++) {
        const c = text[i];
        if (c === '[') depth++;
        else if (c === ']' && --depth === 0) return i + 1;
    }
    return -1;
}

/**
 * `[ИМЯ]…[/ИМЯ]` — от открывающей метки до ближайшей закрывающей.
 * `[ИМЯ: …]` и `[ИМЯ| …]` — до парной закрывающей скобки.
 * Одиночная `[ИМЯ]` без `[/ИМЯ]` не трогается: чаще всего это упоминание в тексте.
 */
function collectBracketRanges(text, name, out) {
    const re = new RegExp(`\\[(\\/?)${escapeRegex(name)}(\\]|[:|])`, 'gi');
    let openStart = -1;
    for (const m of text.matchAll(re)) {
        const start = m.index;
        if (m[2] === ']') {
            if (!m[1]) {
                if (openStart < 0) openStart = start;
            } else if (openStart >= 0) {
                out.push([openStart, start + m[0].length]);
                openStart = -1;
            }
        } else if (!m[1]) {
            const end = matchBracket(text, start);
            if (end > 0) out.push([start, end]);
        }
    }
}

/** Оставляет только внешние диапазоны, без пересечений. */
function outermost(ranges) {
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const result = [];
    let lastEnd = -1;
    for (const r of ranges) {
        if (r[0] >= lastEnd) {
            result.push(r);
            lastEnd = r[1];
        }
    }
    return result;
}

export function findRanges(text, marker, { withOrphans = false } = {}) {
    const out = [];
    if (marker.kind !== 'bracket') collectTagRanges(text, marker.name, withOrphans, out);
    if (marker.kind !== 'tag') collectBracketRanges(text, marker.name, out);
    return outermost(out);
}

function replaceRanges(text, ranges, fn) {
    let result = '';
    let pos = 0;
    for (const [start, end] of ranges) {
        result += text.slice(pos, start) + fn(text.slice(start, end));
        pos = end;
    }
    return result + text.slice(pos);
}

const sameMarker = (a, b) => a.name.toLowerCase() === b.name.toLowerCase()
    && (a.kind === b.kind || a.kind === 'any' || b.kind === 'any');

/** Приводит настройки к рабочему виду. */
export function compileSettings(settings) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const protectedMarkers = parseMarkerList(s.protectedBlocks);
    const rules = [];
    const conflicts = [];
    for (const rule of Array.isArray(s.rules) ? s.rules : []) {
        if (rule?.enabled === false) continue;
        const marker = parseMarker(rule?.marker);
        if (!marker) continue;
        if (protectedMarkers.some(p => sameMarker(p, marker))) {
            conflicts.push(marker.label);
            continue;
        }
        rules.push({ ...marker, mode: rule.mode === 'code' ? 'code' : 'whole' });
    }
    const keepLast = Math.max(0, Math.floor(Number(s.keepLast) || 0));
    return {
        keepLast,
        cleanSwipes: Boolean(s.cleanSwipes),
        stripHtml: Boolean(s.stripHtml),
        protected: protectedMarkers,
        rules,
        conflicts,
        hasTextWork: rules.length > 0 || Boolean(s.stripHtml),
    };
}

export function newStats() {
    return { htmlTags: 0, blocks: {} };
}

/** Чистит одну строку по правилам. Защищённые блоки не трогаются ни при каком правиле. */
export function cleanText(text, cfg, stats) {
    if (typeof text !== 'string' || !text) return text;
    const vault = [];
    let s = text;
    for (const marker of cfg.protected) {
        const ranges = findRanges(s, marker);
        if (ranges.length) {
            s = replaceRanges(s, ranges, slice => `${PH_OPEN}${vault.push(slice) - 1}${PH_CLOSE}`);
        }
    }
    let changed = false;
    for (const rule of cfg.rules) {
        const whole = rule.mode === 'whole';
        let ranges = findRanges(s, rule, { withOrphans: whole });
        if (whole) ranges = ranges.filter(([a, b]) => !s.slice(a, b).includes(PH_OPEN));
        if (!ranges.length) continue;
        s = replaceRanges(s, ranges, slice => (whole ? '' : stripHtml(slice, { fences: true }, stats)));
        stats.blocks[rule.label] = (stats.blocks[rule.label] || 0) + ranges.length;
        changed = true;
    }
    if (cfg.stripHtml) {
        const stripped = stripHtml(s, { fences: false }, stats);
        if (stripped !== s) {
            s = stripped;
            changed = true;
        }
    }
    if (!changed) return text;
    s = tidy(s);
    return vault.length ? s.replace(RE_PLACEHOLDER, (_, i) => vault[Number(i)]) : s;
}

function cleanExtra(extra, cfg, stats) {
    if (!extra || typeof extra !== 'object') return extra;
    let next = extra;
    for (const key of TEXT_EXTRA_KEYS) {
        const value = extra[key];
        if (typeof value !== 'string') continue;
        const cleaned = cleanText(value, cfg, stats);
        if (cleaned !== value) {
            if (next === extra) next = { ...extra };
            next[key] = cleaned;
        }
    }
    return next;
}

/** Оставляет только выбранный свайп. Если swipe_id сбит, ищет свайп, совпадающий с видимым текстом. */
function pruneSwipes(msg, stats) {
    const swipes = msg.swipes;
    if (!Array.isArray(swipes) || swipes.length < 2) return msg;
    let idx = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    if (swipes[idx] !== msg.mes) {
        const found = swipes.indexOf(msg.mes);
        if (found < 0) {
            stats.swipeSkipped++;
            return msg;
        }
        idx = found;
        stats.swipeFixes++;
    }
    const next = { ...msg, swipes: [swipes[idx]], swipe_id: 0 };
    if (Array.isArray(msg.swipe_info)) {
        next.swipe_info = idx < msg.swipe_info.length ? [msg.swipe_info[idx]] : [];
    }
    stats.swipes += swipes.length - 1;
    return next;
}

function cleanMessageText(msg, cfg, stats) {
    // Блоки и теги считаем только по видимому тексту, иначе копии в extra и swipe_info удвоят цифры.
    const shadow = newStats();
    const next = { ...msg };
    let changed = false;
    const clean = (value, st) => {
        const cleaned = cleanText(value, cfg, st);
        if (cleaned !== value) changed = true;
        return cleaned;
    };
    next.mes = clean(msg.mes, stats);
    if (Array.isArray(msg.swipes)) next.swipes = msg.swipes.map(v => clean(v, shadow));
    if (msg.extra) {
        next.extra = cleanExtra(msg.extra, cfg, shadow);
        if (next.extra !== msg.extra) changed = true;
    }
    if (Array.isArray(msg.swipe_info)) {
        next.swipe_info = msg.swipe_info.map(info => {
            if (!info?.extra) return info;
            const extra = cleanExtra(info.extra, cfg, shadow);
            if (extra === info.extra) return info;
            changed = true;
            return { ...info, extra };
        });
    }
    return changed ? next : msg;
}

function utf8Length(str) {
    let bytes = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) bytes += 1;
        else if (c < 0x800) bytes += 2;
        else if (c >= 0xD800 && c <= 0xDBFF) { bytes += 4; i++; }
        else bytes += 3;
    }
    return bytes;
}

/**
 * Чистит массив сообщений (без строки-заголовка).
 * apply=false — только подсчёт, чат не меняется.
 */
export function cleanChat(chat, settings, { apply = false } = {}) {
    const cfg = compileSettings(settings);
    const keepFrom = Math.max(0, chat.length - cfg.keepLast);
    const lastIndex = chat.length - 1;
    const stats = {
        ...newStats(),
        messages: chat.length,
        keepFrom,
        touched: 0,
        swipes: 0,
        swipeFixes: 0,
        swipeSkipped: 0,
        bytesBefore: 0,
        bytesAfter: 0,
        conflicts: cfg.conflicts,
    };
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        let next = msg;
        if (cfg.cleanSwipes && i < lastIndex) next = pruneSwipes(next, stats);
        if (cfg.hasTextWork && i < keepFrom) next = cleanMessageText(next, cfg, stats);
        const before = utf8Length(JSON.stringify(msg));
        stats.bytesBefore += before;
        stats.bytesAfter += next === msg ? before : utf8Length(JSON.stringify(next));
        if (next !== msg) {
            stats.touched++;
            if (apply) chat[i] = next;
        }
    }
    return stats;
}
