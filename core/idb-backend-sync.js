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
].map(t => ({ ...t, lastUploadedFingerprint: null, busy: false }));

let started = false;
let cycleTimer = null;

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

async function backupTarget(target, reason = 'cycle') {
    if (target.busy) return;
    target.busy = true;
    let db = null;
    try {
        if (!(await Dexie.exists(target.dbName))) return;

        db = new Dexie(target.dbName);
        await db.open();

        const fingerprint = await computeFingerprint(db);
        if (fingerprint === target.lastUploadedFingerprint) return;

        // 防止盖掉其他设备刚写的快照：服务器版本超出本设备已知范围时暂停上传
        const marker = readSyncMarker(target.dbName);
        if (marker?.serverFingerprint) {
            const serverMeta = await fetchServerMeta(target.dbName);
            if (serverMeta && serverMeta.fingerprint !== marker.serverFingerprint) {
                xbLog.warn(MODULE_ID, `${target.dbName} 服务器快照已被其他设备更新，本设备暂停上传（刷新页面以拉取最新数据）`);
                return;
            }
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
    } catch (e) {
        xbLog.warn(MODULE_ID, `备份 ${target.dbName} 失败: ${e?.message || e}`);
    } finally {
        try { db?.close(); } catch { /* 已关闭 */ }
        target.busy = false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 恢复与多设备同步
//
// 每台设备在 localStorage 记一个同步标记 {localFingerprint, serverFingerprint}：
// - 本地为空 + 后端有快照        → 全量恢复
// - 服务器更新了、本地自上次同步没改 → 快进恢复（多设备切换的正常路径）
// - 两边都改了 / 没有标记          → 本地优先并警告（周期备份会覆盖服务器）
// - 备份前发现服务器被其他设备更新   → 暂停上传，避免盖掉别人的新数据
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
// 调度
// ═══════════════════════════════════════════════════════════════════════════

async function backupAll(reason) {
    for (const target of SYNC_TARGETS) {
        await backupTarget(target, reason);
    }
}

function scheduleCycle(delayMs) {
    if (cycleTimer) clearTimeout(cycleTimer);
    cycleTimer = setTimeout(async () => {
        cycleTimer = null;
        await backupAll('cycle');
        scheduleCycle(CYCLE_MS);
    }, delayMs);
}

export async function initIdbBackendSync() {
    if (started) return;
    started = true;

    for (const target of SYNC_TARGETS) {
        try {
            await syncTargetOnStartup(target);
        } catch (e) {
            xbLog.warn(MODULE_ID, `启动同步检查失败 ${target.dbName}: ${e?.message || e}`);
        }
    }

    scheduleCycle(INITIAL_DELAY_MS);

    window.addEventListener('pagehide', () => { backupAll('pagehide'); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') backupAll('hidden');
    });

    xbLog.info(MODULE_ID, `已启动（${SYNC_TARGETS.map(t => t.dbName).join(', ')}）`);
}

export function cleanupIdbBackendSync() {
    if (cycleTimer) {
        clearTimeout(cycleTimer);
        cycleTimer = null;
    }
    started = false;
}
