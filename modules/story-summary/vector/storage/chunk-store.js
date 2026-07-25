// ═══════════════════════════════════════════════════════════════════════════
// Story Summary - Chunk Store (L1/L2 storage)
// 数据存后端（vector-store），不再使用浏览器 IndexedDB
// ═══════════════════════════════════════════════════════════════════════════

import {
    ensureDataset,
    markDatasetDirty,
    deleteDatasetEverywhere,
    setDatasetInvalidationListener,
} from '../../data/vector-store.js';
import {
    applyRecallRuntimeMutationBestEffort,
    clearRecallRuntime,
} from '../runtime/runtime.js';

// 其他设备更新了服务器向量数据 → 本地数据集被失效重载时，
// 召回运行时的常驻缓存也必须同步标脏，否则会一直用旧向量打分
setDatasetInvalidationListener((chatId, reason) => {
    applyRecallRuntimeMutationBestEffort(chatId, { type: `dataset-invalidated:${reason || 'server'}` });
});

// Chunk parameters
export const CHUNK_MAX_TOKENS = 200;

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

export function float32ToBuffer(arr) {
    return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

export function bufferToFloat32(buffer) {
    return new Float32Array(buffer);
}

export function makeChunkId(floor, chunkIdx) {
    return `c-${floor}-${chunkIdx}`;
}

export function hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
}

// ═══════════════════════════════════════════════════════════════════════════
// Meta 操作
// ═══════════════════════════════════════════════════════════════════════════

export async function getMeta(chatId) {
    const ds = await ensureDataset(chatId);
    if (!ds.meta) {
        ds.meta = {
            chatId,
            fingerprint: null,
            lastChunkFloor: -1,
            updatedAt: Date.now(),
        };
        markDatasetDirty(chatId);
    }
    return ds.meta;
}

export async function updateMeta(chatId, updates) {
    const ds = await ensureDataset(chatId);
    ds.meta = {
        ...(ds.meta || { chatId }),
        ...updates,
        updatedAt: Date.now(),
    };
    markDatasetDirty(chatId);
    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'meta',
        meta: updates,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Chunks 操作
// ═══════════════════════════════════════════════════════════════════════════

export async function saveChunks(chatId, chunks) {
    const ds = await ensureDataset(chatId);
    const records = chunks.map(chunk => ({
        chatId,
        chunkId: chunk.chunkId,
        floor: chunk.floor,
        chunkIdx: chunk.chunkIdx,
        speaker: chunk.speaker,
        isUser: chunk.isUser,
        text: chunk.text,
        textHash: chunk.textHash,
        createdAt: Date.now(),
    }));
    for (const record of records) {
        ds.chunks.set(record.chunkId, record);
    }
    markDatasetDirty(chatId);
    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'upsertChunks',
        chunks: records,
    });
}

export async function getAllChunks(chatId) {
    const ds = await ensureDataset(chatId);
    return [...ds.chunks.values()];
}

export async function getChunksByFloors(chatId, floors) {
    const ds = await ensureDataset(chatId);
    const wanted = new Set(floors);
    return [...ds.chunks.values()].filter(c => wanted.has(c.floor));
}

/**
 * 删除指定楼层及之后的所有 chunk 和向量
 */
export async function deleteChunksFromFloor(chatId, fromFloor) {
    const ds = await ensureDataset(chatId);
    for (const [chunkId, chunk] of [...ds.chunks.entries()]) {
        if (chunk.floor >= fromFloor) {
            ds.chunks.delete(chunkId);
            ds.chunkVectors.delete(chunkId);
        }
    }
    markDatasetDirty(chatId);
    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'deleteChunksFromFloor',
        floor: fromFloor,
    });
}

/**
 * 删除指定楼层的 chunk 和向量
 */
export async function deleteChunksAtFloor(chatId, floor) {
    const ds = await ensureDataset(chatId);
    for (const [chunkId, chunk] of [...ds.chunks.entries()]) {
        if (chunk.floor === floor) {
            ds.chunks.delete(chunkId);
            ds.chunkVectors.delete(chunkId);
        }
    }
    markDatasetDirty(chatId);
    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'deleteChunksAtFloor',
        floor,
    });
}

export async function clearAllChunks(chatId) {
    const ds = await ensureDataset(chatId);
    ds.chunks.clear();
    ds.chunkVectors.clear();
    markDatasetDirty(chatId);
    await clearRecallRuntime(chatId, 'chunks');
}

// ═══════════════════════════════════════════════════════════════════════════
// ChunkVectors 操作
// ═══════════════════════════════════════════════════════════════════════════

export async function saveChunkVectors(chatId, items, fingerprint) {
    const ds = await ensureDataset(chatId);
    const records = items.map(item => ({
        chatId,
        chunkId: item.chunkId,
        vector: float32ToBuffer(new Float32Array(item.vector)),
        dims: item.vector.length,
        fingerprint,
    }));
    for (const record of records) {
        ds.chunkVectors.set(record.chunkId, record);
    }
    markDatasetDirty(chatId);
    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'upsertChunkVectors',
        items: records,
    });
}

export async function getAllChunkVectors(chatId) {
    const ds = await ensureDataset(chatId);
    return [...ds.chunkVectors.values()].map(r => ({
        ...r,
        vector: bufferToFloat32(r.vector),
    }));
}

export async function getChunkVectorsByIds(chatId, chunkIds, options = {}) {
    if (!chatId || !chunkIds?.length) return [];
    const { decode = true } = options;

    const ds = await ensureDataset(chatId);
    const records = [];
    for (const chunkId of chunkIds) {
        const r = ds.chunkVectors.get(chunkId);
        if (r) records.push(r);
    }

    if (!decode) {
        return records.map(r => ({
            chunkId: r.chunkId,
            vector: r.vector,
        }));
    }

    return records.map(r => ({
        chunkId: r.chunkId,
        vector: bufferToFloat32(r.vector),
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// EventVectors 操作
// ═══════════════════════════════════════════════════════════════════════════

export async function saveEventVectors(chatId, items, fingerprint) {
    const ds = await ensureDataset(chatId);
    const records = items.map(item => ({
        chatId,
        eventId: item.eventId,
        vector: float32ToBuffer(new Float32Array(item.vector)),
        dims: item.vector.length,
        fingerprint,
    }));
    for (const record of records) {
        ds.eventVectors.set(record.eventId, record);
    }
    markDatasetDirty(chatId);
    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'upsertEventVectors',
        items: records,
    });
}

export async function getAllEventVectors(chatId) {
    const ds = await ensureDataset(chatId);
    return [...ds.eventVectors.values()].map(r => ({
        ...r,
        vector: bufferToFloat32(r.vector),
    }));
}

export async function clearEventVectors(chatId) {
    const ds = await ensureDataset(chatId);
    ds.eventVectors.clear();
    markDatasetDirty(chatId);
    await clearRecallRuntime(chatId, 'events');
}

/**
 * 按 ID 列表删除 event 向量
 */
export async function deleteEventVectorsByIds(chatId, eventIds) {
    const ds = await ensureDataset(chatId);
    for (const eventId of eventIds) {
        ds.eventVectors.delete(eventId);
    }
    markDatasetDirty(chatId);
    applyRecallRuntimeMutationBestEffort(chatId, {
        type: 'deleteEventVectorsByIds',
        eventIds,
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// 统计与工具
// ═══════════════════════════════════════════════════════════════════════════

export async function getStorageStats(chatId) {
    const [meta, ds] = await Promise.all([
        getMeta(chatId),
        ensureDataset(chatId),
    ]);

    return {
        fingerprint: meta.fingerprint,
        lastChunkFloor: meta.lastChunkFloor,
        chunks: ds.chunks.size,
        chunkVectors: ds.chunkVectors.size,
        eventVectors: ds.eventVectors.size,
    };
}

export async function clearChatData(chatId) {
    const ds = await ensureDataset(chatId);
    ds.meta = null;
    ds.chunks.clear();
    ds.chunkVectors.clear();
    ds.eventVectors.clear();
    ds.stateVectors.clear();
    await deleteDatasetEverywhere(chatId);
    await clearRecallRuntime(chatId);
}

export async function ensureFingerprintMatch(chatId, newFingerprint) {
    const meta = await getMeta(chatId);
    if (meta.fingerprint && meta.fingerprint !== newFingerprint) {
        const ds = await ensureDataset(chatId);
        ds.chunkVectors.clear();
        ds.eventVectors.clear();
        markDatasetDirty(chatId);
        await updateMeta(chatId, {
            fingerprint: newFingerprint,
            lastChunkFloor: -1,
        });
        await clearRecallRuntime(chatId);
        return false;
    }
    if (!meta.fingerprint) {
        await updateMeta(chatId, { fingerprint: newFingerprint });
    }
    return true;
}
