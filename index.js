/**
 * 预设工作台 (Preset Workbench) —— SillyTavern UI 扩展
 *
 * 目的：脱离酒馆原生「必须先切换成当前预设，才能更新 / 删除它」的限制。
 * 打开面板即列出当前类型的全部预设，每一行都有独立管理按钮。
 *
 * ── 设计依据（SillyTavern 1.18.0，逐条对照源码核对过）──────────────────────
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
 * ────────────────────────────────────────────────────────────────────────
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
    { apiId: 'openai', label: 'Chat Completion 预设', contentsKey: 'openai_settings', namesKey: 'openai_setting_names' },
    { apiId: 'textgenerationwebui', label: '文本补全预设', contentsKey: 'textgenerationwebui_presets', namesKey: 'textgenerationwebui_preset_names' },
    { apiId: 'kobold', label: 'KoboldAI 预设', contentsKey: 'koboldai_settings', namesKey: 'koboldai_setting_names' },
    { apiId: 'novel', label: 'NovelAI 预设', contentsKey: 'novelai_settings', namesKey: 'novelai_setting_names' },
    { apiId: 'instruct', label: '指令模板', contentsKey: 'instruct', namesKey: null },
    { apiId: 'context', label: '上下文模板', contentsKey: 'context', namesKey: null },
    { apiId: 'sysprompt', label: '系统提示词', contentsKey: 'sysprompt', namesKey: null },
    { apiId: 'reasoning', label: '推理模板', contentsKey: 'reasoning', namesKey: null },
];

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

function currentType() {
    return PRESET_TYPES[state.typeIndex] ?? PRESET_TYPES[0];
}

function isAdvancedType(type) {
    return type.namesKey === null;
}

function unitOf(type) {
    return isAdvancedType(type) ? '模板' : '预设';
}

/** 读取当前选中项时统一走实时句柄，避免用可能已过期的缓存值。 */
function currentSelectionName() {
    const manager = ctx().getPresetManager(currentType().apiId);
    return { manager, name: manager ? manager.getSelectedPresetName() : '' };
}

function repaint() {
    const { manager, name } = currentSelectionName();
    renderStatus(name);
    renderList(name);
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

// ───────────────────────────── 展示层 ─────────────────────────────

function describeEntry(entry) {
    const data = entry.data;
    if (!data || typeof data !== 'object') {
        return `${formatBytes(entry.size)} · 内容无法解析为 JSON`;
    }

    const parts = [];
    if (Array.isArray(data.prompts)) {
        parts.push(`${data.prompts.length} 条提示词`);
    }
    if (Array.isArray(data.prompt_order)) {
        parts.push(`${data.prompt_order.length} 组排序`);
    }
    if (typeof data.content === 'string' && data.content.length) {
        parts.push(`${data.content.length} 字符正文`);
    }
    if (typeof data.temperature === 'number') {
        parts.push(`温度 ${data.temperature}`);
    }
    if (!parts.length) {
        parts.push(`${Object.keys(data).length} 个字段`);
    }

    return `${formatBytes(entry.size)} · ${parts.join(' · ')}`;
}

function visibleEntries() {
    const needle = state.filter.trim().toLowerCase();
    if (!needle) {
        return state.entries;
    }
    return state.entries.filter((e) => e.name.toLowerCase().includes(needle));
}

function renderTypeSelect() {
    const $select = jq('#pw_type');
    $select.empty();

    let firstAvailable = -1;
    PRESET_TYPES.forEach((type, index) => {
        const available = Boolean(ctx().getPresetManager(type.apiId));
        if (available && firstAvailable < 0) {
            firstAvailable = index;
        }
        const $option = jq('<option></option>')
            .attr('value', String(index))
            .text(available ? type.label : `${type.label}（酒馆未启用）`);
        if (!available) {
            $option.attr('disabled', 'disabled');
        }
        $select.append($option);
    });

    if (!ctx().getPresetManager(PRESET_TYPES[state.typeIndex].apiId) && firstAvailable >= 0) {
        state.typeIndex = firstAvailable;
    }
    $select.val(String(state.typeIndex));
}

function renderStatus(currentName) {
    const type = currentType();
    const total = state.entries.length;
    const shown = visibleEntries().length;
    const duplicates = total - new Set(state.entries.map((e) => e.name)).size;

    const bits = [`共 ${total} 个${unitOf(type)}`];
    if (shown !== total) {
        bits.push(`当前显示 ${shown} 个`);
    }
    bits.push(`当前：${escapeHtml(currentName || '未选中')}`);

    let html = bits.join(' · ');

    if (duplicates > 0) {
        html += `<br><span class="pw-warn">检测到 ${duplicates} 个重名条目。`
            + '进阶模板的名字取自文件内容里的 name 字段，同名会互相覆盖，建议先改掉其中一个的内部 name。</span>';
    }
    if (isAdvancedType(type)) {
        html += '<br><span class="pw-warn">注意：此类模板的名字存在文件内容里，'
            + '酒馆删除时用这个名字去找文件；内容里的 name 与文件名不一致时会删不掉。</span>';
    }
    if (state.entries.length <= 1) {
        html += '<br><span class="pw-warn">仅剩最后一个预设，已锁定删除，避免酒馆出现无预设可用的情况。</span>';
    }

    jq('#pw_status').html(html);
}

function renderList(currentName) {
    const type = currentType();
    const entries = visibleEntries();
    const $list = jq('#pw_list');
    $list.empty();

    if (!entries.length) {
        $list.append(
            `<div class="pw-empty">${state.entries.length
                ? '没有匹配的预设名。'
                : '这个类型下没有找到任何预设文件。可以点「导入」把 JSON 预设放进来。'}</div>`,
        );
        return;
    }

    const unit = unitOf(type);
    const canDelete = state.entries.length > 1;
    const seen = new Set();
    const fragments = [];

    for (const entry of entries) {
        const isCurrent = currentName === entry.name;
        const isDuplicated = seen.has(entry.name);
        seen.add(entry.name);

        const badges = [];
        if (isCurrent) {
            badges.push('<span class="pw-badge pw-badge-current">当前</span>');
        }
        if (entry.broken) {
            badges.push('<span class="pw-badge pw-badge-broken">JSON 异常</span>');
        }
        if (isDuplicated) {
            badges.push('<span class="pw-badge pw-badge-broken">重名</span>');
        }

        fragments.push(`
            <div class="pw-item${isCurrent ? ' pw-is-current' : ''}" data-name="${escapeHtml(entry.name)}">
                <div class="pw-item-head">
                    <span class="pw-name">${escapeHtml(entry.name)}</span>
                    ${badges.join('')}
                </div>
                <div class="pw-meta">${escapeHtml(describeEntry(entry))}</div>
                <div class="pw-actions">
                    <div class="menu_button" data-act="apply" title="把这个${unit}切换成当前${unit}">应用</div>
                    <div class="menu_button" data-act="update" title="用当前面板里的运行设置覆盖写入这条${unit}（不会切换当前${unit}）">覆盖更新</div>
                    <div class="menu_button" data-act="rename" title="改名：先写新文件，确认成功后再删旧文件">重命名</div>
                    <div class="menu_button" data-act="copy" title="复制成一条新的${unit}">复制</div>
                    <div class="menu_button" data-act="export" title="把这个${unit}下载成 JSON 文件">导出</div>
                    <div class="menu_button pw-danger${canDelete ? '' : ' pw-disabled'}" data-act="delete"
                         title="${canDelete ? `从磁盘删除这个${unit}` : '至少保留一个预设'}">删除</div>
                </div>
            </div>`);
    }

    $list.html(fragments.join(''));
}

async function refresh({ silent = false } = {}) {
    const type = currentType();
    if (!silent) {
        jq('#pw_status').text('正在读取磁盘上的预设…');
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
        jq('#pw_status').html(`<span class="pw-warn">读取失败：${escapeHtml(error?.message ?? error)}</span>`);
        jq('#pw_list').empty();
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
    const $status = jq('#pw_status');
    const previous = $status.html();
    try {
        await task();
    } catch (error) {
        console.error(LOG_PREFIX, label, error);
        $status.html(previous);
        toastr.error(`${label}失败：${error?.message ?? error}`, '预设工作台');
    } finally {
        state.busy = false;
    }
}

/** 应用：切成交互中的当前预设 */
async function opApply(type, entry) {
    const manager = getManager(type.apiId);
    let { preset_names } = manager.getPresetList();

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

const ACTION_LABELS = {
    apply: '应用',
    update: '覆盖更新',
    rename: '重命名',
    copy: '复制',
    delete: '删除',
};

function bindUi() {
    jq('#pw_type').on('change', async function () {
        state.typeIndex = Number(jq(this).val()) || 0;
        extension_settings[MODULE_NAME].typeIndex = state.typeIndex;
        saveSettingsDebounced();
        await refresh();
    });

    jq('#pw_search').on('input', function () {
        state.filter = String(jq(this).val() ?? '');
        repaint();
    });

    jq('#pw_refresh').on('click', async function () {
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

    jq('#pw_import').on('click', () => {
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

    jq('#pw_export_all').on('click', () => {
        opExportAll(currentType());
    });

    jq('#pw_list').on('click', async function (event) {
        const $button = jq(event.target).closest('[data-act]');
        if (!$button.length) {
            return;
        }
        const $item = $button.closest('.pw-item');
        const name = String($item.attr('data-name') ?? '');
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

        await guarded(ACTION_LABELS[action] ?? '操作', async () => {
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
}

function bindHostEvents() {
    // 别的扩展删掉了预设：重新读磁盘
    eventSource.on(event_types.PRESET_DELETED, async (payload) => {
        if (payload?.apiId && payload.apiId === currentType().apiId) {
            await refresh({ silent: true });
        }
    });

    // 切换预设只影响「当前」标记，重绘即可，不必再拉一次 8MB 快照
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        if (currentType().apiId === 'openai') {
            repaint();
        }
    });
}

// ───────────────────────────── 初始化 ─────────────────────────────

window.jQuery(async () => {
    if (jq('.preset-workbench').length) {
        return;
    }

    try {
        const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
        jq('#extensions_settings2').append(html);

        extension_settings[MODULE_NAME] ??= {};
        extension_settings[MODULE_NAME].typeIndex ??= 0;
        state.typeIndex = Number(extension_settings[MODULE_NAME].typeIndex) || 0;
        if (!PRESET_TYPES[state.typeIndex]) {
            state.typeIndex = 0;
        }

        renderTypeSelect();
        bindUi();
        bindHostEvents();
        await refresh();

        console.log(LOG_PREFIX, '已加载');
    } catch (error) {
        console.error(LOG_PREFIX, '加载失败', error);
        toastr.error(`预设工作台加载失败：${error?.message ?? error}`);
    }
});
