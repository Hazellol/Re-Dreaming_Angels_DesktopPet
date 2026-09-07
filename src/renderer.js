// 妄想天使桌宠 · 主装配器（renderer）
// 行为逻辑按模块拆分（自重构后）：
//   src/core.js     —— 数据表+纯函数层（ROLES/姿势表/情绪表/BGM 名/stripMood/parseChatterLine/fmtTime…）
//   src/settings.js —— 配置持久层（QX_* 键：环境变量优先，其次 localStorage；注入式接口）
//   src/renderer.js —— 本文件：Spine 渲染/物理/UI/聊天/互聊/音频 状态机 + 事件接线（装配器）
// 文档：README.md（用户手册）/ PROJECT_MASTER_DOC.md（开发者速查）/ TECH_DETAILS.md（技术手册）
/* eslint-disable no-console */
(async function () {
  'use strict';

  // ================= 模式 =================
  const dk = window.deskpet;
  const DESKTOP = true;   // v2.4：房间版已移除，仅桌面版（透明背景+穿透+置顶）

  // ================= 模块收编（core / settings / ai-core / chatter-engine） =================
  const P = window.PetCore;
  const S = window.PetSettings;
  const AI = window.PetAI;
  const CE = window.PetChatterEngine;
  const { ROLES, ROLE_KEYS, CFG, MOTION_POSES, MOOD_POSES, BGM_NAME_MAP, stripMood, parseChatterLine, fmtTime } = P;

  // ================= Canvas / 视口（仅桌面版：世界=屏幕 css 像素 1:1） =================
  const glCanvas = document.getElementById('gl');
  const dpr = Math.max(1, window.devicePixelRatio || 1);

  let viewW = 0, viewH = 0, dprW = 0, dprH = 0;

  function resize() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    dprW = Math.round(viewW * dpr);
    dprH = Math.round(viewH * dpr);
    glCanvas.width = dprW; glCanvas.height = dprH;
    glCanvas.style.width = viewW + 'px'; glCanvas.style.height = viewH + 'px';
    gfx.setViewport(viewW, viewH, dpr);
  }
  window.addEventListener('resize', resize);

  const mvp = new Float32Array(16);
  function buildMVP(key) {
    const c = idols[key];
    const sv = roleScale(key);
    const cx = c.container.x, cy = c.container.y;
    mvp[0] = 0; mvp[1] = 0; mvp[2] = 0; mvp[3] = 0;
    mvp[4] = 0; mvp[5] = 0; mvp[6] = 0; mvp[7] = 0;
    mvp[8] = 0; mvp[9] = 0; mvp[10] = 1; mvp[11] = 0;
    mvp[12] = 0; mvp[13] = 0; mvp[14] = 0; mvp[15] = 1;
    // 桌面版 MVP（列主序）：镜像/缩放写进矩阵（skeleton.scaleX 不存在于此运行时）
    mvp[0] = 2 / viewW * c.dir * sv;
    mvp[5] = 2 / viewH * sv;
    mvp[12] = 2 * cx / viewW - 1;
    mvp[13] = 2 * cy / viewH - 1;
    return mvp;
  }
  function worldToScreenPx(key, lx, ly) {
    const c = idols[key];
    const sv = roleScale(key);
    return { x: c.container.x + c.dir * lx * sv, y: viewH - (c.container.y + ly * sv) };
  }

  // ================= 背景（桌面版透明；QX_BG=black 调试黑底隔离角色） =================
  const qsEarly = new URLSearchParams(location.search);
  const BLACK_BG = dk.env('QX_BG') === 'black' || qsEarly.get('bg') === 'black';
  if (BLACK_BG) document.body.style.background = '#000';

  // ================= Spine 装载 =================
  const gfx = new SpineGfx.SpineWebGLRenderer(glCanvas);
  gfx.ignoreClip = dk.env('QX_NOCLIP') === '1';
  gfx.noBlend = dk.env('QX_NOALPHA') === '1';

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }
  async function loadIdolAssets(cfg) {
    const atlasText = dk.readText(cfg.atlas);
    const skeletonText = dk.readText(cfg.json);
    const atlas = new spine.TextureAtlas(atlasText);
    for (const page of atlas.pages) {
      const file = cfg.pages[page.name];
      const img = await loadImage(dk.readImage(file));
      const wrap = gfx.makeTexture(img, gfx.textures.length);
      page.setTexture(wrap);
    }
    const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(skeletonText);
    return { data, atlas };
  }

  // ================= 角色实例 =================
  const idols = {};
  for (const key of ROLE_KEYS) {
    idols[key] = {
      cfg: ROLES[key],
      container: { x: 0, y: 0 },   // 桌面站位在 boot 里设置
      dir: 1, posIdx: 0, walking: false, selected: false, poseId: 0,
      skeleton: null, state: null, walkTween: null,
      data: null,
      hidden: false,             // 控制台/托盘开关：隐藏=休息（不渲染/不互动/不走动）
      vel: { x: 0, y: 0 },       // 重力/甩飞速度（世界单位/秒，y 向上）
      physBounced: false,        // 本次甩飞是否已撞墙（撞墙第一下播 pat_xxx/切反弹姿态）
      physWasBusy: false         // 上一次物理活跃状态（停稳瞬间恢复待机用）
    };
  }
  // 重力开关：开启后三小只落地 + 拖动甩飞 + 边框反弹（缓）；默认关
  let gravityOn = false;
  (function loadGravity() {
    try { gravityOn = (dk.env('QX_GRAVITY') === '1') || localStorage.getItem('QX_GRAVITY') === '1'; } catch (e) { gravityOn = dk.env('QX_GRAVITY') === '1'; }
  })();
  function saveGravity() {
    try { localStorage.setItem('QX_GRAVITY', gravityOn ? '1' : '0'); } catch (e) { /* noop */ }
  }
  const GRAV = { g: 1600, rest: 0.62, maxV: 1500 };   // 重力加速度/弹跳衰减/速度上限
  function gravityBounds() {
    return { left: 40, right: viewW - 40, top: viewH - 60, ground: 8 + 14 };  // 桌面：地面/出屏顶
  }
  function stepGravity(key, dt) {
    const c = idols[key];
    if (drag.on && drag.key === key) return;           // 拖动中不施力（跟光标）
    const b = gravityBounds();
    c.vel.y -= GRAV.g * dt;                            // 重力（世界 y 向上）
    c.container.x += c.vel.x * dt;
    c.container.y += c.vel.y * dt;
    // 地面（最低点）
    if (c.container.y < b.ground) {
      c.container.y = b.ground;
      if (c.vel.y < 0) {
        c.vel.y = -c.vel.y * GRAV.rest;                 // 反弹
        if (Math.abs(c.vel.y) < 40) c.vel.y = 0;
        c.vel.x *= 0.82;                                // 触地摩擦
      }
    }
    // 四边反弹（左右墙：本次甩飞的"第一下"播 pat_xxx 音效 + 切反弹姿态，之后不再播）
    if (c.container.x < b.left) {
      c.container.x = b.left;
      if (c.vel.x < 0) {
        c.vel.x = -c.vel.x * GRAV.rest;
        if (!c.physBounced) { c.physBounced = true; playPat(key); playMotion(key, 'bounce'); }
      }
    }
    if (c.container.x > b.right) {
      c.container.x = b.right;
      if (c.vel.x > 0) {
        c.vel.x = -c.vel.x * GRAV.rest;
        if (!c.physBounced) { c.physBounced = true; playPat(key); playMotion(key, 'bounce'); }
      }
    }
    if (c.container.y > b.top) { c.container.y = b.top; if (c.vel.y > 0) c.vel.y = -c.vel.y * GRAV.rest; }
    // 空气阻力（动能逐渐减小）+ 停止阈值
    c.vel.x *= Math.max(0, 1 - 0.4 * dt);
    if (c.container.y <= b.ground + 0.5) {
      if (Math.abs(c.vel.x) < 12) c.vel.x = 0;
      if (Math.abs(c.vel.y) < 12) c.vel.y = 0;
    }
  }
  // 重力模式下"物理活跃"判定：下落/弹跳/甩飞中 → 待机走动让路；落地停稳 → 允许走动
  function idolPhysicallyBusy(key) {
    if (!gravityOn) return false;
    const c = idols[key];
    const b = gravityBounds();
    const onGround = c.container.y <= b.ground + 0.5;
    return !onGround || Math.abs(c.vel.x) > 0.5 || Math.abs(c.vel.y) > 0.5;
  }
  // 缩放表：all=统一值（作用于全部）；单角色 null=跟随 all（支持分别调整）
  let scales = { all: 100, airui: null, qianxia: null, nangong: null };
  function roleScale(key) {
    return (scales[key] != null ? scales[key] : scales.all) / 100;
  }
  function setScaleAll(v) {
    scales.all = v;
    for (const key of ROLE_KEYS) scales[key] = null;   // 统一值：清掉单独值
    S.saveScales(scales);
  }
  function setScaleOne(key, v) {
    scales[key] = v;
    S.saveScales(scales);
  }
  let idolLocked = false;

  function setComboSkin(key, dir) {
    const c = idols[key];
    const combo = new spine.Skin('combo');
    combo.addSkin(c.data.defaultSkin);
    combo.addSkin(c.data.findSkin(dir === 1 ? '朝右' : '朝左'));
    c.skeleton.setSkin(combo);
    c.skeleton.setSlotsToSetupPose();
  }
  function initIdol(key, data) {
    const c = idols[key], cfg = c.cfg;
    const skeleton = new spine.Skeleton(data);
    const stateData = new spine.AnimationStateData(data);
    for (const m of cfg.mixAnims) {
      stateData.setMix('动作_待机', '动作_' + m, CFG.MIX);
      stateData.setMix('动作_' + m, '动作_待机', CFG.MIX);
    }
    const state = new spine.AnimationState(stateData);
    c.data = data;
    c.skeleton = skeleton;
    c.state = state;
    setComboSkin(key, 1);
    state.setAnimation(0, '动作_待机', true);
    state.setAnimation(1, '表情_常态', true);
  }

  // —— 姿势 ——
  const clearFaceTimers = {};
  function changeFace(key, poseId) {
    const c = idols[key], cfg = c.cfg;
    if (c.poseId !== 0) return false;
    if (c.walking) return false;
    const s = cfg.posTable[poseId];
    if (!s) return false;
    c.state.setAnimation(0, '动作_' + s.name, true);
    c.state.setAnimation(1, '表情_' + (s.face || s.name), true);
    c.poseId = poseId;
    if (clearFaceTimers[key]) clearTimeout(clearFaceTimers[key]);
    clearFaceTimers[key] = setTimeout(() => clearIdolFace(key), CFG.POSE_HOLD);
    return true;
  }
  function clearIdolFace(key) {
    const c = idols[key];
    if (clearFaceTimers[key]) { clearTimeout(clearFaceTimers[key]); clearFaceTimers[key] = null; }
    c.state.setAnimation(0, '动作_待机', true);
    c.state.setAnimation(1, '表情_常态', true);
    c.poseId = 0;
  }

  // —— 走动 ——
  function moveIdol() {
    if (dialog.open) return;
    if (drag.on) return;              // 拖动中不触发走动（防位置打架）
    if (chatter.active) return;       // 三小只互聊中：不自动踱步
    // 重力模式：物理活跃（下落/弹跳/甩飞）的角色退出候选；落地停稳的照常走动
    const cand = ROLE_KEYS.filter((k) => {
      const c = idols[k];
      return !c.hidden && !c.walking && !c.selected && c.poseId === 0 && !idolPhysicallyBusy(k) && !isChatFrozen(k);
    });
    if (!cand.length) return;
    const key = cand[Math.floor(Math.random() * cand.length)];
    const c = idols[key], cfg = c.cfg;
    const r = c.posIdx === 0 ? 1 : 0;
    c.posIdx = r;
    const target = cfg.waypoints[r];
    c.walking = true;
    const A = { x: c.container.x, y: c.container.y };
    let B = gravityOn ? { x: target.x, y: A.y } : { x: target.x, y: target.y };
    // 竖直移动模式（非重力）：目标高度随机——上下/斜向走动；仅 ~20% 概率发生（不频繁），
    // y 位移量随机 → 每次角度不同；其余 80% 维持纯水平走动
    if (!gravityOn && freq.moveY && Math.random() < 0.2) {
      let ny = A.y + (Math.random() < 0.5 ? -1 : 1) * (80 + Math.random() * 220);   // 随机上下 80~300px
      ny = Math.max(70, Math.min(viewH - 40, ny));
      B = { x: target.x, y: ny };
    }
    // 动画朝向 = 实际移动方向（修复"倒着走"：甩飞后角色可能落在路点外侧/错位，
    // 路点 dir 与移动方向相反时动画就反了——以 B 相对 A 的方向为准）
    const moveDir = Math.abs(B.x - A.x) < 1e-6 ? target.dir : (B.x > A.x ? 1 : -1);
    onWalkStart(key, moveDir);
    c.walkTween = {
      start: performance.now(),
      dur: Math.max(700, CFG.WALK_TIME * 1000 + Math.abs(B.y - A.y) * 2.2),
      update: (k) => {
        c.container.x = A.x + (B.x - A.x) * k;
        c.container.y = A.y + (B.y - A.y) * k;
      },
      done: () => { c.walking = false; c.walkTween = null; resetWalkIdol(key); }
    };
  }
  function onWalkStart(key, dir) {
    const c = idols[key];
    c.dir = dir;
    setComboSkin(key, dir);
    c.state.setAnimation(0, '动作_走路', true);
    c.state.setAnimation(1, '表情_常态', true);
  }
  function resetWalkIdol(key) { clearIdolFace(key); }

  // —— 台词与气泡 ——
  let i18n = {};
  function dkReadI18n(keyMsg) { return i18n[keyMsg] || keyMsg; }
  const history = [];
  const popover = document.getElementById('popover');
  let bubbleLock = false;
  let bubbleRole = 'qianxia';

  function animDurMs(key, poseName) {
    const c = idols[key];
    if (c.data) {
      const anim = c.data.findAnimation('动作_' + poseName);
      if (anim && anim.duration > 0) return Math.round(anim.duration * 1000);
    }
    return CFG.BUBBLE_INTERVAL;
  }
  function poseIdFromName(key, name) {
    const cfg = ROLES[key];
    for (const [id, p] of Object.entries(cfg.posTable)) {
      if (p.name === name) return +id;
    }
    return 1;
  }
  function pickTrainLine(key) {
    const d = dialogData.roles[key];
    if (!d) return null;
    const pool = d.chapters.flatMap((c) => c.lines)
      .filter((l) => l.chara === key[0] && l.pose && l.text.length > 3);
    if (!pool.length) return null;
    const cand = pool.filter((l) => !history.includes('t:' + key + l.text));
    if (!cand.length) return null;
    const line = cand[Math.floor(Math.random() * cand.length)];
    history.push('t:' + key + line.text);
    while (history.length > CFG.MSG_HISTORY_WINDOW) history.shift();
    return { text: line.text, pose: line.pose };
  }
  let bubbleHideTimer = null;   // 气泡隐藏定时器（showBubble/showBubbleTyping 共用句柄，可取消）
  let bubbleIsChat = false;     // true=当前气泡是"聊天回复气泡"（拖动角色时保持显示，不消失）
  function showBubble(msgText, holdMs, role) {
    if (bubbleLock) return false;
    bubbleLock = true;
    bubbleIsChat = false;   // 普通互动/待机气泡
    if (role) bubbleRole = role;
    popover.textContent = msgText;
    popover.classList.add('show');
    bubbleHideTimer = setTimeout(() => {
      popover.classList.remove('show');
      bubbleLock = false;
    }, holdMs || CFG.BUBBLE_INTERVAL);
    return true;
  }
  // 聊天气泡定位：防出屏，优先级 上(头顶) → 右(角色右侧) → 左(角色左侧)，全不行则 clamp 回屏内
  function placePopover() {
    if (!popover.classList.contains('show')) return;
    const cfg = ROLES[bubbleRole];
    const pad = 8;
    const w = popover.offsetWidth || 140, h = popover.offsetHeight || 46;
    const fitsX = (x, w) => (x - w / 2 >= pad && x + w / 2 <= viewW - pad);
    // 候选挂点（屏幕坐标）；roleScale 影响 bbox 尺寸，直接用屏幕投影
    const head = worldToScreenPx(bubbleRole, (cfg.bbox.minX + cfg.bbox.maxX) / 2, cfg.bbox.maxY + 8); // 头顶（底边中点）
    const my = worldToScreenPx(bubbleRole, 0, (cfg.bbox.minY + cfg.bbox.maxY) / 2);                   // 角色中部（垂直锚）
    const right = worldToScreenPx(bubbleRole, cfg.bbox.maxX, 0).x + 6;                               // 右侧（气泡左边缘）
    const left = worldToScreenPx(bubbleRole, cfg.bbox.minX, 0).x - 6;                                // 左侧（气泡右边缘）
    // 垂直锚点：角色中部优先；角色贴屏幕上/下边时 clamp 回屏内（横向已分离 → 不挡角色）
    const cyClamp = (y) => Math.max(pad + h / 2, Math.min(viewH - pad - h / 2, y));
    const cy = cyClamp(my.y);
    // 横向可用性：pos-right 占用 [left, left+w]；pos-left 占用 [left-w, left]
    const rightOk = (right >= pad && right + w <= viewW - pad);
    const leftOk = (left - w >= pad && left <= viewW - pad);
    let mode = 'top', L = head.x, T = head.y;
    if (fitsX(head.x, w) && head.y - h >= pad) { /* 上：默认，成功 */ }
    else if (rightOk) { mode = 'right'; L = right; T = cy; }
    else if (leftOk) { mode = 'left'; L = left; T = cy; }
    else { // 兜底 clamp（尽量放中间；防御：横向总有空间，通常不会走到这）
      L = Math.max(pad, Math.min(viewW - pad - w, head.x));
      T = Math.max(pad + h, Math.min(viewH - pad, head.y));
      mode = 'top';
    }
    popover.classList.toggle('pos-right', mode === 'right');
    popover.classList.toggle('pos-left', mode === 'left');
    popover.style.left = L + 'px';
    popover.style.top = T + 'px';
  }
  function pickMessage(kind, roleId) {
    const cfg = Object.values(ROLES).find((r) => r.i18nId === roleId);
    const cand = [];
    for (let v = 1; v <= cfg.msgCount; v++) {
      const key = kind + '_' + roleId + '_' + v;
      if (!history.includes(key)) cand.push(key);
    }
    if (!cand.length) return null;
    const key = cand[Math.floor(Math.random() * cand.length)];
    history.push(key);
    while (history.length > CFG.MSG_HISTORY_WINDOW) history.shift();
    return key;
  }

  // 气泡调度（随机空闲角色；~25% 走剧本台词池（已标注角色））
  function tryBubble() {
    if (dialog.open) return;
    if (chatter.active) return;       // 三小只互聊中：不自动冒泡
    const cand = ROLE_KEYS.filter((k) => {
      const c = idols[k];
      return !c.hidden && !c.walking && !c.selected && c.poseId === 0 && !isChatFrozen(k);
    });
    if (!cand.length) return;
    const key = cand[Math.floor(Math.random() * cand.length)];
    const cfg = ROLES[key];
    if (dialogData && dialogData.roles[key] && Math.random() < 0.25) {
      const line = pickTrainLine(key);
      if (line) {
        changeFace(key, poseIdFromName(key, line.pose));
        showBubble(line.text, animDurMs(key, line.pose), key);
        return;
      }
    }
    const msg = pickMessage('standby', cfg.i18nId);
    if (!msg) return;
    const seq = parseInt(msg.split('_')[2], 10);
    const poseId = cfg.messageMap[seq - 1];
    changeFace(key, poseId);
    showBubble(dkReadI18n(msg), animDurMs(key, cfg.posTable[poseId].name), key);
  }

  // —— 互动 ——
  function interact(key) {
    if (dialog.open) return;
    if (bubbleLock && bubbleRole === key) return;
    const cfg = ROLES[key];
    const msg = pickMessage('interact', cfg.i18nId);
    if (!msg) return;
    const seq = parseInt(msg.split('_')[2], 10);
    const poseId = cfg.messageMap[seq - 1];
    changeFace(key, poseId);
    playPat(key);                       // 捏捏音效（两人随机一）
    scheduleBubbleTimer();
    // 捏捏 AI 反应（30%）：已配 Key 且连接记录为连通时，随机改为 AI 即时反应
    if (aiCfg.apiKey && aiCfg.connected && Math.random() < 0.3) {
      showBubbleThinking(key);          // "…" 占位，AI 返回后无缝接管
      aiPatReact(key);
    } else {
      showBubble(dkReadI18n(msg), animDurMs(key, cfg.posTable[poseId].name), key);
    }
  }
  // 捏捏 AI 反应（ai-core.js：人设 + 【捏捏反应】指令）
  async function aiPatReact(key) {
    const sys = (personas.roles[key] && personas.roles[key].system) || '';
    const aiMessages = AI.patMessages(personaLabel(key), sys);
    try {
      const res = await AI.request(dk, aiCfg, key, aiMessages);
      if (res && res.ok && res.content) {
        const pr = AI.parseMoodReply(res.content);
        if (pr.mood) applyMoodPose(key, pr.mood);
        showBubbleTyping(pr.text, 3200, key);   // 接管头顶气泡（打字机）
        aiCfg.connected = true;
        saveAICfg();
      } else {
        // 失败：回退固定台词
        const msg = pickMessage('interact', ROLES[key].i18nId);
        if (msg) {
          const seq2 = parseInt(msg.split('_')[2], 10);
          const poseId2 = ROLES[key].messageMap[seq2 - 1];
          showBubble(dkReadI18n(msg), animDurMs(key, ROLES[key].posTable[poseId2].name), key);
        }
      }
    } catch (e) { /* noop */ }
  }

  // ================= 特训故事（galgame 回放，按角色） =================
  let dialogData = { roles: {} };
  const dialog = { open: false, role: 'qianxia', chapter: null, idx: 0 };
  const dEl = document.getElementById('dialog');
  const dName = document.getElementById('d-name');
  const dScene = document.getElementById('d-scene');
  const dText = document.getElementById('d-text');

  function openTrainDialog(key) {
    const d = dialogData.roles[key];
    if (!d || !d.chapters.length || dialog.open) return;
    dialog.role = key;
    dialog.open = true;
    popover.classList.remove('show');
    clearIdolFace(key);
    const ci = Math.floor(Math.random() * d.chapters.length);
    dialog.chapter = d.chapters[ci];
    dialog.idx = 0;
    showDialogLine();
    const ids = Object.keys(ROLES[key].posTable);
    changeFace(key, +ids[Math.floor(Math.random() * ids.length)] || 1);
  }
  function showDialogLine() {
    const line = dialog.chapter.lines[dialog.idx];
    dName.textContent = line.name || '？？？';
    dScene.textContent = `${dialog.chapter.title} (${dialog.idx + 1}/${dialog.chapter.lines.length})`;
    dText.textContent = line.text;
    dEl.classList.add('show');
  }
  function nextDialogLine() {
    if (!dialog.open) return;
    dialog.idx++;
    if (dialog.idx >= dialog.chapter.lines.length) {
      const d = dialogData.roles[dialog.role];
      const ci = d.chapters.indexOf(dialog.chapter);
      dialog.chapter = d.chapters[(ci + 1) % d.chapters.length];
      dialog.idx = 0;
    }
    showDialogLine();
  }
  function closeDialog() {
    dialog.open = false;
    dEl.classList.remove('show');
    clearIdolFace(dialog.role);
  }
  dEl.addEventListener('click', (e) => {
    if (e.target.id === 'd-close') { closeDialog(); return; }
    if (e.target.id === 'd-skip') {
      const d = dialogData.roles[dialog.role];
      const ci = d.chapters.indexOf(dialog.chapter);
      dialog.chapter = d.chapters[(ci + 1) % d.chapters.length];
      dialog.idx = 0;
      showDialogLine();
      return;
    }
    nextDialogLine();
  });

  // ================= 频率设置（待机对话 3 模式 + 走动间隔 + 竖直移动）—— 持久层见 settings.js =================
  const FREQ_MIN = S.FREQ_MIN, FREQ_MAX = S.FREQ_MAX;
  const freq = Object.assign({}, S.FREQ_DEFAULTS);
  function loadFreq() { S.loadFreq(freq); }
  function clampFreq() { S.clampFreq(freq); }
  function saveFreq() { S.saveFreq(freq); }
  function currentBubbleDelay() {
    if (freq.dialogMode === 'off') return null;
    if (freq.dialogMode === 'fix') return freq.fixSec * 1000;
    const t = freq.randMin + Math.random() * (freq.randMax - freq.randMin);
    return t * 1000;
  }

  // ================= 定时器（递归调度） =================
  let moveTimer = null, bubbleTimer = null;
  function scheduleMove() {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { moveIdol(); scheduleMove(); }, freq.moveSec * 1000);
  }
  function scheduleBubbleTimer() {
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = null;
    const delay = currentBubbleDelay();
    if (delay === null) return;
    bubbleTimer = setTimeout(() => { tryBubble(); scheduleBubbleTimer(); }, delay);
  }

  // ================= 角色可见性（控制台/托盘开关：隐藏=休息，不渲染/不互动/不走动） =================
  // 重置为该角色的干净待机状态（隐藏=收起、显示=醒来；防止隐藏时残留的姿势/走路/气泡状态泄露）
  function resetIdolIdleState(key) {
    const c = idols[key];
    if (!c) return;
    if (c.walkTween) { c.walkTween = null; c.walking = false; }
    if (clearFaceTimers[key]) { clearTimeout(clearFaceTimers[key]); clearFaceTimers[key] = null; }
    if (bubbleLock && bubbleRole === key) {
      bubbleLock = false;
      popover.classList.remove('show');
    }
    c.poseId = 0;
    c.state.setAnimation(0, '动作_待机', true);
    c.state.setAnimation(1, '表情_常态', true);
  }
  function setIdolVisibility(key, on) {
    const c = idols[key];
    if (!c) return;
    c.hidden = !on;
    // 显隐都重置为干净待机：隐藏=收起；显示=醒来（从头待机）——
    // 修复"隐藏时正播姿势动画→显示后 poseId 未清，changeFace/moveIdol/tryBubble 全部被
    // poseId!==0 拦死，角色永久卡在该姿势、不再触发任何待机动画"
    resetIdolIdleState(key);
    // 全部隐藏：顺手收起浮动 UI（避免"空窗口里飘着菜单/面板/对话框"）
    if (ROLE_KEYS.every((k) => idols[k].hidden)) {
      hideCtxMenu(); hideSizePanel(); hideFreqPanel(); hideVolPanel(); hideMusicPanel();
      if (dialog.open) closeDialog();
      if (chat.open) closeChatPanel();
    }
    // 显隐后立即刷新穿透判定（不依赖下一次 mousemove——修复"恢复后点击/拖动失效"：
    // 隐藏期间无 mousemove 时 mouseOverUi/穿透状态会与真实角色可见性脱节）
    refreshMouseIgnore();
  }
  dk.onVisibility(setIdolVisibility);   // 顶层注册：接住 did-finish-load 的初始状态同步

  // ================= 拖动/甩飞姿态动画（被拎、飞行、反弹阶段各自的专属表情） =================
  // [动作名, 表情名]：南宫"哭"需要指定 真哭/假哭 表情，其余表情名=动作名（表定义移入 core.js）
  function playMotion(key, phase) {
    const p = MOTION_POSES[phase] && MOTION_POSES[phase][key];
    if (!p) return;
    const c = idols[key];
    c.state.setAnimation(0, '动作_' + p[0], true);
    c.state.setAnimation(1, '表情_' + (p[1] || p[0]), true);
  }

  // ================= 命中 / 拖动 =================
  function idolScreenRect(key) {
    const cfg = ROLES[key];
    const p1 = worldToScreenPx(key, cfg.bbox.minX, cfg.bbox.minY);
    const p2 = worldToScreenPx(key, cfg.bbox.maxX, cfg.bbox.maxY);
    const pad = 6;
    return { x: Math.min(p1.x, p2.x) - pad, y: Math.min(p1.y, p2.y) - pad,
             w: Math.abs(p2.x - p1.x) + pad * 2, h: Math.abs(p2.y - p1.y) + pad * 2 };
  }
  function hitIdol(x, y) {
    for (const key of ROLE_KEYS) {
      if (idols[key].hidden) continue;   // 隐藏（休息）的角色不参与命中
      const r = idolScreenRect(key);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return key;
    }
    return null;
  }
  const drag = { on: false, moved: false, key: null, sx: 0, sy: 0, ox: 0, oy: 0, vx: 0, vy: 0, lt: 0, lx: 0, ly: 0 };
  // 单击/双击识别：240ms 内同角色再次按下 = 双击 → 打开聊天（单击互动由 mouseup 延迟触发）
  let clickTimer = null, clickKey = null;
  glCanvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (dialog.open) return;
    const key = hitIdol(e.clientX, e.clientY);
    if (!key) return;
    stopChatter();   // 用户碰角色：中止互聊
    // 双击聊天（第二次按下，与上一次单击间隔 <240ms 且同角色）
    if (clickTimer && clickKey === key) {
      clearTimeout(clickTimer); clickTimer = null; clickKey = null;
      openChatPanel(key);
      return;
    }
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickKey = null; }   // 打断旧的单击序列
    if (idolLocked) { interact(key); return; }
    drag.on = true; drag.moved = false; drag.key = key;
    drag.sx = e.clientX; drag.sy = e.clientY;
    drag.vx = 0; drag.vy = 0; drag.lt = performance.now();
    drag.lx = e.clientX; drag.ly = e.clientY;
    const c = idols[key];
    drag.ox = c.container.x; drag.oy = c.container.y;
    if (c.walking) { c.walkTween = null; c.walking = false; clearIdolFace(key); }
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag.on) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) {
      drag.moved = true;
      if (!bubbleIsChat) popover.classList.remove('show');   // 拖动时普通气泡隐藏；聊天回复气泡保留并跟随
      playMotion(drag.key, 'drag');   // 被拎起来：换上拖拽姿势（保持到放开）
    }
    // 拖动速度采样（甩飞初速度用；间隔过久视为静止）
    const now = performance.now();
    const dts = (now - drag.lt) / 1000;
    if (dts > 0.001 && dts < 0.12) {
      drag.vx = (e.clientX - drag.lx) / dts;
      drag.vy = (e.clientY - drag.ly) / dts;
    } else if (dts >= 0.12) {
      drag.vx = 0; drag.vy = 0;
    }
    drag.lt = now; drag.lx = e.clientX; drag.ly = e.clientY;
    if (!drag.moved) return;
    const c = idols[drag.key];
    // ⚠️ 桌面版世界坐标 = 屏幕 css 像素（1:1）：容器移动 = 鼠标位移，与角色缩放无关！
    // （曾误除以 scale，导致大角色拖得慢、小角色拖得快、偏移光标）
    const sv = roleScale(drag.key);
    let wx, wy;
    wx = drag.ox + dx;
    wy = drag.oy - dy;
    wy = Math.max(40, Math.min(viewH - 20 - 300 * sv, wy));
    wx = Math.max(40 * sv, Math.min(viewW - 30 * sv, wx));
    c.container.x = wx;
    c.container.y = wy;
  });
  window.addEventListener('mouseup', () => {
    if (!drag.on) return;
    drag.on = false;
    const key = drag.key;
    drag.key = null;
    if (!drag.moved) {
      // 单击互动防抖（240ms 内无第二次按下才触发；双击则由 mousedown 识别为聊天）
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickKey = null; return; }
      clickKey = key;
      clickTimer = setTimeout(() => { const k = clickKey; clickTimer = null; clickKey = null; interact(k); }, 240);
      return;
    }
    // 甩飞：重力模式下把拖动末速度赋给角色（带惯性，撞边框反弹）
    if (gravityOn) {
      const c = idols[key];
      const cl = (v) => Math.max(-GRAV.maxV, Math.min(GRAV.maxV, v));
      c.vel.x = cl(drag.vx * 0.9);
      c.vel.y = cl(-drag.vy * 0.9);   // 屏幕 y 向下 → 世界 y 向上取反
      if (Math.abs(c.vel.x) < 60 && Math.abs(c.vel.y) < 60) { c.vel.x = 0; c.vel.y = 0; }
      playMotion(key, 'fly');         // 飞行姿态（撞墙第一下会切反弹姿态）
      c.physBounced = false;          // 重置撞墙第一下标志
      return;
    }
    // 拖动结束：回待机 + 踱步区跟随当前位置（桌面版）
    clearIdolFace(key);
    const c = idols[key];
    const cx = c.container.x, cy = c.container.y;
    c.cfg.waypoints = [
      { x: Math.max(60, cx - 110), y: cy, dir: -1 },
      { x: Math.min(viewW - 60, cx + 150), y: cy, dir: 1 }
    ];
  });

  // ================= 音频系统（规范化命名的音效 + BGM 播放器） =================
  const AUDIO_FILES = {
    pat: {
      airui: ['audio/pat_airui_1.wav', 'audio/pat_airui_2.wav'],
      qianxia: ['audio/pat_qianxia_1.wav', 'audio/pat_qianxia_2.wav'],
      nangong: ['audio/pat_nangong_1.wav', 'audio/pat_nangong_2.wav']
    },
    uiOpen: 'audio/ui_menu_open.mp3',
    uiHover: 'audio/ui_menu_hover.mp3',
    uiSelect: 'audio/ui_menu_select.mp3',
    boot: 'audio/sfx_boot.mp3'
  };
  // BGM 列表：动态扫描 assets/bgm/（用户放入音频文件即自动收录，重启后出现在列表）
  // 顺序：原版 bgm_* 曲目保持固定顺序在前（用户记忆索引不漂移），新增曲目按名排在后面（显示名表见 core.js）
  function bgmDisplayName(f) {
    const base = f.replace(/^bgm\//, '');
    if (BGM_NAME_MAP[base]) return BGM_NAME_MAP[base];
    return base.replace(/\.[^.]+$/, '');
  }
  const BGM_FILES = (() => {
    try {
      const l = dk.listAudio();
      l.sort((a, b) => {
        const ka = a.startsWith('bgm/') ? 0 : 1, kb = b.startsWith('bgm/') ? 0 : 1;
        if (ka !== kb) return ka - kb;
        return a.localeCompare(b, 'zh-CN');
      });
      if (l.length) return l;
    } catch (e) { /* noop */ }
    return ['audio/bgm_main.mp3'];   // 兜底
  })();
  const BGM_NAMES = BGM_FILES.map(bgmDisplayName);
  const audioCfg = { master: 70, muted: false, sfxVol: 100, bgmVol: 60, bgmIdx: 0, bgmOn: false, playMode: 'order' };
  function loadAudioCfg() { S.loadAudioCfg(audioCfg, BGM_FILES.length); }
  function saveAudioCfg() { S.saveAudioCfg(audioCfg); }
  // 三路音量：总音量(基准) × 各自比例；静音=全部归零
  function sfxEffVolume() { return audioCfg.muted ? 0 : (audioCfg.master / 100) * (audioCfg.sfxVol / 100); }
  function bgmEffVolume() { return audioCfg.muted ? 0 : (audioCfg.master / 100) * (audioCfg.bgmVol / 100); }
  function playSfxFile(file) {
    try {
      const a = new Audio(dk.readAudio(file));
      a.volume = sfxEffVolume();
      a.play().catch(() => { /* autoplay 被拒时静默 */ });
    } catch (e) { /* noop */ }
  }
  function playPat(key) {
    const files = AUDIO_FILES.pat[key];
    if (!files) return;
    playSfxFile(files[Math.floor(Math.random() * files.length)]);
  }
  let bgmAudio = null;
  function applyBgmVolume() {
    if (bgmAudio) bgmAudio.volume = Math.min(1, bgmEffVolume());
  }
  function startBgm() {
    stopBgm();
    bgmAudio = new Audio(dk.readAudio(BGM_FILES[audioCfg.bgmIdx]));
    bgmAudio.loop = (audioCfg.playMode === 'loop');
    applyBgmVolume();
    bgmAudio.play().catch(() => { audioCfg.bgmOn = false; });
    // 进度/时长事件（播放器 UI 使用）
    bgmAudio.addEventListener('loadedmetadata', () => {
      if (onBgmMeta) onBgmMeta(bgmAudio.duration || 0);
    });
    bgmAudio.addEventListener('timeupdate', () => {
      if (onBgmTime) onBgmTime((bgmAudio.currentTime || 0), (bgmAudio.duration || 0));
    });
    bgmAudio.addEventListener('ended', () => {
      // 单曲循环由 loop 处理；顺序模式自动下一首（列表循环）
      if (audioCfg.playMode === 'order') {
        setBgm(audioCfg.bgmIdx + 1, true);
        if (onBgmMeta) onBgmMeta(0);
      }
    });
  }
  function stopBgm() {
    if (bgmAudio) { bgmAudio.pause(); bgmAudio = null; }
    if (onBgmTime) onBgmTime(0, 0);
  }
  function setBgm(i, keepPlaying) {
    audioCfg.bgmIdx = (i + BGM_FILES.length) % BGM_FILES.length;
    if (keepPlaying && audioCfg.bgmOn) startBgm();
    saveAudioCfg();
  }
  function toggleBgm() {
    audioCfg.bgmOn = !audioCfg.bgmOn;
    if (audioCfg.bgmOn) {
      // 恢复播放：暂停过（对象还在）→ 从当前位置继续；否则新建从头播
      if (bgmAudio) bgmAudio.play().catch(() => { audioCfg.bgmOn = false; saveAudioCfg(); });
      else startBgm();
    } else {
      // 暂停：保留 Audio 对象与进度（修复"暂停后进度归零、再播重头开始"）
      if (bgmAudio) bgmAudio.pause();
    }
    saveAudioCfg();
    return audioCfg.bgmOn;
  }
  let onBgmMeta = null, onBgmTime = null;   // 播放器 UI 回调
  loadAudioCfg();

  // ================= UI 通用：光标旁定位 + 拖动 =================
  let lastCtx = { x: 300, y: 300 };
  // 浮动 UI 层级：点击聚焦哪个面板/菜单/对话框，哪个就到最前（z-index 递增，
  // 防止"想调整的设置窗口被别的面板挡住"）
  let frontZ = 60;
  function bringToFront(elm) {
    frontZ += 1;
    elm.style.zIndex = String(frontZ);
  }
  function openPanelAt(elm, x, y) {
    bringToFront(elm);   // 打开即置顶
    elm.style.display = 'block';
    elm.style.left = '0px'; elm.style.top = '0px';
    elm.style.right = 'auto'; elm.style.bottom = 'auto';
    const w = elm.offsetWidth, h = elm.offsetHeight, pad = 12;
    // 面板共存：目标位置若已被其他打开的面板占据，向右下错开（避免完全重叠遮挡）
    let shift = 0;
    for (const el of [sizePanel, freqPanel, volPanel, musicPanel, ctxMenu]) {
      if (!el || el === elm || el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.right > x && r.left < x + w + 20 && r.bottom > y && r.top < y + h + 20) {
        shift += 34;
      }
    }
    x += shift; y += shift;
    let L = x + pad, T = y + pad;
    if (L + w > viewW - 8) L = x - w - pad;
    if (T + h > viewH - 8) T = y - h - pad;
    elm.style.left = Math.max(8, L) + 'px';
    elm.style.top = Math.max(8, T) + 'px';
  }
  function makeDraggable(elm, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = elm.getBoundingClientRect();
      const ox = r.left - e.clientX, oy = r.top - e.clientY;
      const mv = (ev) => {
        elm.style.left = (ev.clientX + ox) + 'px';
        elm.style.top = (ev.clientY + oy) + 'px';
        elm.style.right = 'auto'; elm.style.bottom = 'auto';
      };
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });
  }

  // ================= 大小面板（target：'all' 统一调整 / 具体角色 key 单独调整） =================
  const sizePanel = document.getElementById('size-panel');
  const spRange = document.getElementById('sp-range');
  const spVal = document.getElementById('sp-val');
  const spTitle = document.getElementById('sp-title');
  let sizeTarget = 'all';
  function currentTargetScale() {
    return sizeTarget === 'all' ? scales.all : (scales[sizeTarget] != null ? scales[sizeTarget] : scales.all);
  }
  function showSizePanel(target) {
    hideCtxMenu();   // 只收起瞬态右键菜单；面板之间可同时存在（音乐播放器不关闭）
    sizeTarget = (target === 'all' || target == null) ? 'all' : (ROLES[target] ? target : 'all');
    spTitle.textContent = sizeTarget === 'all' ? '🎀 调整三小只大小' : '🎀 调整' + ROLES[sizeTarget].label + '大小';
    const v = Math.round(currentTargetScale());
    spRange.value = v;
    spVal.textContent = v + '%';
    openPanelAt(sizePanel, lastCtx.x, lastCtx.y);
  }
  function hideSizePanel() { sizePanel.style.display = 'none'; }
  spRange.addEventListener('input', () => {
    const v = Math.min(200, Math.max(50, parseInt(spRange.value, 10) || 100));
    if (sizeTarget === 'all') setScaleAll(v);
    else setScaleOne(sizeTarget, v);
    spVal.textContent = v + '%';
  });
  document.getElementById('sp-close').addEventListener('click', hideSizePanel);
  makeDraggable(sizePanel, sizePanel.querySelector('.sp-head'));
  try { idolLocked = localStorage.getItem('QX_LOCK') === '1'; } catch (e) { /* noop */ }

  // ================= 频率面板 =================
  const freqPanel = document.getElementById('freq-panel');
  const fpFix = document.getElementById('fp-fix');
  const fpRandMin = document.getElementById('fp-rand-min');
  const fpRandMax = document.getElementById('fp-rand-max');
  const fpMove = document.getElementById('fp-move');
  const fpMoveY = document.getElementById('fp-movey');
  const fpModeRadios = Array.from(document.querySelectorAll('input[name="fp-mode"]'));
  const fpFixRow = document.getElementById('fp-fix-row');
  const fpRandMinRow = document.getElementById('fp-rand-min-row');
  const fpRandMaxRow = document.getElementById('fp-rand-max-row');
  loadFreq();
  function applyFreq() {
    for (const r of fpModeRadios) r.checked = (r.value === freq.dialogMode);
    fpFix.value = freq.fixSec;
    fpRandMin.value = freq.randMin;
    fpRandMax.value = freq.randMax;
    fpMove.value = freq.moveSec;
    fpMoveY.checked = !!freq.moveY;
    refreshFreqRows();
  }
  function refreshFreqRows() {
    fpFixRow.classList.toggle('disabled', freq.dialogMode !== 'fix');
    fpRandMinRow.classList.toggle('disabled', freq.dialogMode !== 'rand');
    fpRandMaxRow.classList.toggle('disabled', freq.dialogMode !== 'rand');
  }
  function onFreqChanged(schedule) {
    saveFreq();
    refreshFreqRows();
    if (schedule !== false) scheduleBubbleTimer();
  }
  function showFreqPanel(x, y) {
    hideCtxMenu();   // 面板之间可同时存在
    applyFreq();
    openPanelAt(freqPanel, x === undefined ? lastCtx.x : x, y === undefined ? lastCtx.y : y);
  }
  function hideFreqPanel() { freqPanel.style.display = 'none'; }
  for (const r of fpModeRadios) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      freq.dialogMode = r.value;
      onFreqChanged();
    });
  }
  const commitNum = (el, key, isRand) => {
    const v = parseFloat(el.value);
    if (isFinite(v)) freq[key] = v;
    clampFreq();
    el.value = freq[key];
    if (isRand) { fpRandMin.value = freq.randMin; fpRandMax.value = freq.randMax; }
    onFreqChanged(isRand);
    if (key === 'moveSec') scheduleMove();
  };
  const bindNum = (el, key, isRand) => {
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (isFinite(v)) freq[key] = v;
    });
    el.addEventListener('change', () => commitNum(el, key, isRand));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  };
  bindNum(fpFix, 'fixSec', false);
  bindNum(fpRandMin, 'randMin', true);
  bindNum(fpRandMax, 'randMax', true);
  bindNum(fpMove, 'moveSec', false);
  fpMoveY.addEventListener('change', () => {
    freq.moveY = fpMoveY.checked;
    onFreqChanged(false);   // 保存生效；无需重排计时器
  });
  document.getElementById('fp-close').addEventListener('click', hideFreqPanel);
  makeDraggable(freqPanel, freqPanel.querySelector('.sp-head'));

  // ================= 音量面板（总音量 + 音效大小 + BGM 音量 + 静音） =================
  const volPanel = document.getElementById('vol-panel');
  const vpRange = document.getElementById('vp-range');
  const vpVal = document.getElementById('vp-val');
  const vpMute = document.getElementById('vp-mute');
  const vpSfx = document.getElementById('vp-sfx');
  const vpSfxVal = document.getElementById('vp-sfx-val');
  const vpBgm = document.getElementById('vp-bgm');
  const vpBgmVal = document.getElementById('vp-bgm-val');
  function refreshVolPanel() {
    vpRange.value = audioCfg.master;
    vpVal.textContent = audioCfg.master + '%';
    vpMute.textContent = audioCfg.muted ? '🔇' : '🔊';
    vpMute.classList.toggle('muted', audioCfg.muted);
    vpSfx.value = audioCfg.sfxVol;
    vpSfxVal.textContent = audioCfg.sfxVol + '%';
    vpBgm.value = audioCfg.bgmVol;
    vpBgmVal.textContent = audioCfg.bgmVol + '%';
  }
  function showVolPanel(x, y) {
    hideCtxMenu();   // 面板之间可同时存在（音乐播放器保持打开）
    refreshVolPanel();
    openPanelAt(volPanel, x === undefined ? lastCtx.x : x, y === undefined ? lastCtx.y : y);
  }
  function hideVolPanel() { volPanel.style.display = 'none'; }
  vpRange.addEventListener('input', () => {
    audioCfg.master = Math.min(100, Math.max(0, parseInt(vpRange.value, 10) || 0));
    vpVal.textContent = audioCfg.master + '%';
    applyBgmVolume();
    refreshVolPanel();
    saveAudioCfg();
  });
  vpSfx.addEventListener('input', () => {
    audioCfg.sfxVol = Math.min(100, Math.max(0, parseInt(vpSfx.value, 10) || 0));
    vpSfxVal.textContent = audioCfg.sfxVol + '%';
    saveAudioCfg();
  });
  vpBgm.addEventListener('input', () => {
    audioCfg.bgmVol = Math.min(100, Math.max(0, parseInt(vpBgm.value, 10) || 0));
    vpBgmVal.textContent = audioCfg.bgmVol + '%';
    applyBgmVolume();
    saveAudioCfg();
  });
  vpMute.addEventListener('click', () => {
    audioCfg.muted = !audioCfg.muted;
    applyBgmVolume();
    refreshVolPanel();
    saveAudioCfg();
  });
  document.getElementById('vp-close').addEventListener('click', hideVolPanel);
  makeDraggable(volPanel, volPanel.querySelector('.sp-head'));

  // ================= 音乐播放器（BGM 列表 / 进度条 / 播放模式 / 独立音量） =================
  const musicPanel = document.getElementById('music-panel');
  const mpTrack = document.getElementById('mp-track');
  const mpPlay = document.getElementById('mp-play');
  const mpVol = document.getElementById('mp-vol');
  const mpList = document.getElementById('mp-list');
  const mpProg = document.getElementById('mp-prog');
  const mpTimeCur = document.getElementById('mp-time-cur');
  const mpTimeDur = document.getElementById('mp-time-dur');
  const mpMode = document.getElementById('mp-mode');
  function refreshMusicPanel() {
    mpTrack.innerHTML =
      '<span class="mp-note">🎵</span><span id="mp-track-name">' + BGM_NAMES[audioCfg.bgmIdx] +
      ' (' + (audioCfg.bgmIdx + 1) + '/' + BGM_FILES.length + ')</span> <span class="mp-arrow">▾</span>';
    musicPanel.classList.toggle('playing', audioCfg.bgmOn);   // 播放中：音符律动
    mpPlay.textContent = audioCfg.bgmOn ? '⏸' : '▶';
    mpVol.value = audioCfg.bgmVol;
    mpMode.textContent = (audioCfg.playMode === 'loop') ? '🔂' : '🔁';
    mpMode.title = (audioCfg.playMode === 'loop') ? '单曲循环（点击切顺序）' : '顺序播放（点击切单曲循环）';
    // 列表高亮
    const items = mpList.querySelectorAll('.mp-item');
    items.forEach((el) => el.classList.toggle('cur', +el.getAttribute('data-i') === audioCfg.bgmIdx));
  }
  function buildMusicList() {
    mpList.innerHTML = '';
    BGM_NAMES.forEach((name, i) => {
      const it = document.createElement('div');
      it.className = 'mp-item';
      it.setAttribute('data-i', String(i));
      it.textContent = (i + 1) + '. ' + name;
      it.addEventListener('click', () => {
        setBgm(i, true);            // 立即切换并按当前模式播放
        refreshMusicPanel();
        mpList.classList.remove('open');
        playSfxFile(AUDIO_FILES.uiSelect);
      });
      mpList.appendChild(it);
    });
  }
  onBgmMeta = (dur) => { mpTimeDur.textContent = fmtTime(dur); };
  onBgmTime = (cur, dur) => {
    mpTimeCur.textContent = fmtTime(cur);
    mpProg.value = dur > 0 ? Math.round((cur / dur) * 1000) : 0;
  };
  mpProg.addEventListener('input', () => {
    if (!bgmAudio || !bgmAudio.duration) return;
    bgmAudio.currentTime = (mpProg.value / 1000) * bgmAudio.duration;
  });
  mpTrack.addEventListener('click', () => {
    mpList.classList.toggle('open');
    if (mpList.classList.contains('open')) buildMusicList();
    playSfxFile(AUDIO_FILES.uiSelect);
  });
  function showMusicPanel(x, y) {
    hideCtxMenu();   // 面板之间可同时存在
    refreshMusicPanel();
    openPanelAt(musicPanel, x === undefined ? lastCtx.x : x, y === undefined ? lastCtx.y : y);
  }
  function hideMusicPanel() { musicPanel.style.display = 'none'; }
  mpPlay.addEventListener('click', () => { toggleBgm(); refreshMusicPanel(); });
  document.getElementById('mp-prev').addEventListener('click', () => { setBgm(audioCfg.bgmIdx - 1, true); refreshMusicPanel(); });
  document.getElementById('mp-next').addEventListener('click', () => { setBgm(audioCfg.bgmIdx + 1, true); refreshMusicPanel(); });
  mpMode.addEventListener('click', () => {
    audioCfg.playMode = (audioCfg.playMode === 'loop') ? 'order' : 'loop';
    if (bgmAudio) bgmAudio.loop = (audioCfg.playMode === 'loop');
    saveAudioCfg();
    refreshMusicPanel();
    playSfxFile(AUDIO_FILES.uiSelect);
  });
  mpVol.addEventListener('input', () => {
    audioCfg.bgmVol = Math.min(100, Math.max(0, parseInt(mpVol.value, 10) || 0));
    applyBgmVolume();
    saveAudioCfg();
  });
  document.getElementById('mp-close').addEventListener('click', hideMusicPanel);
  makeDraggable(musicPanel, musicPanel.querySelector('.sp-head'));

  // ================= 互聊设置面板（右键菜单💬板块 ⚙设置；改即保存生效） =================
  const chatterPanel = document.getElementById('chatter-panel');
  const ctOn = document.getElementById('ct-on');
  const ctNear = document.getElementById('ct-near');
  const ctNearVal = document.getElementById('ct-near-val');
  const ctCool = document.getElementById('ct-cool');
  const ctCoolVal = document.getElementById('ct-cool-val');
  const ctLines = document.getElementById('ct-lines');
  const ctLinesVal = document.getElementById('ct-lines-val');
  function refreshChatterPanel() {
    ctOn.checked = chatterCfg.on;
    ctNear.value = chatterCfg.near;
    ctNearVal.textContent = chatterCfg.near + 'px';
    ctCool.value = chatterCfg.cool;
    ctCoolVal.textContent = chatterCfg.cool + '分';
    ctLines.value = chatterCfg.lines;
    ctLinesVal.textContent = chatterCfg.lines + '行';
  }
  function showChatterPanel(x, y) {
    hideCtxMenu();
    refreshChatterPanel();
    openPanelAt(chatterPanel, x === undefined ? lastCtx.x : x, y === undefined ? lastCtx.y : y);
  }
  function hideChatterPanel() { chatterPanel.style.display = 'none'; }
  ctOn.addEventListener('change', () => { chatterCfg.on = ctOn.checked; saveChatterCfg(); if (!chatterCfg.on) stopChatter(); });
  ctNear.addEventListener('input', () => {
    chatterCfg.near = Math.min(400, Math.max(100, parseInt(ctNear.value, 10) || 220));
    ctNearVal.textContent = chatterCfg.near + 'px';
    saveChatterCfg();
  });
  ctCool.addEventListener('input', () => {
    chatterCfg.cool = Math.min(10, Math.max(1, parseInt(ctCool.value, 10) || 4));
    ctCoolVal.textContent = chatterCfg.cool + '分';
    saveChatterCfg();
  });
  ctLines.addEventListener('input', () => {
    chatterCfg.lines = Math.min(8, Math.max(2, parseInt(ctLines.value, 10) || 5));
    ctLinesVal.textContent = chatterCfg.lines + '行';
    saveChatterCfg();
  });
  document.getElementById('ct-close').addEventListener('click', hideChatterPanel);
  makeDraggable(chatterPanel, chatterPanel.querySelector('.sp-head'));
  // 菜单：⚙设置 → 面板；「找XX聊天」→ 先走近对方再开聊（重力：等落地停稳；非重力：先同高度再横向）
  let chatWalkState = false;   // 走向聊天进行中（被用户打断时中止）
  function roleWalkTo(role, tx, ty, onDone) {
    if (!chatWalkState) return;
    const c = idols[role];
    if (idolPhysicallyBusy(role)) { setTimeout(() => roleWalkTo(role, tx, ty, onDone), 250); return; }   // 弹跳/下落中：先等停稳
    const A = { x: c.container.x, y: c.container.y };
    const B = { x: tx, y: ty };
    if (Math.abs(A.x - B.x) < 6 && Math.abs(A.y - B.y) < 6) { if (onDone) onDone(); return; }
    c.walking = true;
    const dir = B.x >= A.x ? 1 : -1;
    onWalkStart(role, dir);
    c.walkTween = {
      start: performance.now(),
      dur: Math.min(1600, 400 + Math.abs(B.x - A.x) * 1.6 + Math.abs(B.y - A.y) * 1.2),
      update: (k) => { c.container.x = A.x + (B.x - A.x) * k; c.container.y = A.y + (B.y - A.y) * k; },
      done: () => { c.walking = false; c.walkTween = null; if (onDone) onDone(); }
    };
  }
  function walkToChat(role, targetRole, slotX, onArrive) {
    const c = idols[role], t = idols[targetRole];
    const ty = gravityOn ? c.container.y : t.container.y;   // 重力：保持当前（地面）；非重力：先把高度对齐目标
    roleWalkTo(role, c.container.x, ty, () => {
      if (!chatWalkState) return;
      roleWalkTo(role, slotX, ty, onArrive);
    });
  }
  // 走向前防重叠：与目标重叠（横<160 纵<220）时，自己先横向挪开一点再走
  function moveAwayIfOverlap(role, targetRole, onDone) {
    const a = idols[role], t = idols[targetRole];
    if (!t || Math.abs(a.container.x - t.container.x) >= 160 || Math.abs(a.container.y - t.container.y) >= 220) {
      if (onDone) onDone();
      return;
    }
    let dir = a.container.x >= t.container.x ? 1 : -1;
    let tx = a.container.x + dir * 130;
    if (tx < 60 || tx > viewW - 60) { dir = -dir; tx = a.container.x + dir * 130; }
    tx = Math.max(60, Math.min(viewW - 60, tx));
    roleWalkTo(role, tx, a.container.y, onDone);
  }
  function chatterInvite(target) {
    if (!ctxRole || !ROLES[target] || target === ctxRole) return;
    if (chatter.active) stopChatter();
    prepChatIdols([ctxRole, target]);   // 双方立即停止走动/姿势，回站立等对方（重力下先停稳再走）
    // 发起者走向目标身旁（两侧留 150px），到位后面向对方开聊
    const a = idols[ctxRole], t = idols[target];
    const slotX = Math.max(60, Math.min(viewW - 60, t.container.x + (t.container.x >= a.container.x ? -150 : 150)));
    chatWalkState = true;
    moveAwayIfOverlap(ctxRole, target, () => {   // 重叠先挪开；不重叠直接走
      if (!chatWalkState) return;
      walkToChat(ctxRole, target, slotX, () => { chatWalkState = false; startChatter([ctxRole, target]); });
    });
  }
  // 三人一起聊天：按站位取中间那只原地，左右两只先同高度、再横向聚拢到中间两侧（各隔170px）
  function chatterInviteTrio() {
    const avail = ROLE_KEYS.filter((k) => !idols[k].hidden && chatterIdxOk(k));
    if (avail.length < 3) return;
    if (chatter.active) stopChatter();
    prepChatIdols(avail);   // 三只全部立即停走回站立
    const sorted = avail.slice().sort((a, b) => idols[a].container.x - idols[b].container.x);
    const mid = sorted[1];
    const midX = idols[mid].container.x;
    const ty = idols[mid].container.y;
    const left = avail.filter((k) => idols[k].container.x <= midX && k !== mid);
    const right = avail.filter((k) => idols[k].container.x > midX && k !== mid);
    const movers = [];
    for (const r of left) movers.push([r, Math.max(60, midX - 170)]);
    for (const r of right) movers.push([r, Math.min(viewW - 60, midX + 170)]);
    if (!movers.length) { startChatter(sorted); return; }
    let done = 0;
    chatWalkState = true;
    const finish = () => { if (++done >= movers.length) { chatWalkState = false; startChatter(sorted); } };
    for (const [r, slotX] of movers) {
      moveAwayIfOverlap(r, mid, () => {           // 与中间者重叠先挪开
        if (!chatWalkState) return;
        walkToChat(r, mid, slotX, finish);
      });
    }
  }

  // ================= 自定义右键菜单（命中角色 → 该角色专属项 + 通用项） =================
  const ctxMenu = document.getElementById('ctx-menu');
  const ctxLockItem = document.getElementById('cm-lock');
  const ctxInteract = document.getElementById('cm-interact');
  const ctxChat = document.getElementById('cm-chat');
  const ctxStory = document.getElementById('cm-story');
  const ctxSize1 = document.getElementById('cm-size1');
  const ctxSizeAll = document.getElementById('cm-sizeall');
  const ctxSepRole = document.getElementById('cm-sep-role');
  let ctxRole = null;   // 命中角色；null=空白处（只显示通用项）
  const ctxGravityItem = document.getElementById('cm-gravity');
  function refreshCtxMenu() {
    ctxLockItem.textContent = idolLocked ? '🔒 锁定（禁止拖动）' : '🔓 取消锁定（允许拖动）';
    ctxGravityItem.textContent = gravityOn ? '🌍 重力：开（落地+可甩飞）' : '🌍 重力：关（悬浮走动）';
    const hasRole = !!ctxRole;
    ctxInteract.style.display = hasRole ? '' : 'none';
    ctxChat.style.display = hasRole ? '' : 'none';
    ctxStory.style.display = hasRole ? '' : 'none';
    if (hasRole) {
      ctxInteract.textContent = '👆 捏捏' + ROLES[ctxRole].label + '（互动）';
      ctxChat.textContent = '💬 和' + ROLES[ctxRole].label + '聊天…';
      ctxStory.textContent = '♪ ' + ROLES[ctxRole].label + '的故事';
      ctxSize1.textContent = '🎀 调整' + ROLES[ctxRole].label + '大小…';
    }
    ctxSepRole.style.display = '';
    ctxSize1.style.display = hasRole ? '' : 'none';
    ctxSizeAll.style.display = '';
    // 互聊板块"找XX聊天"：自己=禁用；隐藏/忙碌的目标=禁用；互聊进行中非参与者=禁用
    for (const k of ROLE_KEYS) {
      const btn = document.getElementById('ct-to-' + k);
      if (!btn) continue;
      const isSelf = (ctxRole === k);
      const chattingBusy = chatter.active && !chatter.roles.includes(k);   // 别人的互聊正在进行
      const unavailable = !hasRole || isSelf || idols[k].hidden || !chatterIdxOk(k) || chattingBusy;
      btn.classList.toggle('disabled', unavailable);
      btn.textContent = isSelf ? personaLabel(k) + '（自己）' : (chattingBusy ? '找' + personaLabel(k) + '（聊天中）' : '找' + personaLabel(k) + '聊天');
    }
    const trioBtn = document.getElementById('ct-to-trio');
    if (trioBtn) trioBtn.classList.toggle('disabled', chatter.active || ROLE_KEYS.some((k) => !chatterIdxOk(k)));
  }
  function showCtxMenu(x, y) {
    bringToFront(ctxMenu);   // 菜单也在聚焦层级中
    lastCtx = { x, y };
    ctxRole = hitIdol(x, y) || null;
    refreshCtxMenu();
    playSfxFile(AUDIO_FILES.uiOpen);
    ctxMenu.style.display = 'block';
    ctxMenu.style.left = '0px'; ctxMenu.style.top = '0px';
    const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight, pad = 8;
    let L = x + pad, T = y + pad;
    if (L + w > viewW - 8) L = x - w - pad;
    if (T + h > viewH - 8) T = y - h - pad;
    ctxMenu.style.left = Math.max(8, L) + 'px';
    ctxMenu.style.top = Math.max(8, T) + 'px';
  }
  function hideCtxMenu() { ctxMenu.style.display = 'none'; }
  ctxMenu.addEventListener('click', (e) => {
    const chatBtn = e.target.closest('.cm-chat-btn');
    if (chatBtn) {
      playSfxFile(AUDIO_FILES.uiSelect);
      hideCtxMenu();
      if (chatBtn.id === 'ct-to-trio') chatterInviteTrio();
      else chatterInvite(chatBtn.getAttribute('data-chat-to'));
      return;
    }
    const setBtn = e.target.closest('.cm-chat-set');
    if (setBtn) { playSfxFile(AUDIO_FILES.uiSelect); hideCtxMenu(); showChatterPanel(lastCtx.x, lastCtx.y); return; }
    const item = e.target.closest('.cm-item');
    if (!item) return;
    const act = item.getAttribute('data-act');
    playSfxFile(AUDIO_FILES.uiSelect);
    hideCtxMenu();
    if (act === 'chatter-set') showChatterPanel(lastCtx.x, lastCtx.y);
    if (act === 'interact') { if (ctxRole) interact(ctxRole); }
    else if (act === 'story') { if (ctxRole) openTrainDialog(ctxRole); }
    else if (act === 'freq') showFreqPanel(lastCtx.x, lastCtx.y);
    else if (act === 'gravity') {
      gravityOn = !gravityOn;
      saveGravity();
      if (!gravityOn) {
        for (const k of ROLE_KEYS) { idols[k].vel.x = 0; idols[k].vel.y = 0; }
      }
    }
    else if (act === 'vol') showVolPanel(lastCtx.x, lastCtx.y);
    else if (act === 'music') showMusicPanel(lastCtx.x, lastCtx.y);
    else if (act === 'chat') { if (ctxRole) openChatPanel(ctxRole); }
    else if (act === 'size1') { if (ctxRole) showSizePanel(ctxRole); }
    else if (act === 'sizeall') showSizePanel('all');
    else if (act === 'lock') {
      idolLocked = !idolLocked;
      try { localStorage.setItem('QX_LOCK', idolLocked ? '1' : '0'); } catch (err) { /* noop */ }
    }
    else if (act === 'quit') dk.quit();
  });
  // 菜单项悬停音效（mouseenter 每项触发一次）
  ctxMenu.addEventListener('mouseover', (e) => {
    const item = e.target.closest('.cm-item');
    if (item) playSfxFile(AUDIO_FILES.uiHover);
  });
  document.getElementById('cm-close').addEventListener('click', hideCtxMenu);
  makeDraggable(ctxMenu, ctxMenu.querySelector('.cm-head'));
  window.addEventListener('mousedown', (e) => {
    if (ctxMenu.style.display === 'none') return;
    if (!ctxMenu.contains(e.target)) hideCtxMenu();
  });
  document.addEventListener('contextmenu', (e) => {
    // 浮层（聊天面板/气泡输入/历史/其他面板/菜单/对话框）内：不弹全局主菜单
    // （输入框的右键菜单由 input 自身 contextmenu 处理）
    if (e.target.closest('#chat-panel,#bubble-chat,#bc-history,#ctx-menu,#dialog,#size-panel,#freq-panel,#vol-panel,#music-panel,#input-ctx')) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY);
  });

  // ================= AI 对话（三小只角色扮演；协议层见 ai-core.js） =================
  let aiCfg = { provider: 'deepseek', apiKey: '', model: 'deepseek-v4-flash', temperature: 1.0, maxTokens: 256, contextRounds: 20, historyOn: true, chatMode: 'panel', webSearch: false, connected: false };
  function loadAICfg() {
    let raw = null;
    try { raw = dk.readAICfg(); } catch (e) { /* noop */ }
    if (!raw) { try { raw = dk.env('QX_AI') || localStorage.getItem('QX_AI'); } catch (e) { raw = dk.env('QX_AI'); } }
    if (raw) { try { const o = JSON.parse(raw); if (o) Object.assign(aiCfg, o); } catch (e) { /* ignore */ } }
    // 模型自动升级：旧 deepseek-chat/reasoner → v4 系列（官方 2026 新版命名）
    if (!['deepseek-v4-flash', 'deepseek-v4-pro'].includes(aiCfg.model)) aiCfg.model = 'deepseek-v4-flash';
    aiCfg.apiKey = aiCfg.apiKey || '';
    aiCfg.temperature = Math.min(2, Math.max(0, +aiCfg.temperature || 1.0));
    aiCfg.maxTokens = Math.min(2048, Math.max(32, +aiCfg.maxTokens || 256));
    aiCfg.contextRounds = Math.min(100, Math.max(2, +aiCfg.contextRounds || 20));
    if (aiCfg.chatMode !== 'bubble') aiCfg.chatMode = 'panel';
    aiCfg.webSearch = !!aiCfg.webSearch;
  }
  function saveAICfg() {
    dk.writeAICfg(JSON.stringify(aiCfg));   // 项目内 data/ai_config.json（panel 与主窗共享真源）
    try { localStorage.setItem('QX_AI', JSON.stringify(aiCfg)); } catch (e) { /* noop */ }
  }
  // 人设提示词：完整详细提示词固化在 assets/personas.json（含各自【红线】；运行时只读此文件）
  // 注入规则（IMMERS_RULE / MOOD_REMIND / MOOD_RULE / EMOJI_RULE）见 ai-core.js
  let personas = { roles: {} };
  function loadPersonas(web) {
    const file = web ? 'personas_web.json' : 'personas.json';   // 联网模式用"可搜索"改造版人设
    try {
      const o = JSON.parse(dk.readText(file));
      if (o && o.roles && o.roles.airui && o.roles.qianxia && o.roles.nangong &&
          o.roles.airui.system && o.roles.qianxia.system && o.roles.nangong.system) {
        personas = o;
        for (const k of ROLE_KEYS) {
          if (!personas.roles[k].system.includes('【禁用】')) personas.roles[k].system += AI.EMOJI_RULE;
        }
        return;
      }
    } catch (e) { /* try fallback below */ }
    try {
      const o = JSON.parse(dk.readText('personas.json'));
      if (o && o.roles) {
        personas = o;
        for (const k of ROLE_KEYS) {
          if (!personas.roles[k].system.includes('【禁用】')) personas.roles[k].system += AI.EMOJI_RULE;
        }
        return;
      }
    } catch (e) { /* noop */ }
  }
  const personaLabel = (role) => (personas.roles[role] && personas.roles[role].label) || ROLES[role].label;

  const chat = { open: false, role: null, messages: [], busy: false, typeTimer: null };
  const cpEl = document.getElementById('chat-panel');
  const cpBody = document.getElementById('cp-body');
  const cpInput = document.getElementById('cp-input');
  const cpSend = document.getElementById('cp-send');
  const cpTitle = document.getElementById('cp-title');
  // 气泡聊天模式：角色下方输入框
  const bcEl = document.getElementById('bubble-chat');
  const bcInput = document.getElementById('bc-input');
  const bcSend = document.getElementById('bc-send');
  // 聊天中的角色：不触发走动/待机气泡+姿势（原地动画正常播放）；退出聊天后恢复
  const chatFrozen = {};
  function unfreezeIdol(role) {
    if (!chatFrozen[role]) return;
    chatFrozen[role] = false;
    if (moodTimer) { clearTimeout(moodTimer); moodTimer = null; }
    // 恢复待机循环（不动气泡——气泡由关闭聊天的 3 秒延迟规则管理）
    const c = idols[role];
    if (c.walkTween) { c.walkTween = null; c.walking = false; }
    if (clearFaceTimers[role]) { clearTimeout(clearFaceTimers[role]); clearFaceTimers[role] = null; }
    c.poseId = 0;
    c.state.setAnimation(0, '动作_待机', true);
    c.state.setAnimation(1, '表情_常态', true);
  }
  function isChatFrozen(role) { return chatFrozen[role] === true; }
  // 情绪 → 三小只动作表情（表定义移入 core.js）
  let moodTimer = null;
  function applyMoodPose(role, mood) {
    const p = MOOD_POSES[mood] && MOOD_POSES[mood][role];
    if (!p || !idols[role]) return;
    const c = idols[role];
    c.state.setAnimation(0, '动作_' + p[0], true);
    c.state.setAnimation(1, '表情_' + (p[1] || p[0]), true);
    if (moodTimer) clearTimeout(moodTimer);
    moodTimer = setTimeout(() => {   // 情绪动作展示 4.5s 后，回聊天待机循环
      moodTimer = null;
      if (chatFrozen[role] && chat.open && chat.role === role) freezeIdol(role);
    }, 4500);
  }
  function freezeIdol(role) {
    const c = idols[role];
    chatFrozen[role] = true;
    if (c.walkTween) { c.walkTween = null; c.walking = false; }
    if (clearFaceTimers[role]) { clearTimeout(clearFaceTimers[role]); clearFaceTimers[role] = null; }
    c.poseId = 0;
    // 原地待机动画正常循环（不冻结帧）：只是不再走动/不自动冒泡/不触发待机姿势
    c.state.setAnimation(0, '动作_待机', true);
    c.state.setAnimation(1, '表情_常态', true);
  }
  function loadChatHistory(role) {
    try {
      const raw = dk.readChatHistory(role);
      if (!raw) return [];
      const o = JSON.parse(raw);
      return (o && Array.isArray(o.messages)) ? o.messages : [];
    } catch (e) { return []; }
  }
  function saveChatHistory(role) {
    // 历史全量落盘（前端截取最近若干条发请求）；最多保留 200 条防膨胀
    chat.messages = chat.messages.slice(-200);
    dk.writeChatHistory(role, JSON.stringify({ messages: chat.messages, ts: Date.now() }));
  }
  // 复制反馈：按钮原位置短暂变为"✅ 已复制"后恢复
  function copyWithFeedback(btn, text) {
    dk.clipboardWrite(text);
    const old = btn.textContent;
    btn.textContent = '✅ 已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }
  function chatMsgEl(role, text, cls) {
    const wrap = document.createElement('div');
    wrap.className = 'cp-item ' + (role === 'user' ? 'user' : 'bot');
    const d = document.createElement('div');
    d.className = 'cp-msg ' + (role === 'user' ? 'user' : 'bot') + (cls ? ' ' + cls : '');
    d.textContent = stripMood(text);   // 显示层兜底：历史/异常文本里的 <mood> 一律不显示
    wrap.appendChild(d);
    const ops = document.createElement('div');
    ops.className = 'cp-ops';
    const cop = document.createElement('span');
    cop.className = 'op';
    cop.textContent = '⧉ 复制';
    cop.addEventListener('click', () => copyWithFeedback(cop, text));
    ops.appendChild(cop);
    wrap.appendChild(ops);
    return wrap;
  }
  let editMsgIndex = null;   // 编辑重发：chat.messages 中正在编辑的 user 消息索引
  const cpRow = cpInput.closest('.cp-input-row');   // 常驻输入行（编辑时暂时隐藏）
  function renderChat() {
    cpBody.innerHTML = '';
    if (!chat.messages.length) {
      const h = document.createElement('div');
      h.className = 'cp-hint';
      h.style.padding = '24px 10px';
      h.textContent = '和' + personaLabel(chat.role) + '聊聊吧～（历史对话保存在本地，下次打开可接上）';
      cpBody.appendChild(h);
    } else {
      // 最后一条用户消息：额外提供"编辑"（原地展开为输入框→回车发送）
      let lastUserIdx = -1;
      for (let i = chat.messages.length - 1; i >= 0; i--) {
        if (chat.messages[i].role === 'user') { lastUserIdx = i; break; }
      }
      chat.messages.forEach((m, i) => {
        const item = chatMsgEl(m.role, m.content);
        item.dataset.midx = String(i);   // 消息索引锚点（编辑定位用，不依赖 children 顺序）
        if (i === lastUserIdx) {
          const ed = document.createElement('span');
          ed.className = 'op';
          ed.textContent = '✏️ 编辑';
          ed.addEventListener('click', () => startEditMsg(i));
          item.querySelector('.cp-ops').appendChild(ed);
        }
        cpBody.appendChild(item);
      });
    }
    cpBody.scrollTop = cpBody.scrollHeight;
  }
  let editMsgWrap = null;
  function startEditMsg(i) {
    if (!chat.messages[i] || chat.messages[i].role !== 'user') return;
    editMsgIndex = i;
    // 用 data-midx 定位（比 cpBody.children[i] 稳，避免"思考中"等残留占位导致错位）
    const wrap = cpBody.querySelector('[data-midx="' + i + '"]') || cpBody.children[i];
    if (!wrap) return;
    editMsgWrap = wrap;
    const msgEl = wrap.querySelector('.cp-msg');
    const ta = document.createElement('textarea');
    ta.className = 'cp-msg cp-edit';
    ta.value = chat.messages[i].content;
    ta.rows = 2;
    ta.placeholder = '编辑这条消息（Enter 发送，Esc 取消）';
    msgEl.replaceWith(ta);
    wrap.querySelector('.cp-ops').style.display = 'none';   // 编辑中隐藏操作条
    dk.setFocusable(true);                                   // 先保持窗口可聚焦（防止隐藏输入行触发 blur 解锁）
    if (cpRow) cpRow.style.display = 'none';                 // 隐藏常驻输入行
    ta.focus();
    ta.addEventListener('focus', () => dk.setFocusable(true));
    ta.addEventListener('blur', () => {
      // 编辑态中失去焦点（如点击面板空白）：保持窗口可聚焦，避免键盘丢失
      if (editMsgIndex == null && chatMode() === 'panel') dk.setFocusable(false);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cpInput.value = ta.value; sendChat(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
  }
  function cancelEdit() {
    editMsgIndex = null;
    editMsgWrap = null;
    cpInput.placeholder = '输入想对她说的话…';
    const n = document.getElementById('chip-notice');
    if (n) n.remove();
    if (cpRow) cpRow.style.display = '';
    renderChat();   // 重建消息列表（恢复原气泡与常驻输入行）
    dk.setFocusable(true);
    setTimeout(() => { cpInput.focus(); }, 30);   // 取消后焦点回输入框
  }
  function showTyping(reply) {
    const wrap = chatMsgEl('assistant', '');
    const el = wrap.querySelector('.cp-msg');
    cpBody.appendChild(wrap);
    let i = 0;
    const step = () => {
      i = Math.min(i + 2, reply.length);
      el.textContent = reply.slice(0, i);
      cpBody.scrollTop = cpBody.scrollHeight;
      if (i < reply.length) chat.typeTimer = setTimeout(step, 28);
      else chat.typeTimer = null;
    };
    step();
  }
  // 头顶气泡打字机（气泡模式：逐字追加、气泡随文本自适应大小）
  let bubbleTypingTimer = null;
  let bubbleThinking = false;   // 当前气泡是否处于"..."等待动画（→ 打字机无缝接管）
  function showBubbleThinking(role) {
    if (bubbleTypingTimer) { clearTimeout(bubbleTypingTimer); bubbleTypingTimer = null; }
    if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; bubbleDeferred = false; }
    // 无条件接管（用户再次发送时：已存在的气泡内容直接变回"..."，新回复后打字覆盖）
    bubbleThinking = true;
    bubbleLock = true;
    bubbleIsChat = true;   // 聊天气泡：拖动角色时保持显示
    if (role) bubbleRole = role;
    popover.innerHTML = '<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>';
    popover.classList.add('show');
    placePopover();
  }
  // 气泡隐藏调度（用户规则：打字完成后聊天仍开着 → 气泡保持；关闭聊天后延 3 秒；3 秒内重开 → 保持）
  let bubbleDeferred = false;   // true=正处于"关闭聊天后的 3 秒延迟关闭"状态（重开会保留气泡）
  function scheduleBubbleHide(holdMs) {
    if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
    if (chat.open && chat.role === bubbleRole) return;   // 聊天仍打开：有内容的气泡保持显示
    bubbleDeferred = true;
    bubbleHideTimer = setTimeout(() => {
      bubbleHideTimer = null;
      bubbleDeferred = false;
      popover.classList.remove('show');
      bubbleLock = false;
    }, holdMs);
  }
  function showBubbleTyping(text, holdMs, role) {
    const takeover = bubbleThinking;   // thinking → typing 无缝接管（不闪烁、不重开）
    if (bubbleTypingTimer) { clearTimeout(bubbleTypingTimer); bubbleTypingTimer = null; }
    if (!takeover) {
      if (bubbleLock) return false;
      bubbleLock = true;
      bubbleIsChat = true;   // 聊天气泡：拖动角色时保持显示
      if (role) bubbleRole = role;
      popover.textContent = '';
      popover.classList.add('show');
    }
    if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
    bubbleThinking = false;
    popover.innerHTML = '';   // 清掉 thinking 点
    placePopover();
    let i = 0;
    const step = () => {
      i = Math.min(i + 2, text.length);
      popover.textContent = text.slice(0, i);
      placePopover();
      if (i < text.length) bubbleTypingTimer = setTimeout(step, 36);
      else {
        bubbleTypingTimer = null;
        // 规则：聊天仍打开 → 气泡保持显示；聊天已关闭 → 3 秒后关闭
        scheduleBubbleHide(3000);
      }
    };
    step();
    return true;
  }
  let thinkingEl = null;   // "（思考中）"占位元素（awaiter 等待期间展示；到达后移除）
  function removeThinking() {
    if (thinkingEl) {
      if (thinkingEl.parentNode) thinkingEl.parentNode.removeChild(thinkingEl);
      thinkingEl = null;
    }
  }
  function chatMode() { return aiCfg.chatMode === 'bubble' ? 'bubble' : 'panel'; }
  async function sendChat() {
    const src = (chatMode() === 'bubble') ? bcInput : cpInput;
    const text = (src.value || '').trim();
    if (!text || chat.busy || !chat.role) return;
    src.value = '';
    const role = chat.role;
    // 编辑重发：移除被编辑消息及其之后的全部记录，再作为新消息发送
    if (editMsgIndex != null && chatMode() === 'panel') {
      chat.messages.splice(editMsgIndex);
      editMsgIndex = null;
      cancelEdit();
      renderChat();
    }
    chat.messages.push({ role: 'user', content: text });
    if (chatMode() === 'panel') renderChat();
    saveChatHistory(role);
    chat.busy = true;
    if (chatMode() === 'panel') {
      cpSend.classList.add('busy');
      thinkingEl = chatMsgEl('assistant', '…（思考中）', 'cp-think');
      cpBody.appendChild(thinkingEl);
      cpBody.scrollTop = cpBody.scrollHeight;
    } else {
      bcSend.classList.add('busy');
      showBubbleThinking(role);   // 头顶立即出现"..."动画气泡（回复到达后无缝切换打字机）
    }
    // 构造请求（ai-core.js：人设+情绪规则+当前时间 / 历史裁剪 / 首次注入 / 每轮 mood 提醒）
    const aiMessages = AI.buildChatMessages(
      (personas.roles[role] && personas.roles[role].system) || '',
      chat.messages, aiCfg.contextRounds
    );
    let res = null;
    if (dk.env('QX_AI_MOCK') === '1') {
      await new Promise((r) => setTimeout(r, 600));
      res = { ok: true, content: AI.MOCK_TEXT };
    } else {
      try { res = await AI.request(dk, aiCfg, role, aiMessages); } catch (e) { res = { ok: false, error: e.message }; }
    }
    if (chatMode() === 'panel') {
      cpSend.classList.remove('busy');
    } else {
      bcSend.classList.remove('busy');
    }
    removeThinking();   // 清理"（思考中）"占位（曾因缺失导致残留 DOM 与消息索引错位）
    if (!res || !res.ok || !(res.content || '').trim()) {
      chat.messages.push({ role: 'assistant', content: '（信号不太好）' });
      const errText = (res && res.error) ? res.error :
        '模型未返回有效内容（联网搜索较慢或字数上限过小，可稍后重试 / 调大字数上限）';
      if (chatMode() === 'panel') {
        cpBody.appendChild(chatMsgEl('assistant', '⚠️ ' + errText, 'cp-err'));
        cpBody.scrollTop = cpBody.scrollHeight;
      } else {
        showBubbleTyping('⚠️ ' + errText, 4000, role);
      }
      saveChatHistory(role);
      chat.busy = false;
      return;
    }
    // 解析情绪标签（ai-core.js：提取 mood + 纯净文本）
    const pr = AI.parseMoodReply(res.content);
    const pureText = pr.text;
    if (!pr.mood) console.log('[MOOD] 未检测到情绪标签（模型未输出或格式不符）, replyLen=', (res.content || '').length);
    chat.messages.push({ role: 'assistant', content: pureText || res.content });
    saveChatHistory(role);
    chat.busy = false;
    if (!aiCfg.connected) { aiCfg.connected = true; saveAICfg(); }   // 真实聊天成功：标记"连通"（捏捏 AI 反应条件）
    if (pr.mood) applyMoodPose(role, pr.mood);   // 情绪 → 角色动作表情（实时）
    const showText = pureText || res.content;
    if (chatMode() === 'panel') {
      showTyping(showText);   // 面板打字机
      showBubble(showText.replace(/（.*?）/g, '').slice(0, 18), 2600, role);
    } else {
      showBubbleTyping(showText, 4200, role);   // 头顶气泡打字机（自适应大小）
    }
  }
  // 气泡模式：输入框跟随角色（角色冻结站立，位置基本不变；拖动角色时也会跟随）
  function positionBubbleChat() {
    if (!chat.open || !chat.role || chatMode() !== 'bubble') return;
    const role = chat.role;
    const p = worldToScreenPx(role, 0, ROLES[role].bbox.minY);   // 骨架脚底
    const w = 330;
    bcEl.style.left = Math.max(8, Math.min(viewW - w - 8, p.x - w / 2)) + 'px';
    bcEl.style.top = Math.min(viewH - 78, p.y + 10) + 'px';
    positionBcHist();   // 历史面板跟随（不挡角色：与输入框同一水平线）
  }
  function openChatPanel(key) {
    const role = ROLES[key] ? key : 'qianxia';
    stopChatter();   // 用户开聊天：立即中止三小只互聊
    // 已有其他角色的聊天：先关闭并恢复她（避免冻结状态残留——修"被覆盖角色一直保持对话中"）
    if (chat.open && chat.role && chat.role !== role) {
      closeChatPanel();
    }
    // 气泡规则：
    //  - "关闭聊天后 3 秒延迟"中重开（bubbleDeferred）→ 取消关闭，气泡继续保持
    //  - 正常残留气泡（欢迎/互动）→ 进入聊天时清掉
    if (bubbleHideTimer && bubbleDeferred) {
      clearTimeout(bubbleHideTimer); bubbleHideTimer = null; bubbleDeferred = false;
    } else if (bubbleLock) {
      bubbleLock = false;
      popover.classList.remove('show');
    }
    chat.role = role;
    chat.messages = loadChatHistory(role);
    chat.open = true;
    freezeIdol(role);            // 她不走动/不自动冒泡；原地动画正常播放（退出聊天恢复）
    applyChatModeUI();           // 按当前样式显示对应 UI（panel / bubble）
    dk.setFocusable(true);
    setTimeout(() => {
      (chatMode() === 'bubble' ? bcInput : cpInput).focus();
    }, 80);
    refreshMouseIgnore();   // 穿透放行聊天区域
  }
  // 按当前配置样式显示对应聊天 UI（打开时 & 热更新样式切换时共用）
  function applyChatModeUI() {
    if (!chat.open || !chat.role) return;
    if (chatMode() === 'bubble') {
      cpEl.style.display = 'none';
      bcEl.style.display = 'flex';
      bringToFront(bcEl);
      positionBubbleChat();
    } else {
      bcEl.style.display = 'none';
      cpTitle.textContent = '💬 和' + personaLabel(chat.role) + '聊天';
      cpEl.style.display = 'flex';
      bringToFront(cpEl);
      renderChat();
    }
  }
  // 控制台「保存配置」→ main 转发 ai-config-refresh → 此处热更新（所有配置统一走保存按钮）
  dk.onAICfgSaved(() => {
    loadAICfg();
    loadPersonas(aiCfg.webSearch);   // 联网开关变更：立即切换对应版本人设
    applyChatModeUI();   // 样式改动立即应用（聊天进行中）
    // 清理瞬时浮层：全局主菜单/输入右键菜单/气泡历史对话框
    hideCtxMenu();
    hideInputCtx();
    bcHistOpen = false;
    bcHist.style.display = 'none';
    bcHistBtn.textContent = '▶';
  });
  function closeChatPanel() {
    const role = chat.role;
    chat.open = false;
    chat.role = null;
    chat.messages = [];
    editMsgIndex = null;
    editMsgWrap = null;
    cpInput.placeholder = '输入想对她说的话…';
    if (cpRow) cpRow.style.display = '';
    cpEl.style.display = 'none';
    bcEl.style.display = 'none';
    bcHistOpen = false;
    bcHist.style.display = 'none';
    bcHistBtn.textContent = '▶';
    if (role) unfreezeIdol(role);   // 恢复该角色正常待机循环（不影响气泡显示）
    // 有返回文本的气泡：关闭聊天后延 3 秒再关（3 秒内重开会保持）
    if (bubbleLock) scheduleBubbleHide(3000);
    dk.setFocusable(false);
  }
  // 输入框右键菜单（复制/粘贴/剪切/全选；cpInput 与 bcInput 通用）
  const inputCtx = document.getElementById('input-ctx');
  function hideInputCtx() { inputCtx.style.display = 'none'; }
  function showInputCtx(x, y, input) {
    inputCtx.innerHTML = '';
    const items = [
      ['🗐 复制', () => {
        const s = input.value.slice(input.selectionStart, input.selectionEnd);
        if (s) dk.clipboardWrite(s);
      }],
      ['📋 粘贴', async () => {
        const t = await dk.clipboardRead();
        if (t) {
          const s = input.selectionStart, e = input.selectionEnd;
          input.value = input.value.slice(0, s) + t + input.value.slice(e);
          const pos = s + t.length;
          input.selectionStart = input.selectionEnd = pos;
        }
      }],
      ['✂ 剪切', () => {
        const s = input.value.slice(input.selectionStart, input.selectionEnd);
        if (s) {
          dk.clipboardWrite(s);
          input.value = input.value.slice(0, input.selectionStart) + input.value.slice(input.selectionEnd);
        }
      }],
      ['｜ 全选', () => { input.select(); }]
    ];
    for (const [label, fn] of items) {
      const el = document.createElement('div');
      el.className = 'ic-item';
      el.textContent = label;
      el.addEventListener('mousedown', (e) => { e.preventDefault(); hideInputCtx(); fn(); input.focus(); });
      inputCtx.appendChild(el);
    }
    inputCtx.style.display = 'block';
    inputCtx.style.left = Math.max(8, Math.min(x, viewW - 150)) + 'px';
    inputCtx.style.top = Math.max(8, Math.min(y, viewH - 190)) + 'px';
    bringToFront(inputCtx);
  }
  for (const inp of [cpInput, bcInput]) {
    inp.addEventListener('contextmenu', (e) => { e.preventDefault(); showInputCtx(e.clientX, e.clientY, inp); });
  }
  window.addEventListener('mousedown', (e) => {
    if (inputCtx.style.display !== 'none' && !inputCtx.contains(e.target)) hideInputCtx();
  });

  // 气泡模式：历史对话查看（复用手机聊天面板的 UI：头部+消息流，去掉输入行，仅复制按钮）
  const bcHist = document.getElementById('bc-history');
  const bcHistBtn = document.getElementById('bc-hist-btn');
  const bhBody = document.getElementById('bh-body');
  let bcHistOpen = false;
  function positionBcHist() {
    if (!bcHistOpen || !chat.open) { bcHist.style.display = 'none'; return; }
    const r = bcEl.getBoundingClientRect();
    const w = 340;
    let left = r.right + 10;
    if (left + w > viewW - 8) left = r.left - w - 10;   // 右侧被屏幕边缘挡住→左侧
    bcHist.style.display = 'block';
    const hh = Math.min(430, bcHist.offsetHeight || 430);
    let top = Math.max(8, r.bottom - hh);              // 底边与输入框底边对齐（左下角开始）
    bcHist.style.left = Math.max(8, left) + 'px';
    bcHist.style.top = top + 'px';
    // ⚠️ 滚动到最新只在"打开"时做一次（此函数每帧调用，不能每次拉底——否则滚动条一直被吸到底）
    if (bcHistNeedScroll) {
      bcHistNeedScroll = false;
      setTimeout(() => { bhBody.scrollTop = bhBody.scrollHeight; }, 60);
    }
  }
  let bcHistNeedScroll = false;
  function renderBcHist() {
    bhBody.innerHTML = '';
    if (!chat.messages.length) {
      const h = document.createElement('div');
      h.className = 'cp-hint';
      h.style.padding = '20px 8px';
      h.textContent = '还没有对话记录~';
      bhBody.appendChild(h);
      return;
    }
    for (const m of chat.messages) bhBody.appendChild(chatMsgEl(m.role, m.content));   // 复用面板样式；仅复制按钮
    requestAnimationFrame(() => { bhBody.scrollTop = bhBody.scrollHeight; });
  }
  bcHistBtn.addEventListener('click', () => {
    bcHistOpen = !bcHistOpen;
    bcHistBtn.textContent = bcHistOpen ? '◀' : '▶';
    if (bcHistOpen) {
      bcHistNeedScroll = true;   // 打开时滚动到最新（仅一次）
      renderBcHist();
      positionBcHist();
    } else bcHist.style.display = 'none';
  });
  document.getElementById('bh-close').addEventListener('click', () => {
    bcHistOpen = false;
    bcHist.style.display = 'none';
    bcHistBtn.textContent = '▶';
  });
  document.getElementById('bh-clear').addEventListener('click', () => {
    if (!chat.role) return;
    dk.clearChatHistory(chat.role);   // 删除该角色本地历史
    chat.messages = [];
    renderBcHist();
  });

  cpSend.addEventListener('click', sendChat);
  cpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    if (e.key === 'Escape' && editMsgIndex != null) { e.preventDefault(); cancelEdit(); }
  });
  cpInput.addEventListener('focus', () => dk.setFocusable(true));
  cpInput.addEventListener('blur', () => {
    // 编辑态中隐藏常驻输入行会触发本 blur：此时窗口仍须保持可聚焦（编辑框继续输入）
    if (editMsgIndex == null) dk.setFocusable(false);
  });
  bcSend.addEventListener('click', sendChat);
  bcInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  bcInput.addEventListener('focus', () => dk.setFocusable(true));
  bcInput.addEventListener('blur', () => dk.setFocusable(false));
  document.getElementById('cp-close').addEventListener('click', closeChatPanel);
  document.getElementById('bc-close').addEventListener('click', closeChatPanel);
  document.getElementById('cp-clear').addEventListener('click', () => {
    if (!chat.role) return;
    dk.clearChatHistory(chat.role);   // 删除该角色本地历史文件
    chat.messages = [];
    renderChat();
  });
  makeDraggable(cpEl, cpEl.querySelector('.cp-head'));
  loadAICfg();     // AI 配置（data/ai_config.json；保存按钮触发热更新）
  loadPersonas(aiCfg.webSearch);  // 人设提示词（联网模式=personas_web.json 可搜索版）

  // ================= 三小只空闲互聊（靠近触发；数据流：人设+记忆→合并生成→脚本筛选→各自注入） =================
  // 可编辑配置（右键菜单"互聊"板块 → 设置面板；改即保存生效；持久层见 settings.js）
  let chatterCfg = { on: true, near: 220, cool: 4, lines: 5 };
  function loadChatterCfg() { S.loadChatterCfg(chatterCfg); }
  function saveChatterCfg() { S.saveChatterCfg(chatterCfg); }
  const CHATTER_CFG = { COOL_MIN: 0, COOL_MAX: 0, CHECK_MS: 4000, LINE_MAX: 8 };  // 运行时上下限；实际值来自 chatterCfg
  const chatter = { active: false, roles: [], lines: [], idx: 0, timer: null, showTimer: null, cooldownUntil: 0 };
  function chatterIdxOk(k) {
    const c = idols[k];
    // 允许待机走动中的角色（触发时她会立即停下）——否则三只频繁走动导致长时间凑不齐
    return !c.hidden && !isChatFrozen(k) && !(chat.open && chat.role === k) && !idolPhysicallyBusy(k);
  }
  // 聊天前"定格"：停止走动/姿势/泡泡，回到站立待机（等待对方走来）
  function prepChatIdols(roles) {
    for (const k of roles) {
      const c = idols[k];
      if (c.walkTween) { c.walkTween = null; c.walking = false; }
      if (clearFaceTimers[k]) { clearTimeout(clearFaceTimers[k]); clearFaceTimers[k] = null; }
      if (bubbleLock && bubbleRole === k) bubbleLock = false;
      c.poseId = 0;
      c.state.setAnimation(0, '动作_待机', true);
      c.state.setAnimation(1, '表情_常态', true);
    }
  }
  function dist2(a, b) { return Math.abs(idols[a].container.x - idols[b].container.x); }
  // 互聊台词注入各自记忆（chatter-engine.js 生成记忆文本；写入各自 chat_*.json）
  function saveChatterMemory() {
    if (!chatter.lines || !chatter.lines.length) return;
    const mem = CE.memorize(chatter.lines, chatter.roles, personaLabel);
    for (const [r, content] of Object.entries(mem)) {
      try {
        let msgs = [];
        const raw = dk.readChatHistory(r);
        if (raw) { const o = JSON.parse(raw); msgs = (o && o.messages) || []; }
        msgs.push({ role: 'assistant', content });
        dk.writeChatHistory(r, JSON.stringify({ messages: msgs.slice(-200), ts: Date.now() }));
      } catch (e) { /* noop */ }
    }
  }
  function stopChatter() {
    const wasActive = chatter.active || chatWalkState;
    if (!wasActive) return;   // 没在互聊/走向中：零动作（互动某只时绝不能重置其他人！）
    saveChatterMemory();   // 先把已说的台词注入各自记忆（打断也保存已说部分）
    chatWalkState = false;   // 中止"走向聊天"流程
    chatter.active = false;
    chatter.lines = [];
    chatter.idx = 0;
    if (chatter.showTimer) { clearTimeout(chatter.showTimer); chatter.showTimer = null; }
    if (bubbleTypingTimer) { clearTimeout(bubbleTypingTimer); bubbleTypingTimer = null; }
    if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
    bubbleThinking = false;
    bubbleLock = false;
    popover.classList.remove('show');
    const roles = chatter.roles.slice();
    chatter.roles = [];
    for (const k of roles) if (!idols[k].hidden) resetIdolIdleState(k);   // 只恢复参与互聊的角色
    const coolMs = chatterCfg.cool * 60 * 1000;
    chatter.cooldownUntil = Date.now() + coolMs * 0.5 + Math.random() * coolMs;   // 配置值 ±50% 随机
  }
  function scheduleChatterCheck() {
    clearTimeout(chatter.timer);
    chatter.timer = setTimeout(checkChatter, CHATTER_CFG.CHECK_MS);
  }
  function checkChatter() {
    if (chatter.active || chat.open || dialog.open || drag.on || gravityOn || !chatterCfg.on) { scheduleChatterCheck(); return; }
    if (Date.now() < chatter.cooldownUntil) { scheduleChatterCheck(); return; }
    const idle = ROLE_KEYS.filter(chatterIdxOk);
    if (idle.length < 2) { scheduleChatterCheck(); return; }
    // 三人：两两 ≤ near*1.27 → 三人闲聊；否则找最近的一对（≤ near）→ 两人闲聊
    const NEAR = chatterCfg.near;
    const nearAll = (a, b, c) => dist2(a, b) <= NEAR * 1.27 && dist2(b, c) <= NEAR * 1.27 && dist2(a, c) <= NEAR * 1.27;
    if (idle.length === 3 && nearAll(idle[0], idle[1], idle[2])) {
      startChatter(idle);
      return;
    }
    let best = null, bestD = NEAR;
    for (let i = 0; i < idle.length; i++) for (let j = i + 1; j < idle.length; j++) {
      const d = dist2(idle[i], idle[j]);
      if (d <= bestD) { bestD = d; best = [idle[i], idle[j]]; }
    }
    if (best) startChatter(best);
    scheduleChatterCheck();
  }
  function faceTo(role, target) {
    const c = idols[role], t = idols[target];
    if (!c || !t) return;
    const dir = t.container.x >= c.container.x ? 1 : -1;
    if (c.dir !== dir) { c.dir = dir; setComboSkin(role, dir); }
  }
  async function startChatter(roles) {
    chatter.active = true;
    chatter.roles = roles.slice();
    // 相向而立（面对面）+ 收起走路/姿势
    for (const r of chatter.roles) {
      const c = idols[r];
      if (c.walkTween) { c.walkTween = null; c.walking = false; }
      if (clearFaceTimers[r]) { clearTimeout(clearFaceTimers[r]); clearFaceTimers[r] = null; }
      if (bubbleLock && bubbleRole === r) bubbleLock = false;
      c.poseId = 0;
      c.state.setAnimation(0, '动作_待机', true);
      c.state.setAnimation(1, '表情_常态', true);
    }
    for (let i = 1; i < chatter.roles.length; i++) faceTo(chatter.roles[i], chatter.roles[0]);
    const lines = await generateChatterLines(chatter.roles);
    if (!chatter.active) return;
    if (!lines) {
      console.log('[CHATTER] 生成对话失败 roles=', chatter.roles.join(','), 'cfg=', JSON.stringify({ apiKey: !!aiCfg.apiKey, webSearch: aiCfg.webSearch, model: aiCfg.model }));
      stopChatter();
      return;
    }
    chatter.lines = lines;
    chatter.idx = 0;
    showNextChatterLine();
  }
  async function generateChatterLines(roles) {
    // 场景组装（chatter-engine.js：人设+近况记忆+60%新话题）
    let sys = null;
    try {
      sys = CE.buildScenePrompt(roles, personas, personaLabel, (r) => dk.readChatHistory(r), CE.freshTopicBias());
    } catch (e) {
      console.log('[CHATTER] buildScenePrompt 异常:', e && e.message);
      return null;
    }
    try {
      // 互聊生成：强制非联网（小偶像之间的日常闲聊不需要搜索）
      const res = await AI.request(dk, aiCfg, roles[0], [
        { role: 'system', content: sys },
        { role: 'user', content: '请生成以上角色们的一段日常闲聊。' }
      ], false);
      if (!res || !res.ok) { console.log('[CHATTER] API 失败:', res && (res.error || 'no content')); return null; }
      const out = CE.parseSceneReply(res.content, roles, Math.min(chatterCfg.lines, CHATTER_CFG.LINE_MAX), personaLabel);
      if (!out) console.log('[CHATTER] 解析失败，原始回复前200字:', String(res.content).slice(0, 200));
      return out;
    } catch (e) { console.log('[CHATTER] 请求异常:', e && e.message); return null; }
  }
  function showNextChatterLine() {
    if (!chatter.active) return;
    if (chatter.idx >= chatter.lines.length) { stopChatter(); return; }
    const line = chatter.lines[chatter.idx++];
    if (line.mood) applyMoodPose(line.role, line.mood);            // 说者情绪动作
    for (const r of chatter.roles) if (r !== line.role) faceTo(r, line.role);   // 听众面向说者
    showBubbleTyping(line.text, 2600, line.role);                   // 头顶气泡演出
    chatter.showTimer = setTimeout(showNextChatterLine, 2200 + line.text.length * 45);
  }
  scheduleChatterCheck();
  loadChatterCfg();   // 互聊配置（右键菜单"互聊"设置面板，改即保存生效）

  // ================= 桌面版穿透 =================
  let mouseOverUi = null;
  let lastMouse = { x: -1, y: -1 };   // 最近一次鼠标位置（用于显隐事件后主动刷新穿透判定）
  function refreshMouseIgnore() {
    if (lastMouse.x < 0) return;
    let inside = false;
    for (const el of [sizePanel, freqPanel, volPanel, musicPanel, ctxMenu, cpEl, bcEl, bcHist, chatterPanel]) {
      if (!el || el.style.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (lastMouse.x >= r.left - 4 && lastMouse.x <= r.right + 4 &&
          lastMouse.y >= r.top - 4 && lastMouse.y <= r.bottom + 4) { inside = true; break; }
    }
    if (!inside && dialog.open) {
      const r = dEl.getBoundingClientRect();
      inside = lastMouse.x >= r.left - 4 && lastMouse.x <= r.right + 4 &&
               lastMouse.y >= r.top - 4 && lastMouse.y <= r.bottom + 4;
    }
    if (!inside) inside = !!hitIdol(lastMouse.x, lastMouse.y);
    if (inside !== mouseOverUi) {
      mouseOverUi = inside;
      dk.setMouseIgnore(!inside);
    }
    return inside;
  }
  window.addEventListener('mousemove', (e) => {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
    refreshMouseIgnore();
  });

  // ================= 主循环 =================
  let lastTime = 0;
  let frameCount = 0;
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.style.cssText = 'position:fixed;left:8px;top:8px;color:#000;background:rgba(255,255,255,.92);font:12px monospace;padding:4px 8px;z-index:99;white-space:pre;';
  if (!new URLSearchParams(location.search).has('hud')) hud.style.display = 'none';
  document.body.appendChild(hud);
  function updateHud() {
    const lines = ['f=' + frameCount + ' mode=' + freq.dialogMode + ' view=' + viewW + 'x' + viewH + '@' + dpr + ' grav=' + gravityOn];
    for (const key of ROLE_KEYS) {
      const c = idols[key];
      const t0 = c.state.tracks[0];
      lines.push(`${key}: ${c.container.x.toFixed(0)},${c.container.y.toFixed(0)} dir=${c.dir} walk=${c.walking}` +
        ` pose=${c.poseId} hid=${c.hidden ? 1 : 0} fz=${chatFrozen[key] ? 1 : 0} t0=${t0 ? t0.animation.name + '@' + t0.trackTime.toFixed(2) : '-'}`);
    }
    hud.textContent = lines.join('\n');
  }
  function frame(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
    lastTime = now;
    frameCount++;

    // 每帧先透明清屏：全部角色隐藏/无绘制时，表面必须立即变透明（否则最后一只的
    // 画面会"卡"在桌面上——WebGL 无 draw 时合成器不重绘，残留最后一个绘制帧）
    gfx.clear(0, 0, 0, 0);

    for (const key of ROLE_KEYS) {
      const c = idols[key];
      if (c.hidden) continue;   // 隐藏（休息）：不渲染/不更新/不物理
      if (c.walkTween) {
        const k = (now - c.walkTween.start) / c.walkTween.dur;
        if (k >= 1) { c.walkTween.update(1); c.walkTween.done(); }
        else c.walkTween.update(k);
      }
      // 重力物理步进（拖动中的角色跳过，跟随光标；走路中跳过——走动即贴地移动，避免与物理拉扯打架）
      if (gravityOn && !(drag.on && drag.key === key) && !c.walkTween) {
        const busy = idolPhysicallyBusy(key);
        if (c.physWasBusy && !busy) clearIdolFace(key);   // 落地停稳：恢复正常待机
        c.physWasBusy = busy;
        stepGravity(key, dt);
      }
      c.state.update(dt);
      c.state.apply(c.skeleton);
      c.skeleton.update(dt);
      c.skeleton.updateWorldTransform(spine.Physics.update);
      const m = buildMVP(key);
      gfx.draw(c.skeleton, m);
    }

    placePopover();
    positionBubbleChat();   // 气泡聊天：输入框跟随角色
    if (frameCount % 10 === 0) updateHud();
    requestAnimationFrame(frame);
  }

  // ================= 启动 =================
  async function boot() {
    // 三角色素材
    for (const key of ROLE_KEYS) {
      const { data } = await loadIdolAssets(ROLES[key]);
      initIdol(key, data);
    }

    // 尺寸记忆（桌面版）
    S.loadScales(scales, ROLE_KEYS);

    // 初始站位（下沿分布：22% / 50% / 78%）
    resize();
    for (const key of ROLE_KEYS) {
      const c = idols[key];
      const footUp = viewH * 0.16 - 14;
      c.container.x = viewW * ROLES[key].deskX;
      c.container.y = footUp;
      ROLES[key].waypoints = [
        { x: Math.max(60, c.container.x - 110), y: footUp, dir: -1 },
        { x: Math.min(viewW - 60, c.container.x + 150), y: footUp, dir: 1 }
      ];
    }

    // 交互 & 键盘
    // 浮动 UI 聚焦置顶：点击哪个面板/菜单/对话框，哪个就到最前
    for (const el of [sizePanel, freqPanel, volPanel, musicPanel, ctxMenu, dEl, cpEl, bcEl, bcHist, chatterPanel]) {
      el.addEventListener('mousedown', () => bringToFront(el));
    }
    dk.onInteract(() => { const key = hitIdol(lastCtx.x, lastCtx.y) || 'qianxia'; interact(key); });
    dk.onTrainEvent(() => openTrainDialog('qianxia'));
    dk.onSizePanel(() => showSizePanel());
    dk.onFreqPanel(() => showFreqPanel());
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (dialog.open) closeDialog();   // Esc 仅关闭对话，不退出程序（退出走右键/托盘菜单）
    });

    // 资源
    try { i18n = JSON.parse(dk.readText('i18n.json')); } catch (e) { i18n = {}; }
    try { dialogData = JSON.parse(dk.readText('train_dialog.json')); } catch (e) { dialogData = { roles: {} }; }

    // 测试模式
    const qs = new URLSearchParams(location.search);
    const testAnim = qs.get('anim0') || dk.env('QX_ANIM0');
    if (!testAnim) {
      loadFreq();
      scheduleMove();
      scheduleBubbleTimer();
    } else {
      const key = qs.get('who') || dk.env('QX_WHO') || 'qianxia';
      const c = idols[key];
      c.state.setAnimation(0, testAnim, true);
      if (qs.get('anim1') || dk.env('QX_ANIM1')) c.state.setAnimation(1, qs.get('anim1') || dk.env('QX_ANIM1'), true);
    }

    requestAnimationFrame(frame);
    // 启动音（首次渲染完成 ~400ms 后）
    setTimeout(() => playSfxFile(AUDIO_FILES.boot), 400);
    // 恢复上次的 BGM 播放状态（bgmOn 记忆为开时自动继续播放，与播放器按钮状态一致）
    if (audioCfg.bgmOn) startBgm();
    // 调试：QX_AUDIO_TEST=1 自动播放首个 m4a（验证新导入曲目/m4a 解码）
    if (dk.env('QX_AUDIO_TEST') === '1') {
      setTimeout(() => {
        const mi = BGM_FILES.findIndex((f) => /\.m4a$/i.test(f));
        audioCfg.bgmIdx = mi >= 0 ? mi : BGM_FILES.length - 1;
        audioCfg.bgmOn = true;
        startBgm();
        console.log('[BGM-TEST] play', BGM_FILES[audioCfg.bgmIdx]);
      }, 1500);
    }
    setTimeout(() => {
      const key = 'qianxia';
      const cfg = ROLES[key];
      const msg = pickMessage('interact', cfg.i18nId);
      if (msg) {
        const seq = parseInt(msg.split('_')[2], 10);
        const poseId = cfg.messageMap[seq - 1];
        changeFace(key, poseId);
        showBubble(dkReadI18n(msg), animDurMs(key, cfg.posTable[poseId].name), key);
      }
    }, 800);

    // debug 入口
    if (dk.env('QX_CHATTEST') === '1') {
      setTimeout(() => { startChatter(['qianxia', 'nangong']); }, 2000);
    }
    if (dk.env('QX_EDITTEST') === '1') {
      setTimeout(() => {
        aiCfg.chatMode = 'panel';
        openChatPanel('qianxia');
        cpInput.value = '第一条测试消息';
        sendChat();
      }, 1200);
      setTimeout(() => {
        const idx = chat.messages.map((m) => m.role).lastIndexOf('user');
        console.log('[EDITTEST] startEdit idx=', idx, 'children=', cpBody.children.length);
        startEditMsg(idx);
      }, 4500);
      setTimeout(() => {
        const ta = cpBody.querySelector('.cp-edit');
        console.log('[EDITTEST] textarea found=', !!ta);
        if (ta) {
          ta.value = '改过的消息';
          ta.focus();
          document.activeElement === ta
            ? console.log('[EDITTEST] focus OK')
            : console.log('[EDITTEST] FOCUS FAILED active=', document.activeElement && document.activeElement.className);
        }
      }, 5000);
    }
    if (dk.env('QX_WEBTEST') === '1') {
      setTimeout(() => {
        aiCfg.chatMode = 'panel';
        openChatPanel('qianxia');
        cpInput.value = '千夏，你们的出道曲是什么来着？人家现在有点头晕，不太记得了';
        sendChat();   // 真实请求（联网模式，web_search）
      }, 1200);
    }
    if (dk.env('QX_BUBBLETEST')) {
      setTimeout(() => {
        const c = idols.qianxia;
        const m = dk.env('QX_BUBBLETEST');
        c.container.y = (m === 'top' || m === 'topright') ? viewH - 130 : viewH * 0.5;
        c.container.x = (m === 'left') ? 100 : ((m === 'right' || m === 'topright') ? viewW - 100 : viewW * 0.5);
        aiCfg.chatMode = 'bubble';
        openChatPanel('qianxia');
        bcInput.value = '测试边缘气泡';
        sendChat();
      }, 1000);
    }
    if (dk.env('QX_CHAT_SWITCH') === '1') {
      // 模拟"打开千夏 → 覆盖打开南宫 → 关闭"（验证被覆盖角色恢复待机）
      setTimeout(() => openChatPanel('qianxia'), 1200);
      setTimeout(() => openChatPanel('nangong'), 2000);
      setTimeout(() => closeChatPanel(), 2600);
    }
    if (dk.env('QX_CHAT') === '1') {
      setTimeout(() => {
        if (dk.env('QX_CHAT_BUBBLE') === '1') aiCfg.chatMode = 'bubble';
        openChatPanel('qianxia');
        (aiCfg.chatMode === 'bubble' ? bcInput : cpInput).value = '店长今天也辛苦了！';
        sendChat();
        // 二次发送（验证"再次发送→气泡重置为...然后打字覆盖"）
        if (dk.env('QX_CHAT_SEND2') === '1') {
          setTimeout(() => { (aiCfg.chatMode === 'bubble' ? bcInput : cpInput).value = '再来一次！'; sendChat(); }, 3000);
        }
      }, 1200);
    }
    if (dk.env('QX_DIALOG') === '1') setTimeout(() => openTrainDialog(dk.env('QX_DIALOG_ROLE') || 'qianxia'), 600);
    if (dk.env('QX_SIZEPANEL') === '1') setTimeout(showSizePanel, 800);
    if (dk.env('QX_FREQPANEL') === '1') setTimeout(showFreqPanel, 800);
    if (dk.env('QX_VOLPANEL') === '1') setTimeout(showVolPanel, 800);
    if (dk.env('QX_MUSICPANEL') === '1') setTimeout(showMusicPanel, 800);
    if (dk.env('QX_CTX') === '1') setTimeout(() => showCtxMenu(viewW * 0.55, viewH * 0.55), 900);
  }

  boot().catch((e) => {
    console.error(e);
    const hudEl = document.getElementById('hud');
    if (hudEl) hudEl.textContent = '初始化失败: ' + e.message;
  });
})();
