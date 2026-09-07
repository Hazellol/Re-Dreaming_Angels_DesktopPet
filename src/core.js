// 妄想天使桌宠 · 数据层 + 纯函数层（core）
// 无任何 UI / 状态依赖，可被 node 直接 require 测试（smoke_logic.mjs 即针对这些函数）
// 加载顺序：先于 renderer.js（window.PetCore）——见 index.html
/* eslint-disable no-console */
(function () {
  'use strict';

  // ================= 三小只配置（自项目源码镜像） =================
  const ROLES = {
    airui: {
      key: 'airui', label: '爱芮',
      json: 'airui.json', atlas: 'airui.atlas',
      pages: { 'airui.png': 'airui.png', 'airui_2.png': 'airui_2.png' },
      i18nId: 1, msgCount: 6,
      messageMap: [8, 2, 5, 3, 6, 4],
      posTable: {
        1: { name: '待机', face: '常态' }, 2: { name: '兴奋' }, 3: { name: '害羞' },
        4: { name: '无奈' }, 5: { name: '生气' }, 6: { name: '自信' },
        7: { name: '走路', face: '常态' }, 8: { name: '待机', face: '常态闭眼' }
      },
      mixAnims: ['兴奋', '害羞', '无奈', '生气', '自信'],
      bbox: { minX: -148.9, maxX: 117.3, minY: -16.6, maxY: 377.0 },
      deskX: 0.22
    },
    qianxia: {
      key: 'qianxia', label: '千夏',
      json: 'qianxia.json', atlas: 'qianxia.atlas',
      pages: { 'qianxia.png': 'qianxia.png', 'qianxia_2.png': 'qianxia_2.png' },
      i18nId: 2, msgCount: 7,
      messageMap: [6, 1, 5, 2, 7, 4, 3],
      posTable: {
        1: { name: '哈气' }, 2: { name: '害羞' }, 3: { name: '心累' }, 4: { name: '思考' },
        5: { name: '生气' }, 6: { name: '待机', face: '常态' }, 7: { name: '自信' }, 8: { name: '走路', face: '常态' }
      },
      mixAnims: ['哈气', '害羞', '心累', '思考', '生气', '自信'],
      bbox: { minX: -125.2, maxX: 146.4, minY: -14.3, maxY: 382.3 },
      deskX: 0.78
    },
    nangong: {
      key: 'nangong', label: '南宫',
      json: 'nangong.json', atlas: 'nangong.atlas',
      pages: { 'nangong.png': 'nangong.png', 'nangong_2.png': 'nangong_2.png' },
      i18nId: 3, msgCount: 7,
      messageMap: [1, 7, 5, 3, 6, 4, 2],
      posTable: {
        1: { name: '待机', face: '常态' }, 2: { name: '哭', face: '真哭' }, 3: { name: '害羞' },
        4: { name: '思考' }, 5: { name: '生气' }, 6: { name: '自信' }, 7: { name: '认真' },
        8: { name: '走路', face: '常态' }, 9: { name: '哭', face: '假哭' }
      },
      mixAnims: ['哭', '害羞', '思考', '生气', '自信', '认真'],
      bbox: { minX: -187.8, maxX: 160.8, minY: -17.4, maxY: 418.4 },
      deskX: 0.50
    }
  };
  const ROLE_KEYS = Object.keys(ROLES);

  const CFG = {
    BUBBLE_INTERVAL: 2000,   // showBubble 兜底时长（动画时长优先）
    WALK_TIME: 1.0,
    POSE_HOLD: 3000,
    MSG_HISTORY_WINDOW: 4,
    MIX: 0.3
  };

  // ================= 拖动/甩飞姿态动画（被拎、飞行、反弹阶段各自的专属表情） =================
  // [动作名, 表情名]：南宫"哭"需要指定 真哭/假哭 表情，其余表情名=动作名
  const MOTION_POSES = {
    drag:   { airui: ['兴奋'], qianxia: ['害羞'], nangong: ['哭', '假哭'] },
    fly:    { airui: ['害羞'], qianxia: ['生气'], nangong: ['哭', '真哭'] },
    bounce: { airui: ['无奈'], qianxia: ['心累'], nangong: ['生气'] }
  };

  // ================= 情绪 → 三小只动作表情（聊天回复情绪联动；仅使用已有动画） =================
  const MOOD_POSES = {
    happy: { airui: ['兴奋'], qianxia: ['自信'], nangong: ['自信'] },
    sad:   { airui: ['害羞'], qianxia: ['心累'], nangong: ['哭', '假哭'] },
    angry: { airui: ['生气'], qianxia: ['生气'], nangong: ['生气'] },
    shy:   { airui: ['害羞'], qianxia: ['害羞'], nangong: ['害羞'] },
    think: { airui: ['无奈'], qianxia: ['思考'], nangong: ['思考'] },
    tired: { airui: ['无奈'], qianxia: ['心累'], nangong: ['认真'] },
    proud: { airui: ['自信'], qianxia: ['自信'], nangong: ['自信'] }
  };

  // ================= BGM 显示名映射 =================
  const BGM_NAME_MAP = {
    'bgm_main.mp3': 'MainBGM',
    'bgm_train_1.mp3': '训练中 BGM 1',
    'bgm_train_2.mp3': '训练中 BGM 2',
    'bgm_train_3.mp3': '训练中 BGM 3',
    'bgm_train_4.mp3': '训练中 BGM 4',
    'bgm_mirror_main.mp3': '主页 BGM（镜像）',
    'bgm_mirror_game.mp3': '游戏 BGM（镜像）'
  };

  // ================= 纯函数 =================
  // 显示层兜底：任何文本渲染前剥除情绪标签（防历史/异常文本泄漏 <mood:xx>）
  function stripMood(t) {
    return String(t == null ? '' : t).replace(/<mood:[a-z_]+>/gi, '').replace(/^\s+|\s+$/g, '');
  }

  // 解析互聊台词行："说者: 台词[<mood:X>]" → { role, text, mood } / null
  // labelOf：可选，显示名解析器（与 prompt 用同一套名字）；无则用内置 label+别名表
  const LABEL_ALIASES = { airui: ['爱芮'], qianxia: ['千夏'], nangong: ['南宫', '南宫羽'] };
  function parseChatterLine(line, labelOf) {
    const m = line.match(/^([^:：]+)[:：]\s*([\s\S]+)$/);
    if (!m) return null;
    const name = m[1].trim();
    let role = null;
    if (labelOf) role = ROLE_KEYS.find((k) => labelOf(k) === name);
    if (!role) role = ROLE_KEYS.find((k) => ROLES[k].label === name || (LABEL_ALIASES[k] || []).includes(name));
    if (!role) role = ROLE_KEYS.find((k) => k === name);
    if (!role) return null;
    let text = m[2].trim();
    let mood = null;
    const mm = text.match(/<mood:([a-z_]+)>/i) || text.match(/<\s*([a-z_]{2,12})\s*>/i);
    if (mm) {
      // 容错：模型可能写成 <mood:shy> 或笔误的 <shy>；非 7 态白名单不吞（如 <think/0> 之类）
      let m2 = (mm[1] || '').toLowerCase();
      if (['happy', 'sad', 'angry', 'shy', 'think', 'tired', 'proud'].includes(m2)) {
        mood = m2;
        text = text.replace(/<\s*[a-z_]{2,12}\s*>/gi, '').replace(/<mood:[a-z_]+>/gi, '').trim();
      }
    }
    return { role, text, mood };
  }

  // 播放器时间显示："m:ss"
  function fmtTime(s) {
    if (!isFinite(s) || s <= 0) return '0:00';
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  // 通用数值钳制（配置加载用）
  function clampNum(v, min, max, def) {
    const n = +v;
    return (isFinite(n) ? Math.min(max, Math.max(min, n)) : def);
  }
  function clampBool(v) { return !!v; }

  window.PetCore = {
    ROLES, ROLE_KEYS, CFG, MOTION_POSES, MOOD_POSES, BGM_NAME_MAP,
    stripMood, parseChatterLine, fmtTime, clampNum, clampBool
  };
})();
