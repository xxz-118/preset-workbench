/**
 * 预设工作台 (Preset Workbench) —— SillyTavern UI 扩展
 *
 * 形态：一个可从酒馆「扩展菜单（魔杖图标）」打开的可拖动浮窗，不占用扩展设置页。
 *
 * ── 数据层设计依据（SillyTavern 1.18.0，逐条对照源码核对）─────────────────
 *  1. 磁盘是预设的唯一真相。每次页面加载由 POST /api/settings/get 扫描用户目录重建内存列表：
 *       src/endpoints/settings.js:219   返回 openai_setting_names / openai_settings / ...
 *       src/endpoints/settings.js:92    readPresetsFromDirectory —— 预设名 = 文件名去扩展名
 *       src/endpoints/settings.js:54    readAndParseFromDirectory —— 进阶模板名取内容里的 name 字段
 *     所以本扩展直接重新调用该端点，拿到与磁盘完全一致的列表（含未被 UI 引用到的文件）。
 *  2. 写盘 / 删盘：POST /api/presets/save、POST /api/presets/delete
 *       src/endpoints/presets.js:42 / :60；目录映射见同文件 :16 getPresetSettingsByAPI
 *  3. 运行时句柄：getContext().getPresetManager(apiId)
 *       public/scripts/st-context.js:286
 *  4. 内存同步是硬要求：public/scripts/openai.js:4904 切换预设时
 *       `structuredClone(openai_settings[openai_setting_names[currentName]])`
 *     从内存数组读取。只写盘不同步内存，本次会话内切回去会加载旧内容。
 *  5. 原生 PresetManager.updateList() 在保存后一定会 `.trigger('change')` 把当前预设切走
 *       public/scripts/preset-manager.js:602-633
 *     这正是「必须先切换才能改」的根源。本扩展统一用 `{ skipUpdate: true }` 绕开它，
 *     再自行同步内存数组与下拉框 option，不改变当前预设。
 *
 * ── 浮窗层级依据 ─────────────────────────────────────────────────────
 *  - 酒馆的对话弹窗 #dialogue_popup / #shadow_popup 是 z-index 9999（public/style.css:3677 / :3860）。
 *    本窗口取 9000，**刻意压在弹窗之下**：这样「删除确认」等 Popup 能盖在浮窗之上，
 *    点确认按钮也不会穿透到自己的遮罩而误关窗口。
 *  - 扩展菜单 #extensionsMenu 是 29999（public/style.css:1085），比本窗口高；菜单在点击后
 *    会自行关闭，不影响使用。
 *  - toastr 是 999999，操作反馈始终可见。
 *
 * ── 入口挂载时机 ─────────────────────────────────────────────────────
 *  #extensionsMenu 由 extensions.js:688 addExtensionsButtonAndMenu() 动态生成，
 *  在 script.js:745 initExtensions() 中执行，早于 script.js:7965 loadExtensionSettings()
 *  触发的扩展加载，因此扩展初始化时该容器必然已存在（仍保留重试兜底）。
 */

import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'preset-workbench';
const EXTENSION_PATH = 'third-party/preset-workbench';
const LOG_PREFIX = '[预设工作台]';

/** toastr 由酒馆的 index.html 全局提供；兜底对象保证任何情况下扩展自身不炸。 */
const toastr = window.toastr ?? {
    success: () => { },
    info: () => { },
    warning: () => { },
    error: () => { },
};

/**
 * 受支持的预设类型。apiId 同时是 /api/presets/* 的 apiId 与 getPresetManager 的键。
 * contentsKey / namesKey 指向 POST /api/settings/get 响应里的字段。
 * namesKey === null 表示进阶格式化模板：名字取自内容里的 name 字段，而不是文件名。
 */
const PRESET_TYPES = [
    { apiId: 'openai', label: 'Chat Completion', unit: '预设', icon: 'fa-comments', contentsKey: 'openai_settings', namesKey: 'openai_setting_names' },
    { apiId: 'textgenerationwebui', label: '文本补全', unit: '预设', icon: 'fa-align-left', contentsKey: 'textgenerationwebui_presets', namesKey: 'textgenerationwebui_preset_names' },
    { apiId: 'kobold', label: 'KoboldAI', unit: '预设', icon: 'fa-dragon', contentsKey: 'koboldai_settings', namesKey: 'koboldai_setting_names' },
    { apiId: 'novel', label: 'NovelAI', unit: '预设', icon: 'fa-feather', contentsKey: 'novelai_settings', namesKey: 'novelai_setting_names' },
    { apiId: 'instruct', label: '指令模板', unit: '模板', icon: 'fa-terminal', contentsKey: 'instruct', namesKey: null },
    { apiId: 'context', label: '上下文模板', unit: '模板', icon: 'fa-layer-group', contentsKey: 'context', namesKey: null },
    { apiId: 'sysprompt', label: '系统提示词', unit: '模板', icon: 'fa-scroll', contentsKey: 'sysprompt', namesKey: null },
    { apiId: 'reasoning', label: '推理模板', unit: '模板', icon: 'fa-brain', contentsKey: 'reasoning', namesKey: null },
];

const MIN_WINDOW_WIDTH = 560;
const MIN_WINDOW_HEIGHT = 420;
const WINDOW_EDGE_MARGIN = 16;

/** 视口任一边小于阈值就切到「紧凑模式」：贴边铺满，不拖动、不缩放。 */
const COMPACT_MAX_WIDTH = 720;
const COMPACT_MAX_HEIGHT = 560;
const COMPACT_MARGIN = 8;

/** 扩展自身的仓库坐标，用于检查更新。 */
const UPDATE_REPO = 'xxz-118/preset-workbench';
const UPDATE_RELEASES_LIST_API = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`;
const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases`;

/** 本地版本兜底值；正常情况下读的是 manifest.json 的 version，两者需保持一致。 */
const EXTENSION_VERSION_FALLBACK = '1.3.2';

/**
 * 调用酒馆更新接口时用的扩展名。
 * 酒馆前端自己传的是 name.replace('third-party','') 的结果（public/scripts/extensions.js:919
 * 的 externalId），服务端再用 sanitize() 去掉斜杠拼成目录名
 * （src/endpoints/extensions.js:176-187），所以这里保持同一形态最稳。
 */
const UPDATE_NAME = EXTENSION_PATH.replace('third-party', '');

/** 自动检查更新的最短间隔：同一版本 24 小时内只请求一次 GitHub。 */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const state = {
    /** @type {any} 最近一次 /api/settings/get 的原始响应 */
    snapshot: null,
    /** @type {number} 当前选中的类型下标 */
    typeIndex: 0,
    /** @type {Array<{name:string, raw:string, data:any, size:number, broken:boolean}>} */
    entries: [],
    /** @type {string} 名称过滤词 */
    filter: '',
    /** @type {boolean} 是否有操作正在执行 */
    busy: false,
    /** @type {AbortController|null} 正在进行的快照请求 */
    inflight: null,
    /** @type {boolean} 窗口是否打开 */
    open: false,
};

/** 更新检查的运行时状态。 */
const updateState = {
    localVersion: EXTENSION_VERSION_FALLBACK,
    /** 最新的那个 release（releases 列表首项） */
    latest: null,
    /** 与当前安装版本对应的 release，用于随时查看「本版带来了什么」 */
    currentRelease: null,
    /** 酒馆服务端判定本地仓库落后于远端 */
    hostOutdated: false,
    checking: false,
    hasUpdate: false,
    notesOpen: false,
    /** 是否正在展示当前版本的更新内容（而非新版本提示） */
    showCurrentNotes: false,
    /** @type {string|null} 最近一次检查的错误说明 */
    error: null,
};

// ───────────────────────────── 通用小工具 ─────────────────────────────

function ctx() {
    const c = getContext();
    if (!c) {
        throw new Error('无法获取 SillyTavern 上下文（页面可能还没加载完）');
    }
    return c;
}

function jq(value) {
    return window.jQuery(value);
}

function clamp(value, min, max) {
    if (max < min) {
        return min;
    }
    return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function byteLength(text) {
    try {
        return new Blob([String(text)]).size;
    } catch {
        return String(text).length;
    }
}

function sanitizeFileName(name) {
    return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'preset';
}

function timestamp() {
    const d = new Date();
    const p = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadJson(text, filename) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
function compareVersions(a, b) {
    const parse = (value) => String(value ?? '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) {
            return diff > 0 ? 1 : -1;
        }
    }
    return 0;
}

/**
 * 极简 Markdown 渲染，只覆盖 release notes 实际会用到的语法。
 * 先整体转义再替换标记，所以内容里出现尖括号也不会造成注入。
 */
function renderNotesHtml(markdown) {
    const escaped = escapeHtml(String(markdown ?? '').trim());
    if (!escaped) {
        return '<div class="pw-notes-empty">这个版本没有写更新说明。</div>';
    }

    const inline = (text) => text
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    const out = [];
    let inList = false;
    const closeList = () => {
        if (inList) {
            out.push('</ul>');
            inList = false;
        }
    };

    for (const raw of escaped.split(/\r?\n/)) {
        const line = raw.trimEnd();

        if (/^#{1,6}\s+/.test(line)) {
            closeList();
            out.push(`<h4>${inline(line.replace(/^#{1,6}\s+/, ''))}</h4>`);
            continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
            if (!inList) {
                out.push('<ul>');
                inList = true;
            }
            out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
            continue;
        }
        if (!line.trim()) {
            closeList();
            continue;
        }
        closeList();
        out.push(`<div>${inline(line)}</div>`);
    }

    closeList();
    return out.join('');
}

function moduleSettings() {
    extension_settings[MODULE_NAME] ??= {};
    return extension_settings[MODULE_NAME];
}

function currentType() {
    return PRESET_TYPES[state.typeIndex] ?? PRESET_TYPES[0];
}

function isAdvancedType(type) {
    return type.namesKey === null;
}

function unitOf(type) {
    return type.unit;
}

/** 读取当前选中项时统一走实时句柄，避免用可能已过期的缓存值。 */
function currentSelectionName() {
    const manager = ctx().getPresetManager(currentType().apiId);
    return { manager, name: manager ? manager.getSelectedPresetName() : '' };
}

/** 只在窗口打开且已加载数据时重绘，避免无意义的 DOM 操作。 */
function repaint() {
    if (!state.open) {
        return;
    }
    const { name } = currentSelectionName();
    renderTabs();
    renderStatus(name);
    renderList(name);
    renderUpdateUi();
}

// ───────────────────────────── 数据层 ─────────────────────────────

/** 拉取权威快照（磁盘扫描结果）。 */
async function fetchSnapshot() {
    if (state.inflight) {
        state.inflight.abort();
    }
    const controller = new AbortController();
    state.inflight = controller;

    try {
        const response = await fetch('/api/settings/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`/api/settings/get 返回 ${response.status}`);
        }
        return await response.json();
    } finally {
        if (state.inflight === controller) {
            state.inflight = null;
        }
    }
}

/**
 * 把快照里的某个类型展开成统一条目数组。
 * @param {any} snapshot
 * @param {{contentsKey:string, namesKey:string|null}} type
 */
function buildEntries(snapshot, type) {
    const contents = Array.isArray(snapshot?.[type.contentsKey]) ? snapshot[type.contentsKey] : [];
    const entries = [];

    if (isAdvancedType(type)) {
        // 进阶模板：/api/settings/get 返回已解析对象数组，名字来自内容里的 name 字段
        for (const item of contents) {
            if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name) {
                continue;
            }
            const raw = JSON.stringify(item, null, 4);
            entries.push({ name: item.name, raw, data: item, size: byteLength(raw), broken: false });
        }
        return entries;
    }

    // 补全类预设：内容数组是原始 JSON 字符串数组，名字数组是磁盘文件名（去扩展名）
    const names = Array.isArray(snapshot?.[type.namesKey]) ? snapshot[type.namesKey] : [];
    for (let i = 0; i < names.length; i++) {
        const item = contents[i];
        let data = null;
        let raw = '';
        if (typeof item === 'string') {
            raw = item;
            try {
                data = JSON.parse(item);
            } catch {
                data = null;
            }
        } else if (item && typeof item === 'object') {
            data = item;
            raw = JSON.stringify(item, null, 4);
        }
        entries.push({
            name: names[i],
            raw,
            data,
            size: byteLength(raw),
            broken: !data || typeof data !== 'object',
        });
    }
    return entries;
}

/** 不解析内容就数出某个类型的条目数，用于标签页角标。 */
function countForType(snapshot, type) {
    if (!snapshot) {
        return 0;
    }
    if (isAdvancedType(type)) {
        const list = Array.isArray(snapshot[type.contentsKey]) ? snapshot[type.contentsKey] : [];
        return list.filter((item) => item && typeof item === 'object' && typeof item.name === 'string' && item.name).length;
    }
    const names = Array.isArray(snapshot[type.namesKey]) ? snapshot[type.namesKey] : [];
    return names.length;
}

/** 磁盘上真实存在的预设名集合，用于同名冲突判断（不用 ST 的内存缓存当判据）。 */
function diskNameSet(type) {
    return new Set(buildEntries(state.snapshot, type).map((e) => e.name));
}

function uniqueName(base, taken) {
    let candidate = base;
    let i = 2;
    while (taken.has(candidate)) {
        candidate = `${base} (${i})`;
        i += 1;
    }
    return candidate;
}

// ─────────────────────── SillyTavern 集成层 ───────────────────────

function getManager(apiId) {
    const manager = ctx().getPresetManager(apiId);
    if (!manager) {
        throw new Error(`酒馆没有为「${apiId}」注册预设管理器`);
    }
    return manager;
}

/**
 * 把一条预设写入 ST 的内存数组，保证本次会话内切回它时读到新内容。
 * 对应原生 updateList() 的内存部分，但刻意不碰选中状态。
 */
function syncMemory(manager, name, data) {
    const { presets, preset_names } = manager.getPresetList();
    if (!Array.isArray(presets)) {
        return;
    }

    if (manager.isKeyedApi()) {
        // 以 name 为键：textgenerationwebui（真数组引用）与进阶模板（每次 map 出来的临时数组）
        const index = Array.isArray(preset_names) ? preset_names.indexOf(name) : -1;
        if (index >= 0) {
            presets[index] = data;
        } else {
            if (data && typeof data === 'object') {
                data.name = name;
            }
            presets.push(data);
            if (Array.isArray(preset_names)) {
                preset_names.push(name);
            }
        }
        return;
    }

    // 以 name -> index 映射为键：openai / kobold / novel
    const index = preset_names ? preset_names[name] : undefined;
    if (typeof index === 'number' && index >= 0 && index < presets.length) {
        presets[index] = data;
    } else {
        presets.push(data);
        if (preset_names) {
            preset_names[name] = presets.length - 1;
        }
    }
}

/** 让原生下拉框出现该 option，但不改变当前选中项。 */
function ensureSelectOption(manager, name) {
    try {
        const select = manager.select;
        if (!select || !select.length) {
            return;
        }

        const { preset_names } = manager.getPresetList();
        const value = manager.isKeyedApi() ? name : (preset_names ? preset_names[name] : undefined);
        if (value === undefined || value === null) {
            return;
        }

        const exists = select.find('option').filter(function () {
            return String(jq(this).val()) === String(value);
        }).length > 0;

        if (!exists) {
            select.append(jq('<option></option>').attr('value', value).text(name));
        }
    } catch (error) {
        console.warn(LOG_PREFIX, '同步原生下拉框失败（预设文件本身不受影响）', error);
    }
}

/**
 * 被删除 / 被改名的预设正好是当前预设时，修正选中状态。
 * 依赖 selectPreset 触发的 change 事件，让酒馆自己把记录写回 settings。
 *
 * @returns {string|null} 修正后的当前预设名；无可用预设时为 null
 */
function fixSelectionAfterLoss(manager, goneName) {
    const current = manager.getSelectedPresetName();
    if (current && current !== goneName) {
        return current; // 酒馆已经自行切换
    }

    const { preset_names } = manager.getPresetList();
    const remaining = manager.isKeyedApi()
        ? (Array.isArray(preset_names) ? preset_names.slice() : [])
        : Object.keys(preset_names ?? {});

    if (!remaining.length) {
        return null;
    }

    const nextName = remaining[0];
    const value = manager.isKeyedApi() ? nextName : preset_names[nextName];
    manager.selectPreset(value);
    return manager.getSelectedPresetName();
}

// ───────────────────────── 本地视图维护 ─────────────────────────

/**
 * 让内存快照跟着本地改动走，这样「刷新」之前再次切换类型也不会读到旧数据。
 * @param {string|null} previousName 改名场景下传旧名字，用于原地替换
 */
function syncSnapshotEntry(type, name, data, previousName = null) {
    if (!state.snapshot) {
        return;
    }
    const list = Array.isArray(state.snapshot[type.contentsKey]) ? state.snapshot[type.contentsKey] : null;
    if (!list) {
        return;
    }

    const lookup = previousName ?? name;
    const clone = structuredClone(data);

    if (isAdvancedType(type)) {
        const index = list.findIndex((item) => item && item.name === lookup);
        if (index >= 0) {
            list[index] = clone;
        } else {
            list.push(clone);
        }
        return;
    }

    const names = state.snapshot[type.namesKey];
    const index = Array.isArray(names) ? names.indexOf(lookup) : -1;
    if (index >= 0) {
        names[index] = name;
        list[index] = JSON.stringify(clone, null, 4);
    } else {
        if (Array.isArray(names)) {
            names.push(name);
        }
        list.push(JSON.stringify(clone, null, 4));
    }
}

function upsertEntryLocal(name, data, previousName = null) {
    if (previousName && previousName !== name) {
        state.entries = state.entries.filter((e) => e.name !== previousName);
    }

    const text = JSON.stringify(data, null, 4);
    const entry = { name, data, raw: text, size: byteLength(text), broken: false };
    const index = state.entries.findIndex((e) => e.name === name);
    if (index >= 0) {
        state.entries[index] = entry;
    } else {
        state.entries.push(entry);
    }
    state.entries.sort((a, b) => a.name.localeCompare(b.name));

    syncSnapshotEntry(currentType(), name, data, previousName);
}

function removeEntryLocal(name) {
    state.entries = state.entries.filter((e) => e.name !== name);
}

// ───────────────────────────── 窗口管理 ─────────────────────────────

function windowElement() {
    return document.getElementById('pw_window');
}

function rootElement() {
    return document.getElementById('pw_root');
}

/** 读取持久化的窗口几何。 */
function readGeometry() {
    const cfg = moduleSettings();
    cfg.window ??= {};
    return cfg.window;
}

/** 保存当前窗口几何。紧凑模式下窗口是铺满的，不覆盖用户在桌面端的布局记忆。 */
function saveGeometry() {
    const win = windowElement();
    if (!win || isCompactViewport()) {
        return;
    }
    const rect = win.getBoundingClientRect();
    moduleSettings().window = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
    saveSettingsDebounced();
}

/**
 * 紧凑视口判定：手机、平板竖屏，以及桌面上被压得很扁的窗口都算。
 * 用实时视口尺寸而不是 UA，这样旋转屏幕、拉伸桌面窗口都能立刻响应。
 */
function isCompactViewport() {
    const vv = window.visualViewport;
    const vw = vv?.width ?? window.innerWidth;
    const vh = vv?.height ?? window.innerHeight;
    return vw <= COMPACT_MAX_WIDTH || vh <= COMPACT_MAX_HEIGHT;
}

/**
 * 当前可见视口。
 * 手机上软键盘弹出时 window.innerHeight 通常不变，但 visualViewport.height 会缩小，
 * 所以必须优先读它，窗口才能跟着键盘一起收缩。
 */
function viewportBox() {
    const vv = window.visualViewport;
    return {
        width: Math.round(vv?.width ?? window.innerWidth),
        height: Math.round(vv?.height ?? window.innerHeight),
        offsetLeft: Math.round(vv?.offsetLeft ?? 0),
        offsetTop: Math.round(vv?.offsetTop ?? 0),
    };
}

/**
 * 把窗口摆到当前视口里。
 *  - 紧凑视口：贴边铺满可见区域，忽略持久化几何（手机上拖窗口没有意义）。
 *  - 常规视口：还原用户上次的位置与尺寸，并做边界兜底（被拖出屏幕 / 分辨率变小）。
 */
function applyGeometry() {
    const win = windowElement();
    if (!win) {
        return;
    }

    const box = viewportBox();

    if (isCompactViewport()) {
        const m = COMPACT_MARGIN;
        win.classList.add('pw-compact');
        win.style.width = `${Math.max(240, box.width - m * 2)}px`;
        win.style.height = `${Math.max(240, box.height - m * 2)}px`;
        win.style.left = `${box.offsetLeft + m}px`;
        win.style.top = `${box.offsetTop + m}px`;
        return;
    }

    win.classList.remove('pw-compact');

    const cfg = readGeometry();
    const maxW = Math.max(MIN_WINDOW_WIDTH, box.width - WINDOW_EDGE_MARGIN * 2);
    const maxH = Math.max(MIN_WINDOW_HEIGHT, box.height - WINDOW_EDGE_MARGIN * 2);

    const width = clamp(Math.round(cfg.width ?? Math.min(1040, maxW)), MIN_WINDOW_WIDTH, maxW);
    const height = clamp(Math.round(cfg.height ?? Math.min(780, maxH)), MIN_WINDOW_HEIGHT, maxH);

    let left = Number.isFinite(cfg.left) ? cfg.left : Math.round((box.width - width) / 2);
    let top = Number.isFinite(cfg.top) ? cfg.top : Math.round((box.height - height) / 2);

    left = clamp(left, WINDOW_EDGE_MARGIN - width + 140, Math.max(WINDOW_EDGE_MARGIN, box.width - 140));
    top = clamp(top, WINDOW_EDGE_MARGIN, Math.max(WINDOW_EDGE_MARGIN, box.height - 60));

    win.style.width = `${width}px`;
    win.style.height = `${height}px`;
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;
}

let viewportSyncQueued = false;

/** 视口变化时重新摆放窗口；用 rAF 合帧，避免软键盘弹出与滚动期间疯狂重排。 */
function scheduleViewportSync() {
    if (viewportSyncQueued) {
        return;
    }
    viewportSyncQueued = true;
    requestAnimationFrame(() => {
        viewportSyncQueued = false;
        if (state.open) {
            applyGeometry();
        }
    });
}

/** 恢复默认位置与大小（屏幕中央）。 */
function resetGeometry() {
    moduleSettings().window = {};
    saveSettingsDebounced();
    applyGeometry();
    toastr.info(isCompactViewport()
        ? '小屏幕上窗口会自动铺满可用区域'
        : '窗口已回到默认位置与大小');
}

function closeWindow() {
    if (!state.open) {
        return;
    }
    state.open = false;
    rootElement()?.classList.remove('pw-open');
    saveGeometry();
}

async function openWindow() {
    const root = rootElement();
    if (!root) {
        toastr.error('预设工作台窗口还没准备好，请刷新页面');
        return;
    }

    state.open = true;
    root.classList.add('pw-open');
    applyGeometry();

    renderTabs();
    if (!state.snapshot) {
        await refresh();
    } else {
        repaint();
    }

    // 顺手检查更新：同一版本 24 小时内只请求一次 GitHub，静默失败不影响使用
    void checkForUpdate({ silent: true });
}

async function toggleWindow() {
    if (state.open) {
        closeWindow();
    } else {
        await openWindow();
    }
}

function initWindowChrome() {
    const win = windowElement();
    const dragHandle = document.getElementById('pw_drag_handle');
    const resizeHandle = document.getElementById('pw_resize_handle');

    // ── 拖动 ──
    let drag = null;
    dragHandle?.addEventListener('pointerdown', (event) => {
        // 紧凑模式（手机）下窗口是铺满的，拖动没有意义
        if (isCompactViewport() || event.button !== 0 || event.target.closest('[data-no-drag]')) {
            return;
        }
        const rect = win.getBoundingClientRect();
        drag = { id: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        dragHandle.setPointerCapture(event.pointerId);
        win.classList.add('pw-dragging');
        event.preventDefault();
    });
    dragHandle?.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.id) {
            return;
        }
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = win.getBoundingClientRect();
        const left = clamp(event.clientX - drag.offsetX, WINDOW_EDGE_MARGIN - rect.width + 140, vw - 140);
        const top = clamp(event.clientY - drag.offsetY, WINDOW_EDGE_MARGIN, vh - 60);
        win.style.left = `${left}px`;
        win.style.top = `${top}px`;
    });
    const endDrag = (event) => {
        if (!drag || event.pointerId !== drag.id) {
            return;
        }
        drag = null;
        win.classList.remove('pw-dragging');
        saveGeometry();
    };
    dragHandle?.addEventListener('pointerup', endDrag);
    dragHandle?.addEventListener('pointercancel', endDrag);

    // ── 调整大小（右下角手柄）──
    let resize = null;
    resizeHandle?.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) {
            return;
        }
        const rect = win.getBoundingClientRect();
        resize = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            width: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top,
        };
        resizeHandle.setPointerCapture(event.pointerId);
        win.classList.add('pw-resizing');
        event.preventDefault();
        event.stopPropagation();
    });
    resizeHandle?.addEventListener('pointermove', (event) => {
        if (!resize || event.pointerId !== resize.id) {
            return;
        }
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const width = clamp(resize.width + (event.clientX - resize.startX), MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, vw - resize.left - WINDOW_EDGE_MARGIN));
        const height = clamp(resize.height + (event.clientY - resize.startY), MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, vh - resize.top - WINDOW_EDGE_MARGIN));
        win.style.width = `${width}px`;
        win.style.height = `${height}px`;
    });
    const endResize = (event) => {
        if (!resize || event.pointerId !== resize.id) {
            return;
        }
        resize = null;
        win.classList.remove('pw-resizing');
        saveGeometry();
    };
    resizeHandle?.addEventListener('pointerup', endResize);
    resizeHandle?.addEventListener('pointercancel', endResize);

    // ── 视口变化 ──
    // window.resize 覆盖桌面拉伸与手机旋转；visualViewport 覆盖手机软键盘弹出
    // （iOS Safari 在键盘弹出时不触发 window.resize，只能靠 visualViewport）。
    window.addEventListener('resize', scheduleViewportSync);
    window.addEventListener('orientationchange', scheduleViewportSync);
    window.visualViewport?.addEventListener('resize', scheduleViewportSync);
    window.visualViewport?.addEventListener('scroll', scheduleViewportSync);
}

// ───────────────────────────── 展示层 ─────────────────────────────

function describeEntry(entry) {
    const data = entry.data;
    if (!data || typeof data !== 'object') {
        return { kind: 'broken', chips: [{ icon: 'fa-triangle-exclamation', text: '内容无法解析为 JSON' }] };
    }

    const chips = [];
    if (Array.isArray(data.prompts)) {
        chips.push({ icon: 'fa-list-ul', text: `${data.prompts.length} 条提示词` });
    }
    if (Array.isArray(data.prompt_order)) {
        chips.push({ icon: 'fa-layer-group', text: `${data.prompt_order.length} 组排序` });
    }
    if (typeof data.content === 'string' && data.content.length) {
        chips.push({ icon: 'fa-file-lines', text: `${data.content.length} 字符正文` });
    }
    if (typeof data.temperature === 'number') {
        chips.push({ icon: 'fa-temperature-half', text: `温度 ${data.temperature}` });
    }
    chips.push({ icon: 'fa-database', text: formatBytes(entry.size) });

    if (!chips.length) {
        chips.push({ icon: 'fa-database', text: formatBytes(entry.size) });
    }
    return { kind: 'ok', chips };
}

function visibleEntries() {
    const needle = state.filter.trim().toLowerCase();
    if (!needle) {
        return state.entries;
    }
    return state.entries.filter((e) => e.name.toLowerCase().includes(needle));
}

function renderTabs() {
    const $tabs = jq('#pw_tabs');
    if (!$tabs.length) {
        return;
    }

    const parts = PRESET_TYPES.map((type, index) => {
        const available = Boolean(ctx().getPresetManager(type.apiId));
        const active = index === state.typeIndex;
        const count = countForType(state.snapshot, type);
        const classes = ['pw-tab'];
        if (active) classes.push('pw-tab-active');
        if (!available) classes.push('pw-tab-disabled');
        return `
            <button type="button" class="${classes.join(' ')}" data-index="${index}" ${available ? '' : 'disabled="disabled"'}
                    title="${escapeHtml(available ? type.label : `${type.label}（酒馆未启用）`)}">
                <i class="fa-solid ${type.icon}"></i>
                <span class="pw-tab-label">${escapeHtml(type.label)}</span>
                <span class="pw-tab-count">${count}</span>
            </button>`;
    });

    $tabs.html(parts.join(''));

    const activeEl = $tabs.find('.pw-tab-active').get(0);
    activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderStatus(currentName) {
    const type = currentType();
    const total = state.entries.length;
    const shown = visibleEntries().length;
    const duplicates = total - new Set(state.entries.map((e) => e.name)).size;

    const bits = [];
    bits.push(`<span class="pw-stat"><i class="fa-solid fa-box-archive"></i> ${total} 个${unitOf(type)}</span>`);
    if (shown !== total) {
        bits.push(`<span class="pw-stat"><i class="fa-solid fa-filter"></i> 显示 ${shown} 个</span>`);
    }
    bits.push(`<span class="pw-stat pw-stat-current"><i class="fa-solid fa-circle-check"></i> 当前：${escapeHtml(currentName || '未选中')}</span>`);

    const notes = [];
    if (duplicates > 0) {
        notes.push(`检测到 ${duplicates} 个重名条目。进阶模板的名字取自文件内容里的 name 字段，同名会互相覆盖。`);
    }
    if (isAdvancedType(type)) {
        notes.push('此类模板的名字存在文件内容里，酒馆删除时用这个名字去找文件；内容里的 name 与文件名不一致时会删不掉。');
    }
    if (state.entries.length <= 1) {
        notes.push('仅剩最后一个预设，已锁定删除，避免酒馆出现无预设可用的情况。');
    }

    const versionChip = `<span class="pw-version" id="pw_version" title="点击检查扩展更新">`
        + `<i class="fa-solid fa-cloud-arrow-down"></i>v${escapeHtml(updateState.localVersion)}</span>`;

    jq('#pw_status').html(
        `<div class="pw-status-row">${bits.join('')}${versionChip}</div>`
        + notes.map((n) => `<div class="pw-note"><i class="fa-solid fa-circle-info"></i> ${escapeHtml(n)}</div>`).join(''),
    );

    const badge = document.getElementById('pw_header_count');
    if (badge) {
        badge.textContent = String(total);
    }
}

const ACTION_META = {
    apply: { label: '应用', icon: 'fa-circle-play', title: '把这条切换成当前预设' },
    update: { label: '覆盖更新', icon: 'fa-cloud-arrow-up', title: '用当前面板里的运行设置覆盖写入这条预设，不会切换当前预设' },
    rename: { label: '重命名', icon: 'fa-pen', title: '改名：先写新文件，确认成功后再删旧文件' },
    copy: { label: '复制', icon: 'fa-clone', title: '复制成一条新预设' },
    export: { label: '导出', icon: 'fa-download', title: '下载成 JSON 文件' },
    delete: { label: '删除', icon: 'fa-trash-can', title: '从磁盘删除这个文件' },
};

function renderList(currentName) {
    const type = currentType();
    const $list = jq('#pw_list');
    if (!$list.length) {
        return;
    }

    const entries = visibleEntries();
    $list.empty();

    if (!entries.length) {
        const empty = state.entries.length
            ? { icon: 'fa-magnifying-glass', text: '没有匹配的预设名，换个关键词试试。' }
            : { icon: 'fa-inbox', text: `这个类型下没有找到任何预设文件。可以用「导入」把 JSON 预设放进来。` };
        $list.html(
            `<div class="pw-empty"><i class="fa-solid ${empty.icon}"></i><span>${escapeHtml(empty.text)}</span></div>`,
        );
        return;
    }

    const canDelete = state.entries.length > 1;
    const seen = new Set();
    const cards = [];

    for (const entry of entries) {
        const isCurrent = currentName === entry.name;
        const isDuplicated = seen.has(entry.name);
        seen.add(entry.name);

        const chips = [];
        if (isCurrent) {
            chips.push('<span class="pw-chip pw-chip-current"><i class="fa-solid fa-bolt"></i>当前</span>');
        }
        if (entry.broken) {
            chips.push('<span class="pw-chip pw-chip-warn"><i class="fa-solid fa-triangle-exclamation"></i>JSON 异常</span>');
        }
        if (isDuplicated) {
            chips.push('<span class="pw-chip pw-chip-warn"><i class="fa-solid fa-clone"></i>重名</span>');
        }

        const described = describeEntry(entry);
        const meta = described.chips.map((c) => (
            `<span class="pw-meta-chip"><i class="fa-solid ${c.icon}"></i>${escapeHtml(c.text)}</span>`
        )).join('');

        const buttons = Object.entries(ACTION_META).map(([action, meta2]) => {
            const isDelete = action === 'delete';
            const disabled = isDelete && !canDelete;
            const classes = ['pw-act'];
            if (isDelete) classes.push('pw-act-danger');
            if (action === 'apply') classes.push('pw-act-primary');
            if (disabled) classes.push('pw-act-disabled');
            const title = isDelete && !canDelete ? '至少保留一个预设' : meta2.title;
            return `<button type="button" class="${classes.join(' ')}" data-act="${action}" title="${escapeHtml(title)}">
                        <i class="fa-solid ${meta2.icon}"></i><span>${escapeHtml(meta2.label)}</span>
                    </button>`;
        }).join('');

        cards.push(`
            <article class="pw-card${isCurrent ? ' pw-is-current' : ''}${entry.broken ? ' pw-is-broken' : ''}" data-name="${escapeHtml(entry.name)}">
                <div class="pw-card-head">
                    <span class="pw-card-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
                    <span class="pw-card-chips">${chips.join('')}</span>
                </div>
                <div class="pw-card-meta">${meta}</div>
                <div class="pw-card-actions">${buttons}</div>
            </article>`);
    }

    $list.html(cards.join(''));
}

async function refresh({ silent = false } = {}) {
    const type = currentType();
    if (!silent && state.open) {
        jq('#pw_status').html('<div class="pw-status-row"><i class="fa-solid fa-spinner pw-spin"></i> 正在读取磁盘上的预设…</div>');
    }

    try {
        state.snapshot = await fetchSnapshot();
        state.entries = buildEntries(state.snapshot, type);
    } catch (error) {
        if (error?.name === 'AbortError') {
            return;
        }
        console.error(LOG_PREFIX, error);
        state.entries = [];
        if (state.open) {
            jq('#pw_status').html(`<div class="pw-note pw-note-error"><i class="fa-solid fa-triangle-exclamation"></i> 读取失败：${escapeHtml(error?.message ?? error)}</div>`);
            jq('#pw_list').empty();
        }
        return;
    }

    repaint();
}

// ───────────────────────────── 操作层 ─────────────────────────────

async function guarded(label, task) {
    if (state.busy) {
        toastr.info('上一个操作还没结束，稍等一下');
        return;
    }
    state.busy = true;
    jq('#pw_root').addClass('pw-busy');
    try {
        await task();
    } catch (error) {
        console.error(LOG_PREFIX, label, error);
        toastr.error(`${label}失败：${error?.message ?? error}`, '预设工作台');
    } finally {
        state.busy = false;
        jq('#pw_root').removeClass('pw-busy');
    }
}

/** 应用：切换成当前预设 */
async function opApply(type, entry) {
    const manager = getManager(type.apiId);
    const { preset_names } = manager.getPresetList();

    let value;
    if (manager.isKeyedApi()) {
        value = entry.name;
        if (Array.isArray(preset_names) && !preset_names.includes(entry.name)) {
            syncMemory(manager, entry.name, structuredClone(entry.data));
            ensureSelectOption(manager, entry.name);
        }
    } else {
        value = preset_names ? preset_names[entry.name] : undefined;
        if (value === undefined) {
            syncMemory(manager, entry.name, structuredClone(entry.data));
            ensureSelectOption(manager, entry.name);
            value = manager.getPresetList().preset_names[entry.name];
        }
    }

    if (value === undefined) {
        throw new Error('酒馆内存里找不到这条预设，请点「刷新」后重试');
    }

    manager.selectPreset(value);
    toastr.success(`已切换到「${entry.name}」`);
    repaint();
}

/** 覆盖更新：用当前面板设置覆写这条预设文件，不改变当前预设 */
async function opUpdate(type, entry) {
    const manager = getManager(type.apiId);

    if (entry.broken) {
        throw new Error('这条预设内容不是合法 JSON；覆盖会丢掉原内容，请先「导出」备份');
    }

    // getPresetSettings 返回的是当前运行设置的浅拷贝，深拷贝一次避免与面板共享引用
    const preset = structuredClone(manager.getPresetSettings(entry.name));
    if (isAdvancedType(type)) {
        preset.name = entry.name; // 进阶模板靠内容里的 name 定位文件，改名会写错文件
    }

    await manager.savePreset(entry.name, preset, { skipUpdate: true });
    syncMemory(manager, entry.name, preset);
    ensureSelectOption(manager, entry.name);
    upsertEntryLocal(entry.name, preset);

    repaint();
    toastr.success(`已用当前面板设置覆盖「${entry.name}」，当前预设未改变`);
}

/** 重命名：先写新文件，确认成功后再删旧文件 */
async function opRename(type, entry) {
    const manager = getManager(type.apiId);
    const unit = unitOf(type);

    const newNameRaw = await ctx().Popup.show.input(
        `重命名${unit}`,
        `当前名称：<b>${escapeHtml(entry.name)}</b><br>请输入新名称：`,
        entry.name,
    );
    const newName = (newNameRaw ?? '').trim();

    if (!newName || newName === entry.name) {
        return;
    }
    if (diskNameSet(type).has(newName)) {
        toastr.warning(`磁盘上已经存在名为「${newName}」的${unit}`);
        return;
    }

    const data = structuredClone(entry.data);
    if (isAdvancedType(type)) {
        data.name = newName;
    }

    await manager.savePreset(newName, data, { skipUpdate: true });
    syncMemory(manager, newName, data);
    ensureSelectOption(manager, newName);

    const wasCurrent = manager.getSelectedPresetName() === entry.name;
    const deleted = await manager.deletePreset(entry.name);

    if (wasCurrent) {
        const { preset_names } = manager.getPresetList();
        const value = manager.isKeyedApi() ? newName : (preset_names ? preset_names[newName] : undefined);
        if (value !== undefined) {
            manager.selectPreset(value);
        } else {
            fixSelectionAfterLoss(manager, entry.name);
        }
    }

    saveSettingsDebounced();
    upsertEntryLocal(newName, data, entry.name);
    repaint();

    if (!deleted) {
        toastr.warning(`新${unit}「${newName}」已保存，但旧文件「${entry.name}」没删掉，请手动清理`);
    } else {
        toastr.success(`已重命名为「${newName}」`);
    }
}

/** 复制成新预设 */
async function opCopy(type, entry) {
    const manager = getManager(type.apiId);
    const unit = unitOf(type);
    const newName = uniqueName(`${entry.name} (副本)`, diskNameSet(type));

    const data = structuredClone(entry.data);
    if (isAdvancedType(type)) {
        data.name = newName;
    }

    await manager.savePreset(newName, data, { skipUpdate: true });
    syncMemory(manager, newName, data);
    ensureSelectOption(manager, newName);
    upsertEntryLocal(newName, data);

    repaint();
    toastr.success(`已复制为「${newName}」，当前${unit}未改变`);
}

function opExport(entry) {
    downloadJson(entry.raw, `${sanitizeFileName(entry.name)}.json`);
    toastr.success(`已导出「${entry.name}」`);
}

function opExportAll(type) {
    if (!state.entries.length) {
        toastr.warning('当前类型下没有可导出的预设');
        return;
    }
    const bundle = {};
    for (const entry of state.entries) {
        bundle[entry.name] = entry.data ?? null;
    }
    downloadJson(
        JSON.stringify(bundle, null, 4),
        `${sanitizeFileName(type.apiId)}_all_${timestamp()}.json`,
    );
    toastr.success(`已导出 ${state.entries.length} 个${unitOf(type)}`);
}

/** 删除：直接删磁盘文件 */
async function opDelete(type, entry) {
    if (state.entries.length <= 1) {
        toastr.warning('至少保留一个预设，已取消删除。酒馆在没有预设时会出错。');
        return;
    }

    const unit = unitOf(type);
    const confirmed = await ctx().Popup.show.confirm(
        `删除这个${unit}？`,
        `将要删除 <b>${escapeHtml(entry.name)}</b>。<br>`
        + '这会直接删掉用户目录下的 JSON 文件，无法撤销。<br>'
        + '（只是想换掉内容就用「覆盖更新」；想留备份就先「导出」。）',
    );
    if (!confirmed) {
        return;
    }

    const manager = getManager(type.apiId);
    const wasCurrent = manager.getSelectedPresetName() === entry.name;

    const ok = await manager.deletePreset(entry.name);
    if (!ok) {
        toastr.warning('酒馆没有删掉这个文件：磁盘上可能不存在与这个名字完全同名的 .json');
        return;
    }

    if (wasCurrent) {
        const next = fixSelectionAfterLoss(manager, entry.name);
        if (next === null) {
            toastr.warning('这个类型已经没有预设了，请新建一个或用「导入」放一个进去');
        }
    }

    saveSettingsDebounced();
    removeEntryLocal(entry.name);
    repaint();

    // 广播给其他扩展（酒馆自身的删除流程也这么做）
    await eventSource.emit(event_types.PRESET_DELETED, { apiId: type.apiId, name: entry.name });
    toastr.success(`已删除「${entry.name}」`);
}

/** 导入：支持单条预设文件，也支持本扩展导出的打包对象 */
async function opImport(type, files) {
    const manager = getManager(type.apiId);
    const taken = diskNameSet(type);
    let imported = 0;
    let failed = 0;

    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(await file.text());
        } catch {
            toastr.error(`${file.name} 不是合法 JSON，已跳过`);
            failed += 1;
            continue;
        }

        if (!parsed || typeof parsed !== 'object') {
            toastr.error(`${file.name} 的内容不是 JSON 对象，已跳过`);
            failed += 1;
            continue;
        }

        // 打包对象判定：{ 预设名: {...}, ... } —— 顶层没有预设自身的特征字段
        const values = Object.values(parsed);
        const looksLikeBundle = !Array.isArray(parsed)
            && values.length > 0
            && values.every((v) => v && typeof v === 'object' && !Array.isArray(v))
            && !('prompts' in parsed)
            && !('prompt_order' in parsed)
            && !('chat_completion_source' in parsed)
            && typeof parsed.name !== 'string';

        const items = looksLikeBundle
            ? Object.entries(parsed).map(([name, data]) => ({ name, data }))
            : [{ name: file.name.replace(/\.json$/i, '').trim() || 'imported', data: parsed }];

        for (const item of items) {
            try {
                if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
                    throw new Error('内容不是一个 JSON 对象');
                }
                const name = uniqueName(String(item.name), taken);
                const data = structuredClone(item.data);
                if (isAdvancedType(type)) {
                    data.name = name;
                }
                await manager.savePreset(name, data, { skipUpdate: true });
                syncMemory(manager, name, data);
                ensureSelectOption(manager, name);
                upsertEntryLocal(name, data);
                taken.add(name);
                imported += 1;
            } catch (error) {
                console.error(LOG_PREFIX, '导入失败', item.name, error);
                failed += 1;
            }
        }
    }

    repaint();
    if (imported) {
        toastr.success(`已导入 ${imported} 个预设${failed ? `，${failed} 个失败` : ''}`);
    } else if (failed) {
        toastr.error(`导入失败：${failed} 个文件都没能处理`);
    }
}

// ───────────────────────────── 事件绑定 ─────────────────────────────

function bindWindowUi() {
    jq('#pw_btn_close').on('click', closeWindow);
    jq('#pw_backdrop').on('click', closeWindow);
    jq('#pw_btn_recenter').on('click', resetGeometry);

    // ── 更新相关 ──
    jq('#pw_btn_update').on('click', () => checkForUpdate({ force: true, silent: false }));

    // 版本徽章在状态栏里会被反复重建，所以用委托。
    // 有新版就弹提示条；已是最新就展示「本版带来了什么」。
    jq('#pw_status').on('click', '#pw_version', async () => {
        await checkForUpdate({ force: true, silent: true });
        if (updateState.hasUpdate) {
            return;
        }
        if (updateState.currentRelease) {
            updateState.showCurrentNotes = true;
            renderUpdateUi();
        } else {
            toastr.info(`已是最新版本 v${updateState.localVersion}`);
        }
    });

    jq('#pw_btn_update_apply').on('click', () => guarded('更新扩展', applyUpdate));

    jq('#pw_btn_update_notes').on('click', () => {
        updateState.notesOpen = !updateState.notesOpen;
        renderUpdateUi();
    });

    jq('#pw_btn_update_dismiss').on('click', () => {
        if (updateState.hasUpdate) {
            const cache = readUpdateCache();
            cache.dismissed = updateState.latest?.version ?? null;
            saveSettingsDebounced();
            toastr.info('这个版本不再提示，需要时可用标题栏的更新按钮手动检查');
        }
        updateState.showCurrentNotes = false;
        updateState.notesOpen = false;
        renderUpdateUi();
    });

    jq('#pw_btn_refresh').on('click', async function () {
        const icon = jq(this).find('i');
        icon.addClass('pw-spin');
        try {
            await refresh();
            toastr.success('已重新扫描磁盘');
        } catch (error) {
            console.error(LOG_PREFIX, error);
        } finally {
            icon.removeClass('pw-spin');
        }
    });

    jq('#pw_tabs').on('click', '.pw-tab', async function () {
        const index = Number(jq(this).data('index'));
        if (!Number.isFinite(index) || index === state.typeIndex) {
            return;
        }
        if (!ctx().getPresetManager(PRESET_TYPES[index]?.apiId)) {
            return;
        }
        state.typeIndex = index;
        moduleSettings().typeIndex = index;
        saveSettingsDebounced();
        renderTabs();
        await refresh();
    });

    jq('#pw_search').on('input', function () {
        state.filter = String(jq(this).val() ?? '');
        jq('#pw_search_clear').toggleClass('pw-visible', state.filter.length > 0);
        repaint();
    });

    jq('#pw_search_clear').on('click', () => {
        state.filter = '';
        jq('#pw_search').val('');
        jq('#pw_search_clear').removeClass('pw-visible');
        repaint();
    });

    jq('#pw_btn_import').on('click', () => {
        jq('#pw_import_file').trigger('click');
    });

    jq('#pw_import_file').on('change', async function (event) {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (!files.length) {
            return;
        }
        const type = currentType();
        await guarded('导入', () => opImport(type, files));
    });

    jq('#pw_btn_export_all').on('click', () => {
        opExportAll(currentType());
    });

    jq('#pw_list').on('click', async function (event) {
        const $button = jq(event.target).closest('[data-act]');
        if (!$button.length || $button.hasClass('pw-act-disabled')) {
            return;
        }
        const $card = $button.closest('.pw-card');
        const name = String($card.attr('data-name') ?? '');
        const entry = state.entries.find((e) => e.name === name);
        if (!entry) {
            console.warn(LOG_PREFIX, '找不到条目', name);
            return;
        }

        const action = String($button.data('act'));
        const type = currentType();

        if (action === 'export') {
            opExport(entry);
            return;
        }

        await guarded(ACTION_META[action]?.label ?? '操作', async () => {
            switch (action) {
                case 'apply':
                    return opApply(type, entry);
                case 'update':
                    return opUpdate(type, entry);
                case 'rename':
                    return opRename(type, entry);
                case 'copy':
                    return opCopy(type, entry);
                case 'delete':
                    return opDelete(type, entry);
                default:
                    return undefined;
            }
        });
    });

    // Esc 关闭；酒馆自己弹窗打开时让位给它
    jq(document).on('keydown.presetWorkbench', (event) => {
        if (event.key !== 'Escape' || !state.open) {
            return;
        }
        if (jq('#dialogue_popup').is(':visible')) {
            return;
        }
        closeWindow();
    });
}

function bindHostEvents() {
    // 别的扩展删掉了预设：窗口开着就重新读磁盘
    eventSource.on(event_types.PRESET_DELETED, async (payload) => {
        if (state.open && (!payload?.apiId || payload.apiId === currentType().apiId)) {
            await refresh({ silent: true });
        }
    });

    // 切换预设只影响「当前」标记，重绘即可，不必再拉一次快照
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        if (state.open && currentType().apiId === 'openai') {
            repaint();
        }
    });
}

// ───────────────────────────── 更新模块 ─────────────────────────────

/**
 * 本地版本号。优先读酒馆已经加载好的 manifest（与扩展列表显示的版本一致），
 * 读不到时退回内置常量。
 */
function localVersion() {
    try {
        const manifest = ctx().getExtensionManifest?.(EXTENSION_PATH);
        if (manifest?.version) {
            return String(manifest.version);
        }
    } catch (error) {
        console.warn(LOG_PREFIX, '读取 manifest 版本失败', error);
    }
    return EXTENSION_VERSION_FALLBACK;
}

/** 读取持久化的更新缓存。 */
function readUpdateCache() {
    const cfg = moduleSettings();
    cfg.update ??= {};
    return cfg.update;
}

/** 把本地版本与缓存的远端信息对齐，算出是否该提示更新。 */
function syncUpdateState() {
    updateState.localVersion = localVersion();

    const cache = readUpdateCache();
    const releases = Array.isArray(cache.releases) ? cache.releases : [];

    updateState.latest = releases[0] ?? null;
    updateState.currentRelease = releases.find((r) => compareVersions(r.version, updateState.localVersion) === 0) ?? null;
    updateState.hostOutdated = cache.hostOutdated === true;

    const remoteVersion = updateState.latest?.version;
    const releaseOutdated = Boolean(remoteVersion) && compareVersions(remoteVersion, updateState.localVersion) > 0;
    const outdated = releaseOutdated || updateState.hostOutdated;

    // 只有拿到确切版本号时才允许「不再提示这个版本」；纯 host 判断不能忽略，
    // 否则用户会失去唯一的更新线索
    updateState.hasUpdate = outdated && !(releaseOutdated && cache.dismissed === remoteVersion);
}

/**
 * 通道一：问酒馆自己有没有新提交。
 * /api/extensions/version 会在服务端对扩展目录执行 git fetch 再比对，
 * 所以它不仅不限流，而且它的结论才真正代表「酒馆能不能更新成功」。
 * 返回 null 表示这条通道不可用（目录不是 git 仓库、路径不对等）。
 */
async function checkHostUpdateAvailable() {
    const attempts = [
        { extensionName: UPDATE_NAME, global: false },
        { extensionName: UPDATE_NAME, global: true },
    ];

    for (const body of attempts) {
        let response;
        try {
            response = await fetch('/api/extensions/version', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
        } catch {
            continue;
        }

        if (response.status === 404 || response.status === 403) {
            continue;
        }
        if (!response.ok) {
            throw new Error(`酒馆返回 ${response.status}`);
        }

        const data = await response.json();
        return {
            isUpToDate: Boolean(data.isUpToDate),
            commit: String(data.currentCommitHash ?? ''),
            remoteUrl: String(data.remoteUrl ?? ''),
        };
    }

    return null;
}

/**
 * 向 GitHub 拉最近若干个 Release。
 * 一次请求同时拿到「有没有新版」和「每个版本的更新说明」，
 * 因此装的是当前版本时也能把它的更新内容展示出来。
 */
async function fetchReleases() {
    const response = await fetch(UPDATE_RELEASES_LIST_API, {
        headers: { Accept: 'application/vnd.github+json' },
    });

    if (response.status === 403 || response.status === 429) {
        // 未认证的 GitHub API 限额是每小时 60 次（按 IP）。正常使用碰不到，
        // 因为同一版本 24 小时内只查一次；何况还有酒馆端那条通道兜底。
        throw new Error('GitHub 接口限流，稍后再试');
    }
    if (!response.ok) {
        throw new Error(`GitHub 返回 ${response.status}`);
    }

    const list = await response.json();
    if (!Array.isArray(list)) {
        return [];
    }

    return list
        .filter((release) => release && !release.draft)
        .map((release) => ({
            version: String(release.tag_name ?? '').replace(/^v/i, ''),
            notes: String(release.body ?? ''),
            url: String(release.html_url ?? UPDATE_RELEASES_URL),
            publishedAt: String(release.published_at ?? ''),
        }))
        .filter((release) => release.version);
}

/**
 * 检查更新。两条通道互补，任一条成功就能得出「有更新」的结论：
 *  1. 酒馆自己的 /api/extensions/version —— 服务端 git fetch 后比对，不限流，
 *     而且它才真正代表「酒馆能不能更新成功」。
 *  2. GitHub Releases —— 拿到版本号和更新说明，但可能被限流或网络阻断。
 *
 * @param {boolean} force 忽略 24 小时间隔（手动触发）
 * @param {boolean} silent 静默模式：不弹提示，只更新界面
 */
async function checkForUpdate({ force = false, silent = true } = {}) {
    if (updateState.checking) {
        return;
    }

    const cache = readUpdateCache();

    if (!force && Date.now() - (Number(cache.checkedAt) || 0) < UPDATE_CHECK_INTERVAL_MS) {
        syncUpdateState();
        renderUpdateUi();
        return;
    }

    updateState.checking = true;
    updateState.error = null;
    renderUpdateUi();

    const problems = [];

    try {
        // 通道一：酒馆服务端
        try {
            const hostResult = await checkHostUpdateAvailable();
            if (hostResult) {
                cache.hostOutdated = !hostResult.isUpToDate;
            } else {
                problems.push('酒馆端：没能定位到扩展目录');
            }
        } catch (error) {
            problems.push(`酒馆端：${error?.message ?? error}`);
            console.warn(LOG_PREFIX, '酒馆端版本检查失败', error);
        }

        // 通道二：GitHub Releases
        try {
            const releases = await fetchReleases();
            if (releases.length) {
                cache.releases = releases;
            }
        } catch (error) {
            problems.push(`GitHub：${error?.message ?? error}`);
            console.warn(LOG_PREFIX, 'GitHub Release 查询失败', error);
        }

        cache.checkedAt = Date.now();
        updateState.error = problems.length ? problems.join('；') : null;
        syncUpdateState();

        if (!silent) {
            if (updateState.hasUpdate) {
                toastr.success(updateState.latest?.version
                    ? `发现新版本 v${updateState.latest.version}`
                    : '检测到有新提交可用');
            } else if (problems.length >= 2) {
                toastr.warning(`检查更新失败：${updateState.error}`);
            } else {
                toastr.success(`已是最新版本 v${updateState.localVersion}`);
            }
        }
    } finally {
        updateState.checking = false;
        saveSettingsDebounced();
        renderUpdateUi();
    }
}

/**
 * 渲染标题栏提示点、更新提示条与状态栏版本徽章。
 * 提示条有两种用途：发现新版本时提示更新；已是最新时展示「本版带来了什么」。
 */
function renderUpdateUi() {
    if (!state.open) {
        return;
    }

    const remoteVersion = updateState.latest?.version;
    const releaseOutdated = Boolean(remoteVersion) && compareVersions(remoteVersion, updateState.localVersion) > 0;
    const outdated = releaseOutdated || updateState.hostOutdated;
    const ignored = releaseOutdated && readUpdateCache().dismissed === remoteVersion;
    const showUpdate = outdated && !ignored;
    const showChangelog = !showUpdate && updateState.showCurrentNotes && Boolean(updateState.currentRelease);
    const showBanner = showUpdate || showChangelog;

    if (showUpdate) {
        updateState.showCurrentNotes = false;
    }

    jq('#pw_btn_update')
        .toggleClass('pw-has-update', showUpdate)
        .find('i')
        .toggleClass('pw-spin', updateState.checking);

    jq('#pw_btn_update_apply').toggleClass('pw-hidden', !showUpdate);
    jq('#pw_btn_update_dismiss').attr('title', showUpdate ? '不再提示这个版本' : '关闭');

    if (showUpdate) {
        const current = escapeHtml(updateState.localVersion);

        if (remoteVersion) {
            jq('#pw_update_text').html(
                `有新版本 <b>v${escapeHtml(remoteVersion)}</b> 可用，当前是 v${current}。`
                + (updateState.latest?.publishedAt
                    ? ` <span class="pw-update-date">发布于 ${escapeHtml(String(updateState.latest.publishedAt).slice(0, 10))}</span>`
                    : ''),
            );
        } else {
            // 酒馆端判断出落后、GitHub 那侧没拿到 —— 仍然提示，只是没有版本说明
            jq('#pw_update_text').html(`检测到有新提交可用（当前 v${current}），但没取到版本说明。`);
        }

        const hasNotes = Boolean(remoteVersion && updateState.latest?.notes);
        jq('#pw_update_notes').html(hasNotes
            ? renderNotesHtml(updateState.latest.notes)
            : `<div class="pw-notes-empty">${escapeHtml(updateState.error
                ? `取更新说明失败：${updateState.error}`
                : '这个版本没有写更新说明。')}</div>`);
        jq('#pw_btn_update_notes').toggleClass('pw-hidden', !hasNotes);
        jq('#pw_update_banner').removeClass('pw-banner-neutral');
    } else if (showChangelog) {
        const release = updateState.currentRelease;
        jq('#pw_update_text').html(`当前版本 <b>v${escapeHtml(release.version)}</b> 带来了这些变化：`);
        jq('#pw_update_notes').html(renderNotesHtml(release.notes));
        jq('#pw_btn_update_notes').toggleClass('pw-hidden', true);
        jq('#pw_update_banner').addClass('pw-banner-neutral');
    } else {
        updateState.notesOpen = false;
    }

    jq('#pw_update_banner').toggleClass('pw-visible', showBanner);
    jq('#pw_update_notes').toggleClass('pw-visible', showBanner && (showChangelog || updateState.notesOpen));
    jq('#pw_btn_update_notes').find('span').text(updateState.notesOpen ? '收起' : '更新内容');

    jq('#pw_version')
        .toggleClass('pw-version-outdated', outdated)
        .attr('title', outdated
            ? `当前 v${updateState.localVersion}${remoteVersion ? `，最新 v${remoteVersion}` : ''}。点击检查更新`
            : `当前 v${updateState.localVersion}。点击查看本版更新内容`);
}

/**
 * 一键更新：调用酒馆自己的扩展更新接口（服务端内部执行 git pull）。
 * 先按 local 试、再按 global 试，覆盖两种安装位置。
 */
async function applyUpdate() {
    const attempts = [
        { extensionName: UPDATE_NAME, global: false },
        { extensionName: UPDATE_NAME, global: true },
    ];

    let lastError = null;

    for (const body of attempts) {
        let response;
        try {
            response = await fetch('/api/extensions/update', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
        } catch (error) {
            lastError = error;
            continue;
        }

        if (response.status === 404 || response.status === 403) {
            lastError = new Error(response.status === 403
                ? '没有权限更新 global 扩展（需要管理员）'
                : '酒馆在这条路径下找不到扩展目录');
            continue;
        }

        if (!response.ok) {
            lastError = new Error((await response.text()) || response.statusText);
            continue;
        }

        const data = await response.json();

        if (data.isUpToDate) {
            toastr.info('酒馆这边没有检测到新的提交，稍后再试一次');
            await checkForUpdate({ force: true, silent: true });
            return;
        }

        const commit = escapeHtml(String(data.shortCommitHash ?? ''));
        const confirmed = await ctx().Popup.show.confirm(
            '更新完成',
            `已拉到提交 <code>${commit}</code>。<br>新代码要刷新页面才会生效，现在刷新吗？`,
        );
        if (confirmed) {
            window.location.reload();
        }
        return;
    }

    const hint = '更新失败：这个副本可能不是用 git 安装的（例如手动复制文件），酒馆无法直接更新它。';
    toastr.error(
        lastError ? `${hint}<br>原因：${escapeHtml(lastError.message ?? String(lastError))}` : hint,
        '预设工作台',
    );
}

// ───────────────────────────── 入口挂载 ─────────────────────────────

/**
 * 往酒馆魔杖菜单里挂一个入口。
 * #extensionsMenu 由 extensions.js 动态生成到 body；正常情况下扩展加载时已存在，
 * 这里仍做有限次重试以防加载顺序变化。
 */
function mountMenuEntry(attempt = 0) {
    if (jq('#pw_menu_entry').length) {
        return;
    }

    const $menu = jq('#extensionsMenu');
    if (!$menu.length) {
        if (attempt < 20) {
            setTimeout(() => mountMenuEntry(attempt + 1), 250);
        } else {
            console.warn(LOG_PREFIX, '没有找到扩展菜单容器 #extensionsMenu，入口未能挂载');
        }
        return;
    }

    $menu.append(`
        <div id="pw_menu_entry" class="pw-menu-entry" title="预设工作台 · 集中管理全部预设">
            <div class="fa-solid fa-sliders extensionsMenuExtensionButton"></div>
            <span>预设工作台</span>
        </div>`);

    jq('#pw_menu_entry').on('click', () => {
        openWindow();
    });
}

/** 注册 /pw 命令，作为键盘入口。 */
function registerSlashCommand() {
    try {
        const context = ctx();
        const { SlashCommand, SlashCommandParser } = context;
        if (!SlashCommand || !SlashCommandParser) {
            return;
        }
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'pw',
            callback: async () => {
                await toggleWindow();
                return '';
            },
            returns: 'string',
            helpString: '打开 / 关闭预设工作台窗口。',
        }));
    } catch (error) {
        console.warn(LOG_PREFIX, '注册 /pw 命令失败（不影响主功能）', error);
    }
}

// ───────────────────────────── 初始化 ─────────────────────────────

window.jQuery(async () => {
    if (jq('#pw_root').length) {
        return;
    }

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
        jq(document.body).append(html);

        state.typeIndex = Number(moduleSettings().typeIndex) || 0;
        if (!PRESET_TYPES[state.typeIndex]) {
            state.typeIndex = 0;
        }

        initWindowChrome();
        bindWindowUi();
        bindHostEvents();
        mountMenuEntry();
        registerSlashCommand();
        syncUpdateState();

        console.log(LOG_PREFIX, '已加载，从扩展菜单（魔杖图标）打开');
    } catch (error) {
        console.error(LOG_PREFIX, '加载失败', error);
        toastr.error(`预设工作台加载失败：${error?.message ?? error}`);
    }
});
