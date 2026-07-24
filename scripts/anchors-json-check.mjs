import { extractAnchorsPayload, stripThinkingBlocks } from '../modules/story-summary/vector/llm/anchors-json.js';

const clean = '{"anchors":[{"scene":"旅人推开酒馆的门向老板娘玛莎点了一杯麦酒。玛莎笑着将麦酒推到旅人面前，并压低声音神秘地告知他，北边的矿洞最近正在闹鬼。","edges":[{"s":"旅人","t":"老板娘玛莎","r":"点麦酒"}],"where":"酒馆"}]}';

// 案例1: 思考漏出 + 模板回显 + 截断（旧代码解析出模板 → 假"空"）
const leak = '思考过程：1. 分析输入... JSON结构：`{"anchors":[{"scene":"60-100字场景描述","edges":[{"s":"施事方","t":"受事方","r":"互动行为"}],"where":"地点"}]}` 2. 提取场景信息... *锚点1*: scene: 旅人推开酒馆大门，向老板娘玛莎点了一杯麦酒。玛莎将麦酒推给旅人，并神秘地压低声音，透露了北边矿洞最近闹鬼以及三名矿工离奇失踪的惊悚传闻。 (73字，符';

// 案例3: 真 JSON 中途截断（第二个锚点被砍）
const trunc = '{\n "anchors": [\n {\n "scene": "旅人推开酒馆厚重的木门走进去，向老板娘玛莎点了一杯麦酒。老板娘玛莎热情地接待了这位远道而来的客人，酒馆内弥漫着浓郁的麦酒香气。",\n "edges": [{"s": "旅人", "t": "老板娘玛莎", "r": "点麦酒"}],\n "where": "酒馆"\n },\n {\n "scene": "老板娘玛莎将倒好的麦酒轻轻推到旅人面前，';

const braces = '{"anchors":[{"scene":"艾拉在图书馆读到一本写着{禁忌}符号的古书，随后将它藏进了斗篷内袋，神情紧张地离开了大厅。","edges":[],"where":"图书馆"}]}';

const cases = [
    ['模板回显+截断→判失败', () => extractAnchorsPayload(leak) === null],
    ['干净JSON', () => { const r = extractAnchorsPayload(clean); return r?.anchors?.length === 1 && !r.salvaged; }],
    ['截断挽救首个完整锚点', () => { const r = extractAnchorsPayload(trunc); return r?.anchors?.length === 1 && r.salvaged === true && r.anchors[0].where === '酒馆'; }],
    ['明确空结果', () => { const r = extractAnchorsPayload('{"anchors":[]}'); return r && r.anchors.length === 0; }],
    ['代码围栏包裹', () => { const r = extractAnchorsPayload('```json\n' + clean + '\n```'); return r?.anchors?.length === 1; }],
    ['模板回显后接真答案', () => { const r = extractAnchorsPayload(leak.slice(0, 140) + '\n最终答案：\n' + clean); return r?.anchors?.length === 1 && r.anchors[0].scene.includes('矿洞'); }],
    ['scene含大括号', () => { const r = extractAnchorsPayload(braces); return r?.anchors?.length === 1; }],
    ['纯文本无JSON', () => extractAnchorsPayload('抱歉，我不能处理这个请求。') === null],
    ['空输入', () => extractAnchorsPayload('') === null],
    ['strip: think块后接答案', () => stripThinkingBlocks('<think>推理推理</think>\n' + clean) === clean],
    ['strip: thinking标签变体', () => stripThinkingBlocks('<thinking>a</thinking>X') === 'X'],
    ['strip: 多个成对块', () => stripThinkingBlocks('<think>a</think>中<think>b</think>尾') === '尾'],
    ['strip: 未闭合被截断→空', () => stripThinkingBlocks('<think>推理到一半被截断') === ''],
    ['strip: 闭合后无内容→移除块', () => stripThinkingBlocks('<think>a</think>') === ''],
    ['strip: 无标签原样返回', () => stripThinkingBlocks(clean) === clean],
    ['strip+extract 组合', () => {
        const r = extractAnchorsPayload(stripThinkingBlocks('<think>模板：{"anchors":[{"scene":"60-100字场景描述"}]}</think>\n' + clean));
        return r?.anchors?.length === 1 && r.anchors[0].scene.includes('矿洞');
    }],
];

let failed = 0;
for (const [name, fn] of cases) {
    const ok = fn();
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failed++;
}
console.log(failed ? `result=FAIL (${failed})` : 'result=PASS');
process.exitCode = failed ? 1 : 0;
