// ═══════════════════════════════════════════════════════════════════════════
// Story Summary - Vector Store（后端持久化）
//
// 向量数据不再存浏览器 IndexedDB：每个 chat 一份内存数据集，
// 持久化为 SillyTavern 后端文件（/api/files/upload + /user/files/）。
// 首次加载时若后端无文件，自动从旧 IndexedDB 迁移并清理浏览器数据。
// ═══════════════════════════════════════════════════════════════════════════

import { zipSync, unzipSync, strToU8, strFromU8 } from '../../../libs/fflate.mjs';
import { xbLog } from '../../../core/debug-core.js';

const MODULE_ID = 'vector-store';
const FORMAT_VERSION = 1;
const SAVE_DEBOUNCE_MS = 2000;
const UPLOAD_TIMEOUT_MS = 60000;
const MAX_SAVE_RETRIES = 5;
const KEEPALIVE_BODY_LIMIT = 60 * 1024;

// ═══════════════════════════════════════════════════════════════════════════
// 持久化环境（浏览器=后端文件；Node 测试环境自动降级为内存模式）
// ═══════════════════════════════════════════════════════════════════════════

const persistence = {
    mode: 'auto',   // 'auto' | 'server' | 'memory'
};

let headersFactoryPromise = null;

export function configureVectorStorePersistence({ mode } = {}) {
    if (mode === 'memory' || mode === 'server' || mode === 'auto') {
        persistence.mode = mode;
    }
}

async function resolveRequestHeaders() {
    if (persistence.mode === 'memory') return null;
    if (!headersFactoryPromise) {
        headersFactoryPromise = import('../../../../../../../script.js')
            .then(m => (typeof m.getRequestHeaders === 'function' ? m.getRequestHeaders : null))
            .catch(() => null);
    }
    const factory = await headersFactoryPromise;
    if (!factory) {
        if (persistence.mode !== 'memory') {
            persistence.mode = 'memory';
            xbLog.warn(MODULE_ID, '无法获取请求头（非酒馆环境？），向量存储降级为内存模式');
        }
        return null;
    }
    if (persistence.mode === 'auto') persistence.mode = 'server';
    return factory();
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

function hash36(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

// chatId 可能含中文/特殊字符，ST 文件名只接受 [a-zA-Z0-9_-]
export function getVectorDataFilename(chatId) {
    const key = String(chatId || '');
    const slug = key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const hash = hash36(key);
    return slug ? `LWB_VectorData_${slug}_${hash}.zip` : `LWB_VectorData_${hash}.zip`;
}

// 版本 meta 小文件：加载时先比对它，避免每次下载整个 zip
export function getVectorMetaFilename(chatId) {
    const key = String(chatId || '');
    const slug = key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const hash = hash36(key);
    return slug ? `LWB_VectorMeta_${slug}_${hash}.json` : `LWB_VectorMeta_${hash}.json`;
}

function uint8ToBase64(uint8) {
    const CHUNK = 0x8000;
    let result = '';
    for (let i = 0; i < uint8.length; i += CHUNK) {
        result += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
    }
    return btoa(result);
}

function concatVectorBuffers(buffers) {
    let total = 0;
    for (const buf of buffers) total += buf.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const buf of buffers) {
        out.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
    }
    return out;
}

function sliceVectorBuffer(bytes, floatOffset, dims) {
    const start = bytes.byteOffset + floatOffset * 4;
    return bytes.buffer.slice(start, start + dims * 4);
}

// ═══════════════════════════════════════════════════════════════════════════
// 本地读缓存（IndexedDB，只存与后端相同的 zip 字节，可随时清空）
// 数据源永远在后端；缓存比服务器新 = 上次上传没完成，加载后补传。
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_DB_NAME = 'LWB_VectorCache';
const CACHE_STORE = 'zips';
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let cacheDbPromise = null;
let cachePruned = false;

function openCacheDb() {
    if (typeof indexedDB === 'undefined' || persistence.mode === 'memory') {
        return Promise.resolve(null);
    }
    if (!cacheDbPromise) {
        cacheDbPromise = new Promise((resolve) => {
            try {
                const req = indexedDB.open(CACHE_DB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(CACHE_STORE)) {
                        db.createObjectStore(CACHE_STORE, { keyPath: 'chatId' });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
                req.onblocked = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }
    return cacheDbPromise;
}

async function cacheGet(chatId) {
    const db = await openCacheDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const req = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(chatId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

async function cachePut(record) {
    const db = await openCacheDb();
    if (!db) return;
    await new Promise((resolve) => {
        try {
            const tx = db.transaction(CACHE_STORE, 'readwrite');
            tx.objectStore(CACHE_STORE).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

async function cacheDelete(chatId) {
    const db = await openCacheDb();
    if (!db) return;
    await new Promise((resolve) => {
        try {
            const tx = db.transaction(CACHE_STORE, 'readwrite');
            tx.objectStore(CACHE_STORE).delete(chatId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

function touchCacheEntry(record) {
    cachePut({ ...record, lastAccessAt: Date.now() });
}

// 每个会话最多清理一次：删掉 30 天没访问的缓存条目
function schedulePruneCacheOnce() {
    if (cachePruned) return;
    cachePruned = true;
    setTimeout(async () => {
        const db = await openCacheDb();
        if (!db) return;
        try {
            const tx = db.transaction(CACHE_STORE, 'readwrite');
            const store = tx.objectStore(CACHE_STORE);
            const cutoff = Date.now() - CACHE_MAX_AGE_MS;
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return;
                const rec = cursor.value;
                if ((rec?.lastAccessAt || 0) < cutoff) cursor.delete();
                cursor.continue();
            };
        } catch { /* 清理失败无所谓 */ }
    }, 30 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// 数据集生命周期
// ═══════════════════════════════════════════════════════════════════════════

/** @type {Map<string, object>} chatId → dataset */
const datasets = new Map();

function createDataset(chatId) {
    return {
        chatId,
        meta: null,
        chunks: new Map(),          // chunkId → chunk 记录
        chunkVectors: new Map(),    // chunkId → { chunkId, vector: ArrayBuffer, dims, fingerprint }
        eventVectors: new Map(),    // eventId → 同上
        stateVectors: new Map(),    // atomId → { atomId, floor, vector, dims, rVector, rDims, fingerprint }
        loading: null,
        loaded: false,
        serverFileExists: false,
        baseSavedAt: 0,      // 当前内存数据对应的服务器版本（savedAt）
        dirtyVersion: 0,
        savedVersion: 0,
        saving: false,
        saveTimer: null,
        retryTimer: null,
        retryCount: 0,
    };
}

// 没有实质内容的数据集不值得占一个服务器文件
function isDatasetEmpty(ds) {
    return !ds.chunks.size
        && !ds.chunkVectors.size
        && !ds.eventVectors.size
        && !ds.stateVectors.size
        && (!ds.meta || (!ds.meta.fingerprint && (ds.meta.lastChunkFloor ?? -1) < 0));
}

export async function ensureDataset(chatId) {
    const key = String(chatId || '');
    if (!key) throw new Error('ensureDataset: chatId 为空');

    let ds = datasets.get(key);
    if (!ds) {
        ds = createDataset(key);
        datasets.set(key, ds);
    }
    if (ds.loaded) return ds;
    if (ds.loading) {
        await ds.loading;
        return ds;
    }

    ds.loading = (async () => {
        try {
            const loaded = await loadDatasetWithCache(key);
            if (loaded) {
                applySerializedData(ds, loaded.parsed);
                ds.serverFileExists = true;
                ds.baseSavedAt = Number(loaded.parsed.manifest?.savedAt) || 0;
                if (loaded.needsReupload) {
                    // 缓存领先于服务器（上次上传没完成）：补传
                    ds.dirtyVersion++;
                    markDatasetDirty(key);
                }
                xbLog.info(MODULE_ID, `已加载向量数据(${loaded.source}): chat=${key} chunks=${ds.chunks.size} l1v=${ds.chunkVectors.size} l2v=${ds.eventVectors.size} l0v=${ds.stateVectors.size}`);
            } else {
                await migrateFromLegacyIndexedDb(ds);
            }
        } catch (e) {
            xbLog.warn(MODULE_ID, `加载向量数据失败（按空数据继续）: chat=${key} err=${e?.message || e}`);
        } finally {
            ds.loaded = true;
            ds.loading = null;
        }
    })();

    await ds.loading;
    return ds;
}

export function getLoadedDataset(chatId) {
    const ds = datasets.get(String(chatId || ''));
    return ds?.loaded ? ds : null;
}

export function markDatasetDirty(chatId) {
    const ds = datasets.get(String(chatId || ''));
    if (!ds) return;
    ds.dirtyVersion++;
    if (ds.saveTimer) clearTimeout(ds.saveTimer);
    ds.saveTimer = setTimeout(() => {
        ds.saveTimer = null;
        saveDataset(ds).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
}

/** 主线程内存快照（Dexie 记录形状的数组），用于喂给 recall runtime / worker */
export async function getDatasetSnapshot(chatId) {
    const ds = await ensureDataset(chatId);
    return {
        meta: ds.meta ? { ...ds.meta } : null,
        chunks: [...ds.chunks.values()],
        chunkVectors: [...ds.chunkVectors.values()],
        eventVectors: [...ds.eventVectors.values()],
        stateVectors: [...ds.stateVectors.values()],
    };
}

/** flush 指定 chat（silent=false 时失败抛异常） */
export async function flushDataset(chatId, { silent = true } = {}) {
    const ds = datasets.get(String(chatId || ''));
    if (!ds || !ds.loaded) return true;
    if (ds.saveTimer) {
        clearTimeout(ds.saveTimer);
        ds.saveTimer = null;
    }
    return await saveDataset(ds, { silent });
}

/** flush 所有脏数据集（页面隐藏/卸载时 best-effort） */
export function flushAllDatasetsBestEffort(reason = 'flush-all') {
    for (const ds of datasets.values()) {
        if (!ds.loaded || ds.dirtyVersion === ds.savedVersion) continue;
        if (ds.saveTimer) {
            clearTimeout(ds.saveTimer);
            ds.saveTimer = null;
        }
        saveDataset(ds, { keepaliveHint: true }).catch(() => {});
        xbLog.info(MODULE_ID, `best-effort flush: chat=${ds.chatId} reason=${reason}`);
    }
}

/** 仅保留指定 chat 的内存数据集，其余先 flush 再逐出 */
export async function retainDatasets(keepChatId) {
    const keep = String(keepChatId || '');
    for (const [key, ds] of [...datasets.entries()]) {
        if (keep && key === keep) continue;
        if (ds.loaded && ds.dirtyVersion !== ds.savedVersion) {
            if (ds.saveTimer) {
                clearTimeout(ds.saveTimer);
                ds.saveTimer = null;
            }
            const ok = await saveDataset(ds);
            if (!ok) continue;   // 保存失败的不逐出，等重试
        }
        if (ds.retryTimer) clearTimeout(ds.retryTimer);
        if (ds.saveTimer) clearTimeout(ds.saveTimer);
        datasets.delete(key);
    }
}

/** 彻底删除：内存 + 服务器文件（聊天删除/清空数据时用） */
export async function deleteDatasetEverywhere(chatId) {
    const key = String(chatId || '');
    if (!key) return;
    const ds = datasets.get(key);
    if (ds) {
        if (ds.retryTimer) clearTimeout(ds.retryTimer);
        if (ds.saveTimer) clearTimeout(ds.saveTimer);
        datasets.delete(key);
    }

    await cacheDelete(key);

    const headers = await resolveRequestHeaders();
    if (!headers) return;
    try {
        for (const filename of [getVectorDataFilename(key), getVectorMetaFilename(key)]) {
            const res = await fetch('/api/files/delete', {
                method: 'POST',
                headers,
                body: JSON.stringify({ path: `user/files/${filename}` }),
            });
            if (res.ok) {
                xbLog.info(MODULE_ID, `已删除服务器向量数据: ${filename}`);
            }
        }
    } catch (e) {
        xbLog.warn(MODULE_ID, `删除服务器向量数据失败: chat=${key} err=${e?.message || e}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 序列化（zip: manifest + jsonl + Float32 bin）
// ═══════════════════════════════════════════════════════════════════════════

function serializeVectorTable(records, getId, extraMeta = null) {
    const metas = [];
    const buffers = [];
    for (const rec of records) {
        const dims = rec.vector ? rec.vector.byteLength / 4 : 0;
        const meta = { id: getId(rec), dims, fingerprint: rec.fingerprint ?? null };
        if (extraMeta) Object.assign(meta, extraMeta(rec));
        metas.push(meta);
        if (dims > 0) buffers.push(rec.vector);
    }
    return {
        jsonl: metas.map(m => JSON.stringify(m)).join('\n'),
        bin: concatVectorBuffers(buffers),
        metas,
    };
}

function serializeDataset(ds) {
    const chunkVecs = serializeVectorTable([...ds.chunkVectors.values()], r => r.chunkId);
    const eventVecs = serializeVectorTable([...ds.eventVectors.values()], r => r.eventId);

    const stateRecords = [...ds.stateVectors.values()];
    const stateVecs = serializeVectorTable(stateRecords, r => r.atomId, r => ({
        floor: r.floor,
        rDims: r.rVector ? r.rVector.byteLength / 4 : 0,
    }));
    const stateRBin = concatVectorBuffers(stateRecords.filter(r => r.rVector).map(r => r.rVector));

    const manifest = {
        version: FORMAT_VERSION,
        chatId: ds.chatId,
        savedAt: Date.now(),
        meta: ds.meta,
        chunkCount: ds.chunks.size,
        chunkVectorCount: ds.chunkVectors.size,
        eventVectorCount: ds.eventVectors.size,
        stateVectorCount: ds.stateVectors.size,
    };

    return {
        zipData: zipSync({
            'manifest.json': strToU8(JSON.stringify(manifest)),
            'chunks.json': strToU8(JSON.stringify([...ds.chunks.values()])),
            'chunk_vectors.jsonl': strToU8(chunkVecs.jsonl),
            'chunk_vectors.bin': chunkVecs.bin,
            'event_vectors.jsonl': strToU8(eventVecs.jsonl),
            'event_vectors.bin': eventVecs.bin,
            'state_vectors.jsonl': strToU8(stateVecs.jsonl),
            'state_vectors.bin': stateVecs.bin,
            'state_r_vectors.bin': stateRBin,
        }, { level: 1 }),
        savedAt: manifest.savedAt,
    };
}

function parseJsonl(unzipped, name) {
    const text = unzipped[name] ? strFromU8(unzipped[name]) : '';
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function deserializeVectorTable(unzipped, jsonlName, binName) {
    const metas = parseJsonl(unzipped, jsonlName);
    const bytes = unzipped[binName] || new Uint8Array(0);
    const out = [];
    let floatOffset = 0;
    for (const meta of metas) {
        const dims = Number(meta.dims) || 0;
        const vector = dims > 0 ? sliceVectorBuffer(bytes, floatOffset, dims) : null;
        floatOffset += dims;
        out.push({ ...meta, vector });
    }
    return out;
}

function applySerializedData(ds, parsed) {
    const { manifest, chunks, chunkVectors, eventVectors, stateVectors, stateRBytes } = parsed;

    ds.meta = manifest.meta || null;
    ds.chunks.clear();
    ds.chunkVectors.clear();
    ds.eventVectors.clear();
    ds.stateVectors.clear();

    for (const chunk of chunks) {
        if (chunk?.chunkId) ds.chunks.set(chunk.chunkId, { ...chunk, chatId: ds.chatId });
    }
    for (const rec of chunkVectors) {
        if (!rec.id || !rec.vector) continue;
        ds.chunkVectors.set(rec.id, {
            chatId: ds.chatId, chunkId: rec.id,
            vector: rec.vector, dims: rec.dims, fingerprint: rec.fingerprint,
        });
    }
    for (const rec of eventVectors) {
        if (!rec.id || !rec.vector) continue;
        ds.eventVectors.set(rec.id, {
            chatId: ds.chatId, eventId: rec.id,
            vector: rec.vector, dims: rec.dims, fingerprint: rec.fingerprint,
        });
    }
    let rFloatOffset = 0;
    for (const rec of stateVectors) {
        if (!rec.id || !rec.vector) continue;
        const rDims = Number(rec.rDims) || 0;
        const rVector = rDims > 0 ? sliceVectorBuffer(stateRBytes, rFloatOffset, rDims) : null;
        rFloatOffset += rDims;
        ds.stateVectors.set(rec.id, {
            chatId: ds.chatId, atomId: rec.id, floor: rec.floor,
            vector: rec.vector, dims: rec.dims,
            rVector, rDims,
            fingerprint: rec.fingerprint,
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 服务器读写
// ═══════════════════════════════════════════════════════════════════════════

async function fetchServerVectorMeta(chatId, headers) {
    try {
        const res = await fetch(`/user/files/${getVectorMetaFilename(chatId)}`, { headers, cache: 'no-cache' });
        if (!res.ok) return null;
        const json = await res.json();
        return Number.isFinite(json?.v) ? json : null;
    } catch {
        return null;
    }
}

async function fetchServerZip(chatId, headers) {
    try {
        const res = await fetch(`/user/files/${getVectorDataFilename(chatId)}`, { headers, cache: 'no-cache' });
        if (!res.ok) return null;
        const arrayBuffer = await res.arrayBuffer();
        if (!arrayBuffer?.byteLength) return null;
        return new Uint8Array(arrayBuffer);
    } catch {
        return null;
    }
}

function parseZipBytes(chatId, bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let unzipped;
    try {
        unzipped = unzipSync(u8);
    } catch {
        xbLog.warn(MODULE_ID, `向量数据无法解压，忽略: chat=${chatId}`);
        return null;
    }
    if (!unzipped['manifest.json']) return null;

    const manifest = JSON.parse(strFromU8(unzipped['manifest.json']));
    if (manifest.version !== FORMAT_VERSION) {
        xbLog.warn(MODULE_ID, `不支持的向量数据版本 ${manifest.version}，忽略: chat=${chatId}`);
        return null;
    }
    if (manifest.chatId !== chatId) {
        // 文件名哈希冲突（极小概率）：拒绝加载，避免串数据
        xbLog.warn(MODULE_ID, `向量数据 chatId 不匹配（文件=${manifest.chatId} 当前=${chatId}），忽略`);
        return null;
    }

    return {
        manifest,
        chunks: unzipped['chunks.json'] ? JSON.parse(strFromU8(unzipped['chunks.json'])) : [],
        chunkVectors: deserializeVectorTable(unzipped, 'chunk_vectors.jsonl', 'chunk_vectors.bin'),
        eventVectors: deserializeVectorTable(unzipped, 'event_vectors.jsonl', 'event_vectors.bin'),
        stateVectors: deserializeVectorTable(unzipped, 'state_vectors.jsonl', 'state_vectors.bin'),
        stateRBytes: unzipped['state_r_vectors.bin'] || new Uint8Array(0),
    };
}

/**
 * 加载顺序：
 * 1. 缓存与服务器版本一致 → 用缓存（省下载）
 * 2. 缓存比服务器新 → 用缓存 + 标记补传（上次上传没完成）
 * 3. 其余 → 下载服务器 zip 并写缓存
 * 4. 服务器丢了但缓存还在 → 用缓存 + 补传（兜底）
 */
async function loadDatasetWithCache(chatId) {
    const headers = await resolveRequestHeaders();
    if (!headers) return null;

    schedulePruneCacheOnce();

    const [serverMeta, cached] = await Promise.all([
        fetchServerVectorMeta(chatId, headers),
        cacheGet(chatId),
    ]);

    if (cached?.bytes && serverMeta && cached.savedAt === serverMeta.v) {
        const parsed = parseZipBytes(chatId, cached.bytes);
        if (parsed) {
            touchCacheEntry(cached);
            return { parsed, source: 'cache', needsReupload: false };
        }
    }

    if (cached?.bytes && (!serverMeta || cached.savedAt > serverMeta.v)) {
        const parsed = parseZipBytes(chatId, cached.bytes);
        if (parsed) {
            touchCacheEntry(cached);
            return { parsed, source: 'cache-ahead', needsReupload: true };
        }
    }

    const bytes = await fetchServerZip(chatId, headers);
    if (bytes) {
        const parsed = parseZipBytes(chatId, bytes);
        if (parsed) {
            cachePut({
                chatId,
                savedAt: Number(parsed.manifest.savedAt) || 0,
                lastAccessAt: Date.now(),
                bytes,
            });
            return { parsed, source: 'server', needsReupload: false };
        }
    }

    if (cached?.bytes) {
        const parsed = parseZipBytes(chatId, cached.bytes);
        if (parsed) {
            touchCacheEntry(cached);
            return { parsed, source: 'cache-fallback', needsReupload: true };
        }
    }

    return null;
}

async function saveDataset(ds, { silent = true, keepaliveHint = false } = {}) {
    if (!ds.loaded && !ds.loading) return true;
    if (ds.dirtyVersion === ds.savedVersion) return true;

    if (ds.saving) {
        // 已有保存在途：等它结束后由 finally 里的补偿逻辑重新调度
        if (!silent) throw new Error('保存进行中，请稍后重试');
        return true;
    }

    // 空数据集且服务器上本来就没有文件：不为它创建文件
    if (isDatasetEmpty(ds) && !ds.serverFileExists) {
        ds.savedVersion = ds.dirtyVersion;
        return true;
    }

    const headers = await resolveRequestHeaders();
    if (!headers) {
        ds.savedVersion = ds.dirtyVersion;   // 内存模式视为已保存
        return true;
    }

    ds.saving = true;
    const versionToSave = ds.dirtyVersion;

    try {
        const { zipData, savedAt } = serializeDataset(ds);
        // 先写本地缓存：页面在上传完成前被杀时，下次启动可从缓存补传
        await cachePut({ chatId: ds.chatId, savedAt, lastAccessAt: Date.now(), bytes: zipData });

        const body = JSON.stringify({
            name: getVectorDataFilename(ds.chatId),
            data: uint8ToBase64(zipData),
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        let res;
        try {
            res = await fetch('/api/files/upload', {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
                keepalive: keepaliveHint && body.length < KEEPALIVE_BODY_LIMIT,
            });
        } finally {
            clearTimeout(timeoutId);
        }
        if (!res.ok) throw new Error(`服务器返回 ${res.status}`);

        // 版本 meta 小文件（供下次加载做廉价比对；失败可容忍，缓存领先会自愈补传）
        try {
            const metaRes = await fetch('/api/files/upload', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    name: getVectorMetaFilename(ds.chatId),
                    data: uint8ToBase64(strToU8(JSON.stringify({ v: savedAt }))),
                }),
            });
            if (!metaRes.ok) xbLog.warn(MODULE_ID, `版本 meta 上传失败(${metaRes.status}): chat=${ds.chatId}`);
        } catch (e) {
            xbLog.warn(MODULE_ID, `版本 meta 上传失败: chat=${ds.chatId} err=${e?.message || e}`);
        }

        ds.savedVersion = Math.max(ds.savedVersion, versionToSave);
        ds.serverFileExists = true;
        ds.baseSavedAt = savedAt;
        ds.retryCount = 0;
        if (ds.retryTimer) {
            clearTimeout(ds.retryTimer);
            ds.retryTimer = null;
        }
        xbLog.info(MODULE_ID, `向量数据已保存: chat=${ds.chatId} size=${(zipData.byteLength / 1024).toFixed(0)}KB`);
        return true;
    } catch (err) {
        ds.retryCount++;
        xbLog.warn(MODULE_ID, `向量数据保存失败(${ds.retryCount}/${MAX_SAVE_RETRIES}): chat=${ds.chatId} err=${err?.message || err}`);
        if (!ds.retryTimer && ds.retryCount <= MAX_SAVE_RETRIES && datasets.get(ds.chatId) === ds) {
            const delay = Math.min(30000, 2000 * (2 ** Math.max(0, ds.retryCount - 1)));
            ds.retryTimer = setTimeout(() => {
                ds.retryTimer = null;
                saveDataset(ds).catch(() => {});
            }, delay);
        }
        if (!silent) throw err;
        return false;
    } finally {
        ds.saving = false;
        if (ds.dirtyVersion > ds.savedVersion && !ds.retryTimer && !ds.saveTimer) {
            markDatasetDirty(ds.chatId);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 旧 IndexedDB 数据迁移（一次性：读出 → 存后端 → 删浏览器数据）
// ═══════════════════════════════════════════════════════════════════════════

async function migrateFromLegacyIndexedDb(ds) {
    if (typeof indexedDB === 'undefined') return;

    let Dexie;
    try {
        ({ default: Dexie } = await import('../../../libs/dexie.mjs'));
    } catch {
        return;
    }

    const exists = await Dexie.exists('LittleWhiteBox_Memory').catch(() => false);
    if (!exists) return;

    const db = new Dexie('LittleWhiteBox_Memory');
    db.version(3).stores({
        meta: 'chatId',
        chunks: '[chatId+chunkId], chatId, [chatId+floor]',
        chunkVectors: '[chatId+chunkId], chatId',
        eventVectors: '[chatId+eventId], chatId',
        stateVectors: '[chatId+atomId], chatId, [chatId+floor]',
    });

    try {
        const chatId = ds.chatId;
        const [meta, chunks, chunkVectors, eventVectors, stateVectors] = await Promise.all([
            db.meta.get(chatId),
            db.chunks.where('chatId').equals(chatId).toArray(),
            db.chunkVectors.where('chatId').equals(chatId).toArray(),
            db.eventVectors.where('chatId').equals(chatId).toArray(),
            db.stateVectors.where('chatId').equals(chatId).toArray(),
        ]);

        const hasData = meta || chunks.length || chunkVectors.length || eventVectors.length || stateVectors.length;
        if (!hasData) return;

        ds.meta = meta || null;
        for (const c of chunks) ds.chunks.set(c.chunkId, c);
        for (const v of chunkVectors) ds.chunkVectors.set(v.chunkId, v);
        for (const v of eventVectors) ds.eventVectors.set(v.eventId, v);
        for (const v of stateVectors) ds.stateVectors.set(v.atomId, v);

        ds.dirtyVersion++;
        const saved = await saveDataset(ds, { silent: true });
        if (!saved) {
            xbLog.warn(MODULE_ID, `旧数据迁移：上传失败，暂不清理浏览器数据 chat=${chatId}`);
            return;
        }

        // 上传成功才清理浏览器侧数据
        await Promise.all([
            db.meta.delete(chatId),
            db.chunks.where('chatId').equals(chatId).delete(),
            db.chunkVectors.where('chatId').equals(chatId).delete(),
            db.eventVectors.where('chatId').equals(chatId).delete(),
            db.stateVectors.where('chatId').equals(chatId).delete(),
        ]);
        xbLog.info(MODULE_ID, `旧 IndexedDB 向量数据已迁移到服务器并清理: chat=${chatId} chunks=${chunks.length} l1v=${chunkVectors.length} l2v=${eventVectors.length} l0v=${stateVectors.length}`);

        // 若整库已空则直接删库
        const remaining = await Promise.all([
            db.meta.count(), db.chunks.count(), db.chunkVectors.count(),
            db.eventVectors.count(), db.stateVectors.count(),
        ]);
        if (remaining.every(c => c === 0)) {
            db.close();
            await Dexie.delete('LittleWhiteBox_Memory');
            xbLog.info(MODULE_ID, '旧 IndexedDB 库已全部迁移完毕，删除 LittleWhiteBox_Memory');
            return;
        }
    } catch (e) {
        xbLog.warn(MODULE_ID, `旧 IndexedDB 迁移失败（忽略）: ${e?.message || e}`);
    } finally {
        try { db.close(); } catch { /* 已关闭 */ }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 多设备：回到前台时校验服务器版本，别的设备写过就失效本地数据集
// （失效后下次访问会重新加载；本地有未上传改动时以本地为准，不失效）
// ═══════════════════════════════════════════════════════════════════════════

const REVALIDATE_MIN_INTERVAL_MS = 30 * 1000;
let lastRevalidateAt = 0;

async function revalidateLoadedDatasets(reason = 'focus') {
    const now = Date.now();
    if (now - lastRevalidateAt < REVALIDATE_MIN_INTERVAL_MS) return;
    lastRevalidateAt = now;

    const headers = await resolveRequestHeaders();
    if (!headers) return;

    for (const [key, ds] of [...datasets.entries()]) {
        if (!ds.loaded || ds.saving) continue;
        if (ds.dirtyVersion !== ds.savedVersion) continue;
        if (!ds.baseSavedAt) continue;

        const meta = await fetchServerVectorMeta(key, headers);
        if (meta && meta.v > ds.baseSavedAt) {
            if (ds.saveTimer) clearTimeout(ds.saveTimer);
            if (ds.retryTimer) clearTimeout(ds.retryTimer);
            datasets.delete(key);
            xbLog.info(MODULE_ID, `服务器向量数据有更新（其他设备写入），失效本地数据集待重载: chat=${key} reason=${reason}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 页面隐藏/卸载时的兜底 flush
// ═══════════════════════════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => flushAllDatasetsBestEffort('pagehide'));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushAllDatasetsBestEffort('hidden');
        } else if (document.visibilityState === 'visible') {
            revalidateLoadedDatasets('visible').catch(() => {});
        }
    });
}
