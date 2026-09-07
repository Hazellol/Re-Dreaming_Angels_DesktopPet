// 妄想天使桌宠 · 互聊生成引擎（chatter-engine）
// 互聊的"纯生成逻辑"：场景提示词组装（人设+近况记忆+新话题概率）、回复解析、记忆文本。
// DOM/动画（气泡、走位、表情）在 renderer；本层只产出"台词数据"与"记忆文本"—— 可单测。
// 加载顺序：core.js / settings.js / ai-core.js 之后、renderer.js 之前。
/* eslint-disable no-console */
(function () {
  'use strict';
  const CORE = window.PetCore;

  // 60% 开启全新话题（防止话题无限延续），40% 自然延续
  function freshTopicBias() {
    return Math.random() < 0.6;
  }

  // 组装场景 system（roles 参与名单；labelOf 显示名；readHist(role)→JSON 原始文本或 null）
  // 每人：人设前 900 字 + 近况记忆（最近 6 条，禁止提及店长）
  function buildScenePrompt(roles, personas, labelOf, readHist, fresh) {
    const labels = roles.map((r) => labelOf(r));
    let sys = '角色扮演场景引擎：请模仿《绝区零》地下偶像「妄想天使」小偶像们的日常闲聊（排练室/后台/宿舍打闹吐槽）。仅输出对话正文。要求：\n' +
      '1) 每行一条，格式固定为 "说者: 台词"，说者只能是：' + labels.join('、') + '；\n' +
      '2) 每人至少发言一次，总共 3~6 行；\n' +
      '3) 台词严格贴合各自人设的性格与说话方式；情绪强烈/被逗/被夸时，**必须**在台词末尾同一行的最后紧接着写 <mood:X>（X 从 happy sad angry shy think tired proud 中选），**绝对不要单独占一行**；\n' +
      '4) 完全以角色口吻，不要提及店长/用户/现实世界，也不要解释格式。\n' +
      '5) 绝对不要输出 <think> 之类的思考块或任何解释，直接输出"说者: 台词"剧本。\n\n' +
      (fresh
        ? '【本轮要求】这是一个全新的开始：请开启一个与之前话题无关的全新轻松话题，不要延续最近聊过的内容。\n\n'
        : '【本轮要求】可以自然地延续最近聊过的话题，但也别没完没了地复述。\n\n');
    for (const r of roles) {
      const p = personas.roles && personas.roles[r];
      sys += '【' + labelOf(r) + ' 人设】\n' + (p && p.system ? p.system.slice(0, 900) : '') + '\n';
      let hist = [];
      try {
        const raw = readHist && readHist(r);
        if (raw) { const o = JSON.parse(raw); hist = (o && o.messages) || []; }
      } catch (e) { /* noop */ }
      if (hist.length) {
        sys += '【近况记忆（仅供背景，不要提及店长，不要复述）】\n' +
          hist.slice(-6).map((m) => (m.role === 'user' ? '店长说：' : '她说：') + String(m.content).slice(0, 80)).join('\n') + '\n';
      }
      sys += '\n';
    }
    return sys;
  }

  // 解析场景回复 → 台词数组 [{role,text,mood}]；每人至少一句，否则 null；上限 maxLines
  function parseSceneReply(content, roles, maxLines, labelOf) {
    let src = String(content || '');
    src = src.replace(/<think>[\s\S]*?<\/think>/gi, '');   // 双保险：剥离思考块（服务层已剥一次）
    src = src.replace(/<think>[\s\S]*$/gi, '');
    const lines = src.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => CORE.parseChatterLine(l, labelOf)).filter(Boolean);   // labelOf 与 prompt 同显示名（如"南宫羽"）
    const talked = {};
    for (const l of lines) talked[l.role] = true;
    if (!lines.length) return null;                      // 完全没解析出台词才放弃
    return lines.slice(0, maxLines);
  }

  // 记忆文本：按角色汇总 → {role: '【和XX的互聊片段】台词；台词'; …}（标签已剥）
  function memorize(lines, roles, labelOf) {
    const byRole = {};
    for (const l of lines || []) {
      if (!l || !l.text) continue;
      (byRole[l.role] = byRole[l.role] || []).push(l.text);
    }
    const out = {};
    for (const r of Object.keys(byRole)) {
      const others = (roles || []).filter((k) => k !== r).map((k) => labelOf(k));
      const joined = CORE.stripMood(byRole[r].join('；'));
      if (joined) out[r] = '【和' + (others.length ? others.join('、') : '队友') + '的互聊片段】' + joined;
    }
    return out;
  }

  window.PetChatterEngine = { freshTopicBias, buildScenePrompt, parseSceneReply, memorize };
})();
