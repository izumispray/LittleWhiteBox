// ═══════════════════════════════════════════════════════════════════════════
// IndexedDB → 后端快照同步
//
// assistant / ebook / tavern 三个 Dexie 库承载用户数据（会话、书稿、剧情记忆），
// 浏览器存储随时可能被清掉。此模块把整库定期快照到酒馆后端文件：
// - 周期性计算轻量指纹（表行数 + 末键 + updatedAt 上限），有变化才上传
// - 页面隐藏时 best-effort 补一次
// - 启动时若本地库不存在或为空、而后端有快照 → 自动恢复
// 浏览器里的库从"唯一数据源"降级为"可丢弃的工作缓存"。
// ═══════════════════════════════════════════════════════════════════════════

import Dexie from '../libs/dexie.mjs';
import { zipSync, unzipSync, strToU8, strFromU8 } from '../libs/fflate.mjs';
import { getRequestHeaders } from '../../../../../script.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandNamedArgument } from '../../../../slash-commands/SlashCommandArgument.js';
import { xbLog } from './debug-core.js';

const MODULE_ID = 'idb-backend-sync';
const FORMAT_VERSION = 1;
const CYCLE_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 20 * 1000;
const UPLOAD_TIMEOUT_MS = 120 * 1000;

const SYNC_TARGETS = [
    { dbName: 'LittleWhiteBox_Assistant' },
    { dbName: 'LittleWhiteBox_Ebook' },
    { dbName: 'LittleWhiteBox_Tavern' },
].map(t => ({ ...t, lastUploadedFingerprint: null, busy: false, warnedFirstRun: false }));

let started = false;
let startupChecked = false;
let cycleTimer = null;
let onPageHide = null;
let onVisibilityChange = null;

function zipFilename(dbName) {
    return `LWB_IdbSync_${dbName}.zip`;
}

function metaFilename(dbName) {
    return `LWB_IdbSync_${dbName}_meta.json`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 值编解码（JSON 装不下的类型打标签）
// ═══════════════════════════════════════════════════════════════════════════

const TYPED_ARRAY_CTORS = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array,
};

function bytesToBase64(bytes) {
    const CHUNK = 0x8000;
    let result = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        result += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(result);
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function encodeValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) {
        return { __lwb: 'date', v: value.toISOString() };
    }
    if (value instanceof ArrayBuffer) {
        return { __lwb: 'ab', b64: bytesToBase64(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
        return {
            __lwb: 'ta',
            ctor: value.constructor?.name || 'Uint8Array',
            b64: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        };
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        const buf = await value.arrayBuffer();
        return { __lwb: 'blob', type: value.type || '', b64: bytesToBase64(new Uint8Array(buf)) };
    }
    if (Array.isArray(value)) {
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = await encodeValue(value[i]);
        return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = await encodeValue(v);
    }
    return out;
}

function decodeValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.__lwb === 'string') {
        switch (value.__lwb) {
            case 'date': return new Date(value.v);
            case 'ab': return base64ToBytes(value.b64).buffer;
            case 'ta': {
                const bytes = base64ToBytes(value.b64);
                const Ctor = TYPED_ARRAY_CTORS[value.ctor] || Uint8Array;
                return new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
            }
            case 'blob': return new Blob([base64ToBytes(value.b64)], { type: value.type || '' });
            default: return value;
        }
    }
    if (Array.isArray(value)) return value.map(decodeValue);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = decodeValue(v);
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 指纹（轻量变更检测：漏检"不改行数/updatedAt 的原地编辑"，由下个变更带上）
// ═══════════════════════════════════════════════════════════════════════════

async function computeFingerprint(db) {
    const parts = [`v${db.verno}`];
    for (const table of db.tables) {
        const count = await table.count();
        let lastKey = null;
        try {
            lastKey = await table.toCollection().lastKey();
        } catch { /* 空表或不支持 */ }
        let maxUpdatedAt = null;
        if (table.schema?.idxByName?.updatedAt) {
            try {
                const rec = await table.orderBy('updatedAt').last();
                maxUpdatedAt = rec?.updatedAt ?? null;
            } catch { /* 忽略 */ }
        }
        parts.push(`${table.name}:${count}:${JSON.stringify(lastKey)}:${JSON.stringify(maxUpdatedAt)}`);
    }
    return parts.join('|');
}

function buildSchemaSpec(db) {
    const schema = {};
    for (const table of db.tables) {
        const primKey = table.schema?.primKey?.src ?? '';
        const indexes = (table.schema?.indexes || []).map(idx => idx.src);
        schema[table.name] = [primKey, ...indexes].join(',');
    }
    return schema;
}

// ═══════════════════════════════════════════════════════════════════════════
// 备份
// ═══════════════════════════════════════════════════════════════════════════

async function uploadFile(name, uint8OrString) {
    const data = typeof uint8OrString === 'string'
        ? btoa(unescape(encodeURIComponent(uint8OrString)))
        : bytesToBase64(uint8OrString);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, data }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function backupTarget(target, reason = 'cycle', { force = false } = {}) {
    if (target.busy) return;
    target.busy = true;
    let db = null;
    try {
        if (!(await Dexie.exists(target.dbName))) return;

        db = new Dexie(target.dbName);
        await db.open();

        const fingerprint = await computeFingerprint(db);
        if (!force && fingerprint === target.lastUploadedFingerprint) return;

        const serverMeta = await fetchServerMeta(target.dbName);

        // 版本守卫：后端快照来自更新的 schema 时，旧代码不得回写覆盖
        // （整库快照不认版本号，v26 快照被 v10 代码上传回去会丢掉 14 张新表）
        // 这一条连 force 也不放行：旧 schema 覆盖新 schema 是唯一无法挽回的方向。
        if (serverMeta && Number.isFinite(serverMeta.verno) && serverMeta.verno > db.verno) {
            xbLog.warn(MODULE_ID, `${target.dbName} 后端快照 schema 更新（v${serverMeta.verno} > 本地 v${db.verno}），拒绝上传（请先把本设备扩展代码更新到同一版本）`);
            return;
        }

        const marker = readSyncMarker(target.dbName);

        // 首次接入守卫：本设备从未同步过、而后端已有别的设备的快照。
        // 此时自动上传等于用本机数据静默顶掉对方，必须由人来裁决。
        // 这是个稳态条件（人不动就一直成立），所以只喊一次，免得每周期刷屏。
        if (!force && serverMeta && !marker?.serverFingerprint) {
            if (!target.warnedFirstRun) {
                target.warnedFirstRun = true;
                xbLog.warn(MODULE_ID, `${target.dbName} 后端已有快照但本设备无同步标记，拒绝自动上传。用 /xbidbsync 看差异，pull 拉取后端 / push 覆盖后端`);
            }
            return;
        }

        // 防止盖掉其他设备刚写的快照：服务器版本超出本设备已知范围时暂停上传
        if (!force && marker?.serverFingerprint && serverMeta && serverMeta.fingerprint !== marker.serverFingerprint) {
            xbLog.warn(MODULE_ID, `${target.dbName} 服务器快照已被其他设备更新，本设备暂停上传（刷新页面以拉取最新数据）`);
            return;
        }

        const schema = buildSchemaSpec(db);
        const counts = {};
        const zipEntries = {};

        for (const table of db.tables) {
            if (!table.schema?.primKey?.src) {
                // 只处理内联主键的表（本项目全部如此）
                xbLog.warn(MODULE_ID, `跳过外联主键表: ${target.dbName}.${table.name}`);
                continue;
            }
            const rows = await table.toArray();
            counts[table.name] = rows.length;
            const encoded = new Array(rows.length);
            for (let i = 0; i < rows.length; i++) {
                encoded[i] = await encodeValue(rows[i]);
            }
            zipEntries[`tables/${table.name}.json`] = strToU8(JSON.stringify(encoded));
        }

        // 空库不覆盖既有快照：跨版本恢复被拒后本地会停在空库，
        // 此时上传等于把后端唯一一份数据抹掉。
        if (serverMeta && Object.values(counts).every(c => c === 0)) {
            xbLog.warn(MODULE_ID, `${target.dbName} 本地整库为空，拒绝覆盖后端已有快照`);
            return;
        }

        const manifest = {
            version: FORMAT_VERSION,
            dbName: target.dbName,
            verno: db.verno,
            exportedAt: Date.now(),
            fingerprint,
            schema,
            counts,
        };
        zipEntries['manifest.json'] = strToU8(JSON.stringify(manifest));

        const zipData = zipSync(zipEntries, { level: 1 });
        await uploadFile(zipFilename(target.dbName), zipData);
        await uploadFile(metaFilename(target.dbName), JSON.stringify({
            version: FORMAT_VERSION,
            verno: db.verno,
            fingerprint,
            exportedAt: manifest.exportedAt,
        }));

        target.lastUploadedFingerprint = fingerprint;
        writeSyncMarker(target.dbName, {
            localFingerprint: fingerprint,
            serverFingerprint: fingerprint,
            syncedAt: Date.now(),
        });
        xbLog.info(MODULE_ID, `已备份 ${target.dbName} → 后端 (${(zipData.byteLength / 1024).toFixed(0)}KB, reason=${reason})`);
        return true;
    } catch (e) {
        xbLog.warn(MODULE_ID, `备份 ${target.dbName} 失败: ${e?.message || e}`);
    } finally {
        try { db?.close(); } catch { /* 已关闭 */ }
        target.busy = false;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 恢复与多设备同步
//
// 每台设备在 localStorage 记一个同步标记 {localFingerprint, serverFingerprint}：
// - 本地为空 + 后端有快照        → 全量恢复
// - 服务器更新了、本地自上次同步没改 → 快进恢复（多设备切换的正常路径）
// - 两边都改了 / 没有标记          → 本地优先并警告（周期备份会覆盖服务器）
// - 备份前发现服务器被其他设备更新   → 暂停上传，避免盖掉别人的新数据
//
// 快照不记录 schema 语义，只记 Dexie verno，所以跨版本一律拒绝而不是勉强合并：
// - 恢复时 manifest.verno ≠ 本地 verno → 拒绝恢复（否则缺失的表被静默跳过）
// - 上传时后端 verno > 本地 verno      → 拒绝上传（否则旧代码把新表整体抹掉）
// ═══════════════════════════════════════════════════════════════════════════

const SYNC_STATE_LS_KEY = 'LWB_IdbSyncState';

function readSyncMarker(dbName) {
    try {
        const all = JSON.parse(localStorage.getItem(SYNC_STATE_LS_KEY) || '{}');
        return all?.[dbName] || null;
    } catch {
        return null;
    }
}

function writeSyncMarker(dbName, marker) {
    try {
        const all = JSON.parse(localStorage.getItem(SYNC_STATE_LS_KEY) || '{}');
        all[dbName] = marker;
        localStorage.setItem(SYNC_STATE_LS_KEY, JSON.stringify(all));
    } catch { /* 忽略 */ }
}

async function fetchServerMeta(dbName) {
    try {
        const res = await fetch(`/user/files/${metaFilename(dbName)}`, {
            headers: getRequestHeaders(),
            cache: 'no-cache',
        });
        if (!res.ok) return null;
        const json = await res.json();
        return (json && typeof json.fingerprint === 'string') ? json : null;
    } catch {
        return null;
    }
}

async function inspectLocalDb(dbName) {
    if (!(await Dexie.exists(dbName))) return { exists: false, empty: true, fingerprint: null };
    const db = new Dexie(dbName);
    try {
        await db.open();
        let empty = true;
        for (const table of db.tables) {
            if (await table.count() > 0) {
                empty = false;
                break;
            }
        }
        const fingerprint = empty ? null : await computeFingerprint(db);
        return { exists: true, empty, fingerprint };
    } catch {
        return { exists: true, empty: false, fingerprint: null };
    } finally {
        try { db.close(); } catch { /* 已关闭 */ }
    }
}

async function restoreFromServerSnapshot(target, { clearFirst = false } = {}) {
    const res = await fetch(`/user/files/${zipFilename(target.dbName)}`, {
        headers: getRequestHeaders(),
        cache: 'no-cache',
    });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    if (!buf?.byteLength) return false;

    let unzipped;
    try {
        unzipped = unzipSync(new Uint8Array(buf));
    } catch {
        xbLog.warn(MODULE_ID, `后端快照无法解压: ${target.dbName}`);
        return false;
    }
    if (!unzipped['manifest.json']) return false;
    const manifest = JSON.parse(strFromU8(unzipped['manifest.json']));
    if (manifest.version !== FORMAT_VERSION || manifest.dbName !== target.dbName) return false;

    const dbExists = await Dexie.exists(target.dbName);
    const db = new Dexie(target.dbName);
    try {
        if (dbExists) {
            await db.open();   // 动态打开现有 schema（应用可能已建好更新版本的空库）
        } else {
            db.version(manifest.verno).stores(manifest.schema);
            await db.open();
        }

        // 版本守卫：schema 版本不一致就不恢复。
        // 逐表 bulkPut 对"manifest 里有而本地没有的表"是静默跳过的，跨版本恢复
        // 会得到半新半旧的撕裂库（如 v13 起 managerMessages 已删、v26 多出 14 张表）。
        if (dbExists && db.verno !== manifest.verno) {
            xbLog.warn(MODULE_ID, `拒绝跨 schema 版本恢复 ${target.dbName}：后端快照 v${manifest.verno} ≠ 本地 v${db.verno}（先让两端扩展代码版本一致）`);
            return false;
        }

        let restoredRows = 0;
        for (const [tableName] of Object.entries(manifest.schema)) {
            const entry = unzipped[`tables/${tableName}.json`];
            if (!entry) continue;
            const table = db.tables.find(t => t.name === tableName);
            if (!table) {
                xbLog.warn(MODULE_ID, `恢复时缺表，跳过: ${target.dbName}.${tableName}`);
                continue;
            }
            if (clearFirst) await table.clear();
            const rows = JSON.parse(strFromU8(entry)).map(decodeValue);
            if (rows.length) {
                await table.bulkPut(rows);
                restoredRows += rows.length;
            }
        }

        // 用导入后的本地指纹做基线（verno 等差异可能让它与 manifest.fingerprint 不同）
        const localFingerprint = await computeFingerprint(db);
        target.lastUploadedFingerprint = localFingerprint;
        writeSyncMarker(target.dbName, {
            localFingerprint,
            serverFingerprint: manifest.fingerprint,
            syncedAt: Date.now(),
        });
        xbLog.info(MODULE_ID, `已从后端恢复 ${target.dbName}: ${restoredRows} 行 (快照时间 ${new Date(manifest.exportedAt).toISOString()})`);
        return true;
    } catch (e) {
        xbLog.warn(MODULE_ID, `恢复 ${target.dbName} 失败: ${e?.message || e}`);
        return false;
    } finally {
        try { db.close(); } catch { /* 已关闭 */ }
    }
}

async function syncTargetOnStartup(target) {
    const serverMeta = await fetchServerMeta(target.dbName);
    if (!serverMeta) return;   // 后端无快照：本地数据由周期备份建立首个快照

    const local = await inspectLocalDb(target.dbName);
    if (local.empty) {
        await restoreFromServerSnapshot(target);
        return;
    }

    const marker = readSyncMarker(target.dbName);
    if (marker && serverMeta.fingerprint === marker.serverFingerprint) {
        // 服务器自上次同步没变：本地改没改交给周期备份判断
        target.lastUploadedFingerprint = marker.localFingerprint || null;
        return;
    }
    if (marker && local.fingerprint && local.fingerprint === marker.localFingerprint) {
        // 服务器更新了而本地没改 → 快进到服务器版本（多设备切换的正常路径）
        xbLog.info(MODULE_ID, `${target.dbName} 服务器快照有更新且本地未改动，快进恢复`);
        await restoreFromServerSnapshot(target, { clearFirst: true });
        return;
    }
    // 两边都动过 / 没有同步标记：本地优先，周期备份会覆盖服务器快照
    xbLog.warn(MODULE_ID, `${target.dbName} 本地与服务器快照分叉，本地优先（服务器版本将被覆盖）`);
    target.lastUploadedFingerprint = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 手动介入
//
// 自动路径刻意保守：拿不准就什么都不做、只告警。"用哪边的数据"这种裁决交给
// 这里的显式操作，入口是 /xbidbsync 与 window.xiaobaixIdbSync。
// 首次多设备接入、以及两边都改过之后的分叉，都靠这里收场。
// ═══════════════════════════════════════════════════════════════════════════

const DB_ALIASES = {
    assistant: 'LittleWhiteBox_Assistant',
    ebook: 'LittleWhiteBox_Ebook',
    tavern: 'LittleWhiteBox_Tavern',
};

function resolveTargets(which) {
    const key = String(which ?? 'all').trim().toLowerCase();
    if (!key || key === 'all') return SYNC_TARGETS;
    const dbName = DB_ALIASES[key] || key;
    return SYNC_TARGETS.filter(t => t.dbName.toLowerCase() === dbName.toLowerCase());
}

async function inspectLocalVerbose(dbName) {
    if (!(await Dexie.exists(dbName))) return { exists: false, verno: null, rows: null };
    const db = new Dexie(dbName);
    try {
        await db.open();
        let rows = 0;
        for (const table of db.tables) rows += await table.count();
        return { exists: true, verno: db.verno, rows };
    } catch (e) {
        return { exists: true, verno: null, rows: null, error: e?.message || String(e) };
    } finally {
        try { db.close(); } catch { /* 已关闭 */ }
    }
}

export async function getIdbSyncStatus() {
    const out = [];
    for (const target of SYNC_TARGETS) {
        const serverMeta = await fetchServerMeta(target.dbName);
        const marker = readSyncMarker(target.dbName);
        out.push({
            dbName: target.dbName,
            local: await inspectLocalVerbose(target.dbName),
            server: serverMeta
                ? { verno: serverMeta.verno ?? null, exportedAt: serverMeta.exportedAt ?? null }
                : null,
            inSync: !!(marker?.serverFingerprint && serverMeta && marker.serverFingerprint === serverMeta.fingerprint),
        });
    }
    return out;
}

/** 用后端快照覆盖本地（丢弃本地差异）。调用方负责刷新页面。 */
export async function pullIdbFromServer(which = 'all') {
    const targets = resolveTargets(which);
    if (!targets.length) return { ok: false, done: [], failed: [`未知的库: ${which}`] };

    const done = [];
    const failed = [];
    for (const target of targets) {
        if (target.busy) { failed.push(`${target.dbName}（正忙）`); continue; }
        target.busy = true;
        try {
            if (await restoreFromServerSnapshot(target, { clearFirst: true })) done.push(target.dbName);
            else failed.push(target.dbName);
        } catch (e) {
            failed.push(`${target.dbName}（${e?.message || e}）`);
        } finally {
            target.busy = false;
        }
    }
    return { ok: failed.length === 0, done, failed };
}

/** 用本地覆盖后端快照（丢弃后端差异）。schema 版本更旧时仍会被拒。 */
export async function pushIdbToServer(which = 'all') {
    const targets = resolveTargets(which);
    if (!targets.length) return { ok: false, done: [], failed: [`未知的库: ${which}`] };

    const done = [];
    const failed = [];
    for (const target of targets) {
        if (await backupTarget(target, 'manual-push', { force: true })) done.push(target.dbName);
        else failed.push(target.dbName);
    }
    return { ok: failed.length === 0, done, failed };
}

// ═══════════════════════════════════════════════════════════════════════════
// 斜杠命令
// ═══════════════════════════════════════════════════════════════════════════

let registeredCommand = null;

function formatStatus(rows) {
    const lines = rows.map(r => {
        const local = !r.local.exists
            ? '本地无库'
            : r.local.error
                ? `本地打不开（${r.local.error}）`
                : `本地 v${r.local.verno} / ${r.local.rows} 行`;
        const server = r.server
            ? `后端 v${r.server.verno ?? '?'}${r.server.exportedAt ? ' / ' + new Date(r.server.exportedAt).toLocaleString() : ''}`
            : '后端无快照';
        const flag = r.server ? (r.inSync ? '已同步' : '未同步') : '—';
        return `${r.dbName}\n    ${local}｜${server}｜${flag}`;
    });
    return `IndexedDB 后端快照状态：\n${lines.join('\n')}\n\npull=用后端覆盖本地，push=用本地覆盖后端`;
}

function registerSlashCommand() {
    if (registeredCommand) return;
    try {
        registeredCommand = SlashCommand.fromProps({
            name: 'xbidbsync',
            helpString: 'IndexedDB 后端快照同步。不带参数看状态；action=pull 用后端快照覆盖本地（成功后自动刷新页面）；action=push 用本地覆盖后端快照。db 可选 all/tavern/assistant/ebook。',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'action',
                    description: 'status（默认）/ pull / push',
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: ['status', 'pull', 'push'],
                }),
                SlashCommandNamedArgument.fromProps({
                    name: 'db',
                    description: '目标库，默认全部',
                    typeList: [ARGUMENT_TYPE.STRING],
                    enumList: ['all', 'tavern', 'assistant', 'ebook'],
                }),
            ],
            callback: async (args) => {
                const action = String(args.action || 'status').trim().toLowerCase();
                const which = String(args.db || 'all').trim().toLowerCase();

                if (action === 'status' || !action) {
                    return formatStatus(await getIdbSyncStatus());
                }

                if (action === 'pull') {
                    const r = await pullIdbFromServer(which);
                    if (!r.done.length) {
                        return `未恢复任何库。失败/跳过：${r.failed.join('、') || '无可恢复目标'}\n（schema 版本不一致会被拒绝，先确认两台设备扩展代码同版本）`;
                    }
                    // 恢复后各模块的内存态已陈旧，继续用会把旧数据写回覆盖刚拉下来的快照
                    setTimeout(() => { try { location.reload(); } catch { /* 忽略 */ } }, 1500);
                    return `已用后端快照覆盖：${r.done.join('、')}${r.failed.length ? `｜失败：${r.failed.join('、')}` : ''}\n即将刷新页面…`;
                }

                if (action === 'push') {
                    const r = await pushIdbToServer(which);
                    return r.done.length
                        ? `已用本地覆盖后端：${r.done.join('、')}${r.failed.length ? `｜失败：${r.failed.join('、')}` : ''}`
                        : `未上传任何库。失败/跳过：${r.failed.join('、') || '无目标'}\n（本地整库为空、或后端 schema 版本更新时会被拒绝）`;
                }

                return `未知 action: ${action}（可用 status / pull / push）`;
            },
        });
        SlashCommandParser.addCommandObject(registeredCommand);
    } catch (e) {
        xbLog.warn(MODULE_ID, `注册 /xbidbsync 失败: ${e?.message || e}`);
        registeredCommand = null;
    }
}

function unregisterSlashCommand() {
    if (!registeredCommand) return;
    try {
        const map = SlashCommandParser.commands || {};
        Object.keys(map).forEach(k => { if (map[k] === registeredCommand) delete map[k]; });
    } catch { /* 忽略 */ }
    registeredCommand = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 调度
// ═══════════════════════════════════════════════════════════════════════════

async function backupAll(reason) {
    // 启动检查跑完之前不许备份：那时 lastUploadedFingerprint 与同步标记都还没建立，
    // 而且各模块可能仍在做 Dexie 版本升级，快照到的会是半迁移状态。
    if (!startupChecked) return;
    for (const target of SYNC_TARGETS) {
        await backupTarget(target, reason);
    }
}

async function runStartupCheck() {
    for (const target of SYNC_TARGETS) {
        try {
            await syncTargetOnStartup(target);
        } catch (e) {
            xbLog.warn(MODULE_ID, `启动同步检查失败 ${target.dbName}: ${e?.message || e}`);
        }
    }
    startupChecked = true;
}

function scheduleCycle(delayMs) {
    if (cycleTimer) clearTimeout(cycleTimer);
    cycleTimer = setTimeout(async () => {
        cycleTimer = null;
        // 启动检查刻意推迟到这里：tavern / assistant / ebook 与本模块在同一批
        // moduleInits 里并发启动，立刻用第二个 Dexie 连接去开库会挡住它们的
        // schema 升级（v10→v26），也可能快照到半迁移状态。
        if (!startupChecked) await runStartupCheck();
        await backupAll('cycle');
        scheduleCycle(CYCLE_MS);
    }, delayMs);
}

export async function initIdbBackendSync() {
    if (started) return;
    started = true;

    scheduleCycle(INITIAL_DELAY_MS);

    onPageHide = () => { backupAll('pagehide'); };
    onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') backupAll('hidden');
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    registerSlashCommand();
    window.xiaobaixIdbSync = {
        status: getIdbSyncStatus,
        pull: pullIdbFromServer,
        push: pushIdbToServer,
    };

    xbLog.info(MODULE_ID, `已启动（${SYNC_TARGETS.map(t => t.dbName).join(', ')}），手动介入用 /xbidbsync`);
}

export function cleanupIdbBackendSync() {
    if (cycleTimer) {
        clearTimeout(cycleTimer);
        cycleTimer = null;
    }
    if (onPageHide) {
        window.removeEventListener('pagehide', onPageHide);
        onPageHide = null;
    }
    if (onVisibilityChange) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        onVisibilityChange = null;
    }
    unregisterSlashCommand();
    try { delete window.xiaobaixIdbSync; } catch { /* 忽略 */ }
    startupChecked = false;
    started = false;
}
