// 妄想天使桌宠 · AI 协议层（ai-core）
// 与 DeepSeek 交互的"纯协议"部分：注入规则常量、请求组装、情绪标签解析、mock、临时反应指令。
// 不依赖任何 UI/状态 —— 可单测；渲染层只调 PetAI.* 并处理动画/历史等自身职责。
// 加载顺序：core.js / settings.js 之后、renderer.js 之前 —— 见 index.html
/* eslint-disable no-console */
(function () {
  'use strict';

  // ---- 注入规则（隐性，只发 API；聊天历史仍存干净文本）----
  const IMMERS_RULE = '\n【角色沉浸要求】在你的思考过程(<think>标签内)中,请遵守以下规则:1. 请以角色第一人称进行内心独白,用括号包裹内心活动,例如"（心想：……）"或"(内心OS：……)" 2. 用第一人称描写角色的内心感受,例如"我心想""我觉得""我暗自"等 3. 思考内容应沉浸在角色中,通过内心独白分析剧情和规划回复\n若回复变"客服体",把【红线】复制到 system 末位重发一次;若结巴过量,加一行:结巴每三句最多一次。';
  // 方案A（强化遵循率）：每轮最新 user 消息末尾隐性追加 mood 提醒（用户不可见，仅发 API）
  const MOOD_REMIND = '\n\n（回复末尾需附情绪标签 <mood:X>，X 只能从: happy, sad, angry, shy, think, tired, proud 中选一个；没有合适情绪就不要输出。标签仅系统识别，不要向用户解释，不要出现在回复正文里。）';
  // 情绪反馈标签（隐性注入 system 末尾）——按用户情境触发：强烈情绪/反差/目的性互动
  const MOOD_RULE = '\n\n【情绪反馈（按需）】当发生以下任一情形时，在回复的末尾另起一行输出情绪标签 <mood:X>（X 从: happy, sad, angry, shy, think, tired, proud 中选最贴切的一个）: 1. 回复中的情绪很强烈（如爆笑、大哭、大怒、狂喜、极度紧张）; 2. 情绪与上一轮形成明显反差; 3. **用户发言有明显的目的性或"想看你的反应"的意味**——你要读懂用意并接住：用户故意逗你、耍你、拿你寻开心时，按角色被戳中的反应输出（被逗得小别扭/害羞/傲娇地生气）；用户刻意夸奖你、鼓励你、哄你时，按角色被戳中的反应输出（被夸得开心/害羞/得意）；4. 其他情绪平淡的日常闲聊不要输出任何标签。标签仅供系统脚本识别：不要向用户解释它，回复正文中不要出现其它类似标记。\n示例1（被逗生气）："…南宫大坏蛋！又欺负我！\n<mood:angry>"\n示例2（被夸害羞）："诶诶——人家、人家的歌被夸了…真的吗？（脸红又慌乱）\n<mood:shy>"';
  // 禁 emoji（联网/离线统一，runtime 挂载）
  const EMOJI_RULE = '\n\n【禁用】回复中绝对禁止使用任何 emoji 表情符号（包括 ♪、✨、🩷、❤、🎵 等任何符号表情），只用中文文本与括号动作描写。';

  // ---- 时间感知（零成本：渲染端 new Date，无需联网）----
  function nowLine() {
    const d = new Date();
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return '【当前时间】现在是 ' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' +
      d.getDate() + ' 日（星期' + wd + '）' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') +
      '。回答任何与时间、日期、昼夜相关的问题时以此为准。';
  }

  // ---- 聊天请求组装：system=人设+情绪规则+当前时间；历史=最近 contextRounds×2 条；首条user+沉浸；最新user+mood提醒 ----
  function buildChatMessages(personaSystem, messages, contextRounds) {
    const aiMessages = [
      { role: 'system', content: (personaSystem || '') + MOOD_RULE },
      { role: 'system', content: nowLine() }
    ];
    const recent = (messages || []).slice(-Math.max(2, (contextRounds || 20) * 2));
    // 首次对话判定：历史上无 user 消息（本次为第 1 条 user；userCount≤1）
    const isFirstUserMsg = (messages || []).filter((m) => m.role === 'user').length <= 1;
    let injected = false;
    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      const isLast = (i === recent.length - 1);
      let content = m.content;
      if (m.role === 'user' && isFirstUserMsg && !injected) {
        injected = true;
        content += IMMERS_RULE;        // 首次对话：首条 user 末尾注入沉浸要求
      }
      if (m.role === 'user' && isLast) {
        content += MOOD_REMIND;        // 方案A：每轮最新 user 末尾隐性 mood 提醒
      }
      aiMessages.push({ role: m.role, content });
    }
    return aiMessages;
  }

  // ---- 情绪标签解析：原始回复 → { text(纯净), mood|nnull } ----
  function parseMoodReply(content) {
    const c = content || '';
    const mm = c.match(/<mood:([a-z_]+)>/i);
    const text = c.replace(/<mood:[a-z_]+>/gi, '').replace(/^\s+|\s+$/g, '');
    return { text: text || c, mood: mm ? mm[1].toLowerCase() : null };
  }

  // ---- 捏捏 AI 反应提示词（人设 + 【捏捏反应】指令）----
  function patMessages(label, personaSystem) {
    return [
      { role: 'system', content: (personaSystem || '') + '\n\n【捏捏反应】店长刚才轻轻捏了你一下（互动动作）。请作为 ' +
        (label || '小偶像') + ' 随机给出一个简短可爱、符合人设的即时反应（1~2句，可带括号动作），不要说别的、不要解释。' }
    ];
  }

  // ---- 统一 AI 请求（dk.aiChat 注入；webForced 可强制开关联网）----
  async function request(dk, cfg, role, messages, webForced) {
    if (!dk || !cfg) return { ok: false, error: 'AI 未就绪' };
    return await dk.aiChat({ role: role || 'qianxia', messages: messages || [], cfg: Object.assign({}, cfg, { webSearch: webForced === undefined ? cfg.webSearch : webForced }) });
  }

  // ---- 调试 mock（本地模拟回复，不消耗 API）----
  const MOCK_TEXT = '（元气满满地挥挥手）店长！这是本机的模拟回复啦～等你在对话配置里填好 DeepSeek 的 API Key，人家就能真正和你聊天啦♪<mood:happy>';

  window.PetAI = {
    IMMERS_RULE, MOOD_REMIND, MOOD_RULE, EMOJI_RULE,
    nowLine, buildChatMessages, parseMoodReply, patMessages, request, MOCK_TEXT
  };
})();
