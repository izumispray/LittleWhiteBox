/* global process */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatId = `runtime-check-${Date.now()}`;

function float32ToBuffer(values) {
    const arr = new Float32Array(values);
    return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

async function collectJsFiles(dir) {
    const out = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...await collectJsFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

async function assertNoBusinessVectorCacheImports() {
    const files = await collectJsFiles(path.join(rootDir, 'modules', 'story-summary'));
    const offenders = [];
    for (const file of files) {
        if (file.endsWith(path.join('vector', 'storage', 'vector-cache.js'))) continue;
        const text = await fs.readFile(file, 'utf8');
        if (text.includes('vector-cache.js')) {
            offenders.push(path.relative(rootDir, file));
        }
    }
    return offenders;
}

async function main() {
    const [
        storeModule,
        runtimeModule,
        scoringModule,
    ] = await Promise.all([
        import('../modules/story-summary/data/vector-store.js'),
        import('../modules/story-summary/vector/runtime/runtime.js'),
        import('../modules/story-summary/vector/runtime/scoring.js'),
    ]);

    const {
        configureVectorStorePersistence,
        ensureDataset,
        markDatasetDirty,
    } = storeModule;
    configureVectorStorePersistence({ mode: 'memory' });
    const {
        beginRecallRuntimeSession,
        endRecallRuntimeSession,
        warmRecallRuntime,
        scoreRecallRuntimeL1,
        scoreRecallRuntimeAnchors,
        scoreRecallRuntimeEvents,
        diffuseRecallRuntimeL0,
        getRecallRuntimeStats,
        clearRecallRuntime,
    } = runtimeModule;
    const {
        scoreAnchorsFromStateVectors,
        scoreEventsFromEventVectors,
        scoreL1FromRecords,
    } = scoringModule;

    const chunks = [
        { chatId, chunkId: 'c-1-0', floor: 1, chunkIdx: 0, speaker: 'A', isUser: true, text: 'alpha memory', textHash: 'a' },
        { chatId, chunkId: 'c-1-1', floor: 1, chunkIdx: 1, speaker: 'B', isUser: false, text: 'beta memory', textHash: 'b' },
    ];
    const chunkVectors = [
        { chatId, chunkId: 'c-1-0', vector: float32ToBuffer([1, 0]), dims: 2, fingerprint: 'runtime-check' },
        { chatId, chunkId: 'c-1-1', vector: float32ToBuffer([0, 1]), dims: 2, fingerprint: 'runtime-check' },
    ];
    const eventVectors = [
        { chatId, eventId: 'evt-1', vector: float32ToBuffer([1, 0]), dims: 2, fingerprint: 'runtime-check' },
    ];
    const stateVectors = [
        { chatId, atomId: 'atom-1', floor: 1, vector: float32ToBuffer([1, 0]), rVector: float32ToBuffer([1, 0]), dims: 2, rDims: 2, fingerprint: 'runtime-check' },
    ];

    await (async () => {
        const ds = await ensureDataset(chatId);
        ds.meta = { chatId, fingerprint: 'runtime-check', lastChunkFloor: 2, updatedAt: Date.now() };
        for (const chunk of chunks) ds.chunks.set(chunk.chunkId, chunk);
        for (const rec of chunkVectors) ds.chunkVectors.set(rec.chunkId, rec);
        for (const rec of eventVectors) ds.eventVectors.set(rec.eventId, rec);
        for (const rec of stateVectors) ds.stateVectors.set(rec.atomId, rec);
        markDatasetDirty(chatId);
    })();

    const warm = await warmRecallRuntime(chatId, { reason: 'runtime-check' });
    const warmStats = getRecallRuntimeStats().find((item) => item.chatId === chatId) || getRecallRuntimeStats()[0] || {};
    const lease = await beginRecallRuntimeSession(chatId, { reason: 'runtime-check' });
    await runtimeModule.retainRecallRuntimeOnly('__other_chat__');
    await clearRecallRuntime(chatId);
    const l1 = await scoreRecallRuntimeL1(chatId, [1], [1, 0]);
    const anchors = await scoreRecallRuntimeAnchors(chatId, [1, 0]);
    const events = await scoreRecallRuntimeEvents(chatId, [1, 0]);
    const diffusion = await diffuseRecallRuntimeL0(chatId, [{ atomId: 'atom-1', floor: 1, similarity: 1 }], [{ atomId: 'atom-1', floor: 1, semantic: 'alpha memory' }], [1, 0], { name1: 'A' });
    const stats = getRecallRuntimeStats().find((item) => item.chatId === chatId) || getRecallRuntimeStats()[0] || {};
    runtimeModule.markRecallRuntimeDirty(chatId, 'runtime-check-during-session');
    const endStats = await endRecallRuntimeSession(lease);
    const dirtyStats = getRecallRuntimeStats().find((item) => item.chatId === chatId) || {};

    // 缓存常驻协议：脏标记消费一轮后，未标脏的会话必须复用常驻数据，
    // 标脏后的会话必须强制刷新拿到最新快照
    await scoreRecallRuntimeL1(chatId, [1], [1, 0]);   // 消费 during-session 的脏标记
    const dsMut = await ensureDataset(chatId);
    dsMut.chunks.set('c-1-2', { chatId, chunkId: 'c-1-2', floor: 1, chunkIdx: 2, speaker: 'C', isUser: false, text: 'gamma memory', textHash: 'c' });
    dsMut.chunkVectors.set('c-1-2', { chatId, chunkId: 'c-1-2', vector: float32ToBuffer([1, 0]), dims: 2, fingerprint: 'runtime-check' });
    const staleL1 = await scoreRecallRuntimeL1(chatId, [1], [1, 0]);
    const staleCount = (staleL1.get(1) || []).length;
    runtimeModule.markRecallRuntimeDirty(chatId, 'runtime-check-mutation');
    const freshL1 = await scoreRecallRuntimeL1(chatId, [1], [1, 0]);
    const freshCount = (freshL1.get(1) || []).length;
    const offenders = await assertNoBusinessVectorCacheImports();

    const l1Stats = l1._stats || {};
    const top = l1.get(1)?.[0] || null;
    const expectedAnchors = scoreAnchorsFromStateVectors(stateVectors, [1, 0]);
    const expectedEvents = scoreEventsFromEventVectors(eventVectors, [1, 0]);
    const expectedL1 = scoreL1FromRecords(chunks, chunkVectors, [1, 0]).result;
    const scoreClose = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 1e-6;

    const checks = [
        ['warmLoadsData', !!warm?.ready && !warm?.skipped && warmStats.chunkVectors === 2 && warmStats.stateVectors === 1 && warmStats.eventVectors === 1],
        ['sessionReady', !!lease?.ready],
        ['l1TopChunk', top?.chunkId === 'c-1-0'],
        ['l1DbFallback', Number(l1Stats.cacheFallbackDbTime || 0) === 0],
        ['anchorScore', anchors?.scores?.[0]?.atomId === expectedAnchors[0]?.atomId && scoreClose(anchors?.scores?.[0]?.similarity, expectedAnchors[0]?.similarity)],
        ['eventScore', events?.scores?.[0]?.eventId === expectedEvents[0]?.eventId && scoreClose(events?.scores?.[0]?.similarity, expectedEvents[0]?.similarity)],
        ['l1Exact', top?.chunkId === expectedL1[0]?.chunkId && scoreClose(top?._cosineScore, expectedL1[0]?._cosineScore)],
        ['diffusionSmoke', !!diffusion?.metrics],
        ['retainClearProtectActiveSession', top?.chunkId === 'c-1-0' && anchors?.scores?.length > 0 && events?.scores?.length > 0],
        ['sessionEndRetainsCache', endStats?.status === 'ready' && endStats.chunkVectors === 2 && endStats.stateVectors === 1],
        ['dirtyRetainedDuringSession', dirtyStats.dirtyReason === 'runtime-check-during-session'],
        ['warmReuseWithoutDirty', staleCount === 2],
        ['dirtyForcesRefresh', freshCount === 3],
        ['cacheOwner', ['worker', 'runtime-main'].includes(String(stats.owner || l1Stats.cacheOwner || ''))],
        ['noBusinessVectorCacheImports', offenders.length === 0],
    ];

    const failed = checks.filter(([, ok]) => !ok);
    const backend = stats.backend || l1Stats.backend || 'unknown';
    const cacheOwner = stats.owner || l1Stats.cacheOwner || 'unknown';
    const promptParity = top?.text === 'alpha memory' ? 'PASS' : 'FAIL';

    console.log('[story-summary-runtime]');
    console.log(`runtime backend=${backend}`);
    console.log(`warm result=${warm?.ready ? 'READY' : 'FAIL'} status=${warmStats.status || 'unknown'}`);
    console.log(`L0/L1/L2 cache owner=${cacheOwner}`);
    console.log(`DB fallback count=${Number(l1Stats.cacheFallbackDbTime || 0) === 0 ? 0 : 1}`);
    console.log(`promptParity=${promptParity}`);
    console.log(`sessionEndRetainsCache=${endStats?.status === 'ready' && endStats.chunkVectors === 2 ? 'PASS' : 'FAIL'}`);
    console.log(`dirtyDuringSession=${dirtyStats.dirtyReason === 'runtime-check-during-session' ? 'PASS' : 'FAIL'}`);
    console.log(`cacheReuse=${staleCount === 2 ? 'PASS' : 'FAIL'} dirtyRefresh=${freshCount === 3 ? 'PASS' : 'FAIL'}`);
    console.log(`vectorCacheImports=${offenders.length ? `FAIL ${offenders.join(', ')}` : 'PASS'}`);
    console.log(`result=${failed.length ? 'FAIL' : 'PASS'}`);

    await clearRecallRuntime(chatId);

    if (failed.length) {
        console.error('failed checks:');
        for (const [name] of failed) console.error(`- ${name}`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error('[story-summary-runtime] failed');
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
});
