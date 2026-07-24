// ============================================================================
// anchors-json.js - 从 LLM 原始输出中提取锚点 JSON（纯函数，无依赖）
//
// 现实中的 L0 模型输出远比"严格JSON"脏：
// - 思考模型（qwen3.7-plus 等）会把推理过程漏进 content，且常在推理里
//   逐字回显提示词中的 JSON 模板（占位 scene="60-100字场景描述"）
// - max_tokens 截断会把最终 JSON 拦腰砍断
// 朴素的"第一个{到最后一个}"解析会把模板回显当成真结果（表现为大量假"空"）。
//
// 策略：
// 1. 从文本末尾往前找能解析、带 anchors 数组、且内容有意义的完整对象
//    （最终答案总在推理之后；模板回显因 scene 是占位符被判无意义而跳过）
// 2. 全都不行时，定位最后一个 "anchors" 数组，逐个抠出完整的锚点对象
//    （截断挽救：丢掉被砍断的最后一个，保住前面完整的）
// ============================================================================

const MIN_SCENE_LEN = 15;
const PLACEHOLDER_SCENE_RE = /60-100字|场景描述/;

/**
 * 从 start 处的 '{' 开始做字符串感知的括号配平
 * @returns {number} 配平的 '}' 下标；未闭合返回 -1
 */
function scanBalancedObject(text, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
        } else if (ch === '"') {
            inStr = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** scene 达到最小长度且不是提示词模板的占位符 */
function isMeaningfulAnchor(anchor) {
    const scene = String(anchor?.scene || '').trim();
    if (scene.length < MIN_SCENE_LEN) return false;
    return !PLACEHOLDER_SCENE_RE.test(scene);
}

/**
 * 剥离 content 中内联的思维链，只留最终答案。
 * 网关/模型常见形态：
 * - "<think>...</think>答案"         → 取最后一个闭合标签之后
 * - "<think>...（被截断，无闭合）"    → 全是思维链，返回空串
 * - 多个成对块                        → 全部移除
 * - 无标签的纯文本推理泄漏            → 原样返回，交给 extractAnchorsPayload 从末尾找 JSON
 */
export function stripThinkingBlocks(rawText) {
    const s = String(rawText || '');
    if (!s) return '';

    const closeRe = /<\/think(?:ing)?>/gi;
    let lastClose = -1;
    let m;
    while ((m = closeRe.exec(s)) !== null) lastClose = m.index + m[0].length;

    if (lastClose !== -1) {
        const after = s.slice(lastClose).trim();
        if (after) return after;
        // 闭合标签后没有内容：移除所有成对块，看是否还剩答案
        return s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    }

    // 只有开标签没有闭合（思考中途被截断）：整段都是思维链
    if (/^\s*<think(?:ing)?>/i.test(s)) return '';

    return s;
}

function salvageTruncatedAnchors(text) {
    const keyIdx = text.lastIndexOf('"anchors"');
    if (keyIdx === -1) return null;
    const arrStart = text.indexOf('[', keyIdx);
    if (arrStart === -1) return null;

    const anchors = [];
    let i = arrStart + 1;
    while (i < text.length) {
        while (i < text.length && text[i] !== '{' && text[i] !== ']') i++;
        if (i >= text.length || text[i] === ']') break;
        const end = scanBalancedObject(text, i);
        if (end === -1) break;
        try {
            anchors.push(JSON.parse(text.slice(i, end + 1)));
        } catch {
            break;
        }
        i = end + 1;
    }

    const meaningful = anchors.filter(isMeaningfulAnchor);
    return meaningful.length ? { anchors: meaningful, salvaged: true } : null;
}

/**
 * 从 LLM 原始输出提取锚点载荷
 * @param {string} rawText
 * @returns {{anchors: object[], salvaged: boolean}|null}
 *   anchors 为空数组表示模型明确回答"无锚点"；null 表示无法提取
 */
export function extractAnchorsPayload(rawText) {
    const text = String(rawText || '');
    if (!text.trim()) return null;

    const starts = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') starts.push(i);
    }

    for (let k = starts.length - 1; k >= 0; k--) {
        const end = scanBalancedObject(text, starts[k]);
        if (end === -1) continue;
        let obj;
        try {
            obj = JSON.parse(text.slice(starts[k], end + 1));
        } catch {
            continue;
        }
        const anchors = obj?.anchors;
        if (!Array.isArray(anchors)) continue;
        if (anchors.length === 0) return { anchors: [], salvaged: false };
        if (anchors.some(isMeaningfulAnchor)) return { anchors, salvaged: false };
        // 全是占位/超短 scene：模板回显，继续向前找真结果
    }

    return salvageTruncatedAnchors(text);
}
