// ═══════════════════════════════════════════════════════════════════════════
// recall-status.js - 召回进度小药丸
//
// 发送消息前的记忆召回会阻塞正文生成（嵌入 → 检索 → 精排），
// 之前全程无提示，用户只看到页面"卡住"。这里在页面角落挂一个
// 轻量状态条，随召回阶段更新，完成/失败/降级都有反馈。
// 纯 DOM 副作用模块，Node 测试环境下自动 no-op。
// ═══════════════════════════════════════════════════════════════════════════

const PILL_ID = 'lwb-recall-status-pill';
const HIDE_DELAY_OK_MS = 2000;
const HIDE_DELAY_FAIL_MS = 5000;

let hideTimer = null;
let cycleActive = false;
let startedAt = 0;
let finished = false;

function hasDom() {
    return typeof document !== 'undefined' && !!document.body;
}

function getPill() {
    let el = document.getElementById(PILL_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = PILL_ID;
        el.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:96px', 'z-index:99998',
            'padding:5px 14px', 'border-radius:999px',
            'background:rgba(18,18,18,.85)', 'color:#e5e7eb',
            'font-size:12px', 'line-height:1.4',
            'font-family:"Segoe UI","Microsoft YaHei UI",sans-serif',
            'box-shadow:0 2px 12px rgba(0,0,0,.35)',
            'pointer-events:none', 'user-select:none',
            'opacity:0', 'transition:opacity 200ms ease',
            'max-width:60vw', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
        ].join(';');
        document.body.appendChild(el);
    }
    return el;
}

/** 进入/更新某个召回阶段（首次调用视为一轮召回开始） */
export function recallPillStage(text) {
    if (!hasDom()) return;
    if (!cycleActive) {
        cycleActive = true;
        finished = false;
        startedAt = performance.now();
    }
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    const el = getPill();
    el.textContent = `🧠 记忆召回 · ${text}`;
    el.style.color = '#e5e7eb';
    el.style.opacity = '1';
}

/**
 * 结束一轮召回（幂等：一轮里只有第一次调用生效）
 * @param {boolean} ok
 * @param {string} extra - 附加说明（如"精排降级"），失败时为原因
 */
export function recallPillFinish(ok, extra = '') {
    if (!hasDom() || !cycleActive || finished) return;
    finished = true;
    cycleActive = false;
    const el = getPill();
    const secs = ((performance.now() - startedAt) / 1000).toFixed(1);
    if (ok) {
        el.textContent = `🧠 记忆召回完成 ${secs}s${extra ? ` · ${extra}` : ''}`;
        el.style.color = extra ? '#fbbf24' : '#a7f3d0';
    } else {
        el.textContent = `🧠 记忆召回失败${extra ? ` · ${extra}` : ''}（本次跳过）`;
        el.style.color = '#fca5a5';
    }
    hideTimer = setTimeout(() => {
        el.style.opacity = '0';
        hideTimer = null;
    }, ok ? HIDE_DELAY_OK_MS : HIDE_DELAY_FAIL_MS);
}

// ═══════════════════════════════════════════════════════════════════════════
// 发送链路阶段（召回完成后：ST 组装正文提示词 → 等待模型首个响应）
// 复用同一个药丸元素，独立于召回周期
// ═══════════════════════════════════════════════════════════════════════════

export function sendPathPillShow(text) {
    if (!hasDom()) return;
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    const el = getPill();
    el.textContent = `⏳ ${text}`;
    el.style.color = '#e5e7eb';
    el.style.opacity = '1';
}

export function sendPathPillHide() {
    if (!hasDom()) return;
    const el = document.getElementById(PILL_ID);
    if (el) el.style.opacity = '0';
}
