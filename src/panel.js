// 控制面板逻辑：三小只开关（联动主窗口）+ 对话配置（DeepSeek AI 聊天）；叉掉=隐藏到托盘
(function () {
  'use strict';
  const dk = window.deskpet;
  const ROLES = [
    { key: 'airui', name: '爱芮', img: 'panel_airui.png' },
    { key: 'nangong', name: '南宫', img: 'panel_nangong.png' },
    { key: 'qianxia', name: '千夏', img: 'panel_qianxia.png' }
  ];
  const state = { airui: true, qianxia: true, nangong: true };
  const KEYS = ['airui', 'nangong', 'qianxia'];

  // ================= 悬浮说明（全局委托） =================
  // 用法：给任意元素加 data-tip="说明文字"（换行用 &#10;）即可。
  // 放在 fixed 层并夹在视口内，避免被各页面的 overflow 容器裁掉。
  const tipEl = document.getElementById('tip');
  let tipTarget = null;
  function showTip(target) {
    if (!tipEl) return;
    const txt = target.getAttribute('data-tip');
    if (!txt) return;
    tipTarget = target;
    tipEl.textContent = txt;
    tipEl.style.display = 'block';
    const r = target.getBoundingClientRect();
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    let y = r.top - th - 9;
    if (y < 8) y = r.bottom + 9;
    if (x < 8) x = 8;
    if (x + tw > window.innerWidth - 8) x = window.innerWidth - 8 - tw;
    tipEl.style.left = Math.round(x) + 'px';
    tipEl.style.top = Math.round(y) + 'px';
  }
  function hideTip() { tipTarget = null; if (tipEl) tipEl.style.display = 'none'; }
  document.addEventListener('mouseover', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t) { hideTip(); return; }
    if (t !== tipTarget) showTip(t);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t && t === tipTarget) hideTip();
  });
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('scroll', hideTip, true);
  window.addEventListener('blur', hideTip);

  // ================= 视图切换（主页 / 对话配置 / 语音 / 设置 / 控制台） =================
  // 「设置」与「语音」共用同一个滚动容器，靠卡片上的 data-page 决定显示哪些卡片，
  // 这样加页面不用把大段 HTML 搬来搬去，也不会出现两个滚动条。
  const viewHome = document.getElementById('view-home');
  const viewAi = document.getElementById('view-ai');
  const viewSettings = document.getElementById('view-settings');
  const viewConsole = document.getElementById('view-console');
  const btnHome = document.getElementById('btn-home');
  const btnAi = document.getElementById('btn-ai');
  const btnVoice = document.getElementById('btn-voice');
  const btnSettings = document.getElementById('btn-settings');
  const btnKeys = document.getElementById('btn-keys');
  const btnConsole = document.getElementById('btn-console');
  const tTitle = document.getElementById('t-title');
  const tSub = document.getElementById('t-sub');
  let currentView = 'home';
  const VIEW_META = {
    home: ['🎀 妄想天使 · 主页', '分别控制三小只的桌宠开关（关掉后她会去休息哦～）'],
    ai: ['💬 妄想天使 · 对话配置', 'DeepSeek AI 聊天设置（三小只会按各自人设和你聊天～）'],
    voice: ['🎙 妄想天使 · 语音合成', '本地 TTS：推理环境、语音包与朗读设置'],
    settings: ['⚙ 妄想天使 · 设置', '版本、显示兼容、多显示器与性能选项'],
    keys: ['⌨ 妄想天使 · 快捷键', '自定义桌宠的全局快捷键——改完即时生效，不用重启'],
    console: ['🖥 妄想天使 · 控制台', '运行状态、系统信息、日志与诊断——排查问题要的东西都在这儿']
  };
  function applyPageFilter(page) {
    // 'settings' / 'voice' 共用容器：按 data-page 显示对应卡片
    const cards = viewSettings ? viewSettings.querySelectorAll('.ai-card[data-page]') : [];
    for (let i = 0; i < cards.length; i++) {
      cards[i].style.display = (cards[i].getAttribute('data-page') === page) ? '' : 'none';
    }
    if (viewSettings) viewSettings.scrollTop = 0;
  }
  // view: 'home' | 'ai' | 'voice' | 'settings' | 'console'
  function showView(view) {
    // 离开当前页时，若这一页**真的有**未保存改动 → 才询问（没改就静默通过，不再打扰）
    if (view !== currentView) confirmSaveIfDirty();
    currentView = view;
    // 注意：主页的居中排版是靠 CSS 的 display:flex 实现的 —— 这里必须用空串（清除内联样式），
    // 写成 'block' 会把 flex 覆盖掉，导致"切走再切回来，三张卡片从居中跑到顶部"（用户实测反馈）。
    viewHome.style.display = view === 'home' ? '' : 'none';
    viewAi.style.display = view === 'ai' ? 'block' : 'none';
    const shared = (view === 'settings' || view === 'voice' || view === 'keys');
    if (viewSettings) viewSettings.style.display = shared ? 'block' : 'none';
    if (viewConsole) viewConsole.style.display = view === 'console' ? 'block' : 'none';
    if (shared) applyPageFilter(view);
    btnHome.classList.toggle('active', view === 'home');
    btnAi.classList.toggle('active', view === 'ai');
    if (btnVoice) btnVoice.classList.toggle('active', view === 'voice');
    if (btnSettings) btnSettings.classList.toggle('active', view === 'settings');
    if (btnKeys) btnKeys.classList.toggle('active', view === 'keys');
    if (view === 'keys') renderKeys();   // 每次进入都按主进程的真实注册状态重画
    if (btnConsole) btnConsole.classList.toggle('active', view === 'console');
    const meta = VIEW_META[view] || VIEW_META.home;
    tTitle.textContent = meta[0];
    tSub.textContent = meta[1];
    const v = view === 'ai' ? viewAi
      : (view === 'console' ? viewConsole
        : (shared ? viewSettings : viewHome));
    if (v) { v.classList.remove('view-swap'); void v.offsetWidth; v.classList.add('view-swap'); }
    if (view === 'console') { refreshConsole(); setConsoleMode(consoleMode); }
    else stopTerm();   // 离开控制台页 → 停掉终端轮询
    if (view === 'voice') { refreshTts(); startTtsPoll(); }   // 语音页：状态自动实时刷新
    else stopTtsPoll();
    updateSaveFab();   // 悬浮保存按钮只在该页真的有改动时出现
  }
  btnHome.addEventListener('click', () => showView('home'));
  btnAi.addEventListener('click', () => showView('ai'));
  if (btnVoice) btnVoice.addEventListener('click', () => showView('voice'));
  if (btnSettings) btnSettings.addEventListener('click', () => showView('settings'));
  if (btnKeys) btnKeys.addEventListener('click', () => showView('keys'));
  // 「控制台」按钮是双态的：第一次进来是信息页；再点一次 → 丝滑切到终端页；再点 → 切回信息页
  if (btnConsole) {
    btnConsole.addEventListener('click', () => {
      if (currentView !== 'console') { showView('console'); setConsoleMode('info'); return; }
      setConsoleMode(consoleMode === 'info' ? 'term' : 'info');
    });
  }
  applyPageFilter('settings');   // 初始：设置页只显示 settings 组卡片
  // ===== 未保存状态 =====
  // 以前是"任何控件动一下就算脏"，导致用户根本没改东西、离开页面也被问要不要保存。
  // 现在改成**快照对比**：拿"上次保存时的表单值"和当前值比，真不一样才算脏。
  // 只有「语音」和「对话配置」两页有需要保存的东西；设置页的开关都是即时生效的。
  let ttsSnap = null;   // 上次保存/加载时的 TTS 表单快照
  let ttsFormReady = false;   // 表单是否已经回填过一次（首次必须回填）
  let aiSnap = null;    // 上次保存/加载时的 AI 配置快照
  const fabSave = document.getElementById('fab-save');
  function ttsSnapNow() {
    try { return JSON.stringify(ttsCollect()); } catch (e) { return ttsSnap; }
  }
  function isDirty(page) {
    try {
      if (page === 'voice') return ttsSnap !== null && ttsSnapNow() !== ttsSnap;
      if (page === 'ai') return aiSnap !== null && JSON.stringify(cfg) !== aiSnap;
    } catch (e) { /* 值还没准备好就当作不脏 */ }
    return false;
  }
  function updateSaveFab() {
    if (!fabSave) return;
    fabSave.classList.toggle('show', isDirty(currentView));
  }
  // 「取消」= 放弃本次修改：把表单回滚成"上次保存的值"。
  // 以前这里什么都不做 —— 表单留着被放弃的值、快照还是旧值，页面就永久停在"脏"状态，
  // 用户切回来会看到一个改不掉也用不上的残留值（实测反馈）。
  let ttsForceFill = false;   // 让下一次 renderTts 强制回填（绕过"有改动就不覆盖"的保护）
  function discardPageChanges(page) {
    if (page === 'voice') {
      ttsForceFill = true;
      try { refreshTts(); } catch (e) { /* noop */ }
    } else if (page === 'ai') {
      try {
        cfg = Object.assign({}, DEFAULTS);
        loadCfg();
        fillForm();
        aiSnap = JSON.stringify(cfg);
      } catch (e) { /* noop */ }
    }
  }
  async function saveCurrentPage() {
    if (currentView === 'voice') {
      await ttsSave();
    } else if (currentView === 'ai') {
      try {
        readForm();
        saveCfg();
        aiSnap = JSON.stringify(cfg);
        if (elRslt) { elRslt.className = 'ok'; elRslt.textContent = '✅ 配置已保存并立即生效'; }
      } catch (e) { /* noop */ }
    }
    if (fabSave) {
      fabSave.classList.add('done');
      setTimeout(() => fabSave.classList.remove('done'), 900);
    }
    updateSaveFab();
  }
  if (fabSave) fabSave.addEventListener('click', (e) => { e.stopPropagation(); saveCurrentPage(); });
  function confirmSaveIfDirty() {
    if (!isDirty(currentView)) return true;   // 没真改动 → 静默通过，不再打扰
    const page = currentView;
    const yes = confirm('当前页面有修改尚未保存，是否保存？\n\n「确定」= 立即保存并应用\n「取消」= 放弃本次修改（回到上次保存的值）');
    if (yes) { saveCurrentPage(); }
    else { discardPageChanges(page); }   // 取消 = 真的放弃，把表单回滚干净
    updateSaveFab();
    return true;
  }
  // ================= 设置页：最大帧率（限制桌宠渲染帧率，默认 60） =================
  const elMaxFps = document.getElementById('set-maxfps');
  const elMaxFpsVal = document.getElementById('set-maxfps-val');
  const FPS_MIN = 15, FPS_MAX = 144;
  function loadMaxFps() {
    let v = 60;
    try { v = parseInt(localStorage.getItem('QX_MAXFPS'), 10) || 60; } catch (e) { /* noop */ }
    v = Math.min(FPS_MAX, Math.max(FPS_MIN, v));
    if (elMaxFps) elMaxFps.value = v;
    if (elMaxFpsVal) elMaxFpsVal.textContent = v + ' fps';
    return v;
  }
  function saveMaxFps(v) {
    v = Math.min(FPS_MAX, Math.max(FPS_MIN, v));
    try { localStorage.setItem('QX_MAXFPS', String(v)); } catch (e) { /* noop */ }
    try { dk.setMaxFps(v); } catch (e) { /* noop */ }   // 主进程广播 → 桌宠立即应用
    if (elMaxFpsVal) elMaxFpsVal.textContent = v + ' fps';
  }
  loadMaxFps();
  if (elMaxFps) {
    elMaxFps.addEventListener('input', () => {
      if (elMaxFpsVal) elMaxFpsVal.textContent = elMaxFps.value + ' fps';
    });
    elMaxFps.addEventListener('change', () => saveMaxFps(parseInt(elMaxFps.value, 10) || 60));
  }
  document.querySelectorAll('#set-fps-presets .fps-preset').forEach((el) => {
    el.addEventListener('click', () => {
      const v = parseInt(el.getAttribute('data-fps'), 10) || 60;
      if (elMaxFps) elMaxFps.value = v;
      saveMaxFps(v);
    });
  });

  // ================= 设置页：语音（TTS） =================
  const ttsEl = (id) => document.getElementById(id);
  const ROLE_LIST = ['airui', 'qianxia', 'nangong'];
  let lastTtsStatus = null;   // 最近一次状态（用于"是否已安装"等交互判断）
  function renderTts(s) {
    if (!s) return;
    lastTtsStatus = s;
    const c = s.config || {};
    const ins = s.installed || {};
    const rt = s.runtime || {};
    const kvSet = (id, text, cls) => {
      const e = ttsEl(id);
      if (!e) return;
      e.textContent = text;
      e.className = cls || '';
    };
    // ---- 状态卡（实时）：服务 / 设备 / 推理环境 / 语音包 ----
    const stateMap = {
      running: ['🟢 运行中', 'ok'],
      starting: ['🟡 启动中（加载模型 1~3 分钟）', ''],
      disabled: ['⚪ 已关闭（总开关未启用）', ''],
      stopped: ['⚪ 未运行', '']
    };
    const st = stateMap[s.serviceState] || ['未知', ''];
    kvSet('ts-service', st[0], st[1]);
    kvSet('ts-device', (c.device === 'cpu' ? 'CPU（省显存）' : 'GPU / cuda（快）'));
    kvSet('ts-runtime',
      rt.installed ? ('✅ 已安装（' + (rt.source || '') + '）') : '⚠ 未安装',
      rt.installed ? 'ok' : 'warn');
    const voiceTxt = ROLE_LIST.map((r) => ({ airui: '爱芮', qianxia: '千夏', nangong: '南宫羽' }[r] + ((ins.voices && ins.voices[r]) ? '✓' : '✗'))).join('　');
    kvSet('ts-voices', voiceTxt, s.hasVoices ? 'ok' : 'warn');
    // 运行时/脚本/语音包目录三个输入框右侧的存在性标记（一眼看出路径对不对）
    const flag = (id, ok, missing) => {
      const e = ttsEl(id);
      if (!e) return;
      e.textContent = ok ? '✅' : '⚠';
      e.style.color = ok ? '#2e9e6b' : '#c05050';
      e.title = ok ? '文件存在' : missing;
    };
    const py = c.runtimePath || '';
    const sc = c.serverScript || '';
    const pyOk = !!(rt.checked && rt.checked.some((x) => x.pythonOk && x.python === py)) || (rt.installed && rt.python === py);
    const scOk = !!(rt.checked && rt.checked.some((x) => x.scriptOk && x.script === sc)) || (rt.installed && rt.script === sc);
    if (py || sc) {
      flag('tts-runtime-flag', pyOk && !!py, '找不到这个文件 —— 检查路径是否写对、文件是否被移动');
      flag('tts-script-flag', scOk && !!sc, '找不到这个文件 —— 检查路径是否写对、文件是否被移动');
    } else {
      flag('tts-runtime-flag', rt.installed, '还没配置，也没在托管目录里找到推理环境');
      flag('tts-script-flag', rt.installed, '还没配置，也没在托管目录里找到服务脚本');
    }
    flag('tts-voices-flag', !!s.hasVoices, '没有找到语音包，请到「下载与安装」里下载');
    // 额外提示：错误信息 / 未启用 / 未安装
    const extra = ttsEl('ts-extra');
    if (extra) {
      const msgs = [];
      if (!c.enabled) msgs.push('语音总开关未启用 —— 勾选上面的「启用语音」并点右下角保存。');
      else if (!rt.installed) msgs.push('推理环境未安装：可以在「下载与安装」里一键下载，或直接在上面填好已有的路径。');
      if (s.lastError) {
        // 连接失败对普通用户太吓人：正文给友好文案，原始错误收进悬浮说明
        if (s.serviceState === 'starting') msgs.push('⚠ 服务还在启动中（加载模型约 1~3 分钟），稍等一会儿会自动刷新。');
        else msgs.push('⚠ 语音服务当前没有响应 —— 点「启动服务」即可（首次加载模型约 1~3 分钟）。');
        extra.setAttribute('data-tip', '原始错误：' + s.lastError);
      } else {
        extra.removeAttribute('data-tip');
      }
      extra.textContent = msgs.join('\n');
      extra.style.whiteSpace = 'pre-wrap';
    }
    if (ttsEl('tts-install')) ttsEl('tts-install').style.display = ins.runtime ? 'none' : '';
    if (ttsEl('tts-reinstall')) ttsEl('tts-reinstall').style.display = ins.runtime ? '' : 'none';
    document.querySelectorAll('.tts-voice-btn').forEach((b) => {
      const role = b.dataset.role;
      const base = { airui: '爱芮', qianxia: '千夏', nangong: '南宫羽' }[role] || role;
      const has = !!(ins.voices && ins.voices[role]);
      if (!b.disabled) b.textContent = (has ? '✅ ' : '') + base;
    });
    // 表单回填的守卫：只有"首次"或"当前没有未保存改动"时才回填，
    // 否则实时轮询会把用户正在输入的内容冲掉（这是 TTS 面板的老毛病）。
    const allowFill = ttsForceFill || !ttsFormReady || !isDirty('voice');
    if (allowFill) {
    ttsForceFill = false;   // 只用一次    if (ttsEl('tts-enabled')) ttsEl('tts-enabled').checked = !!c.enabled;
    if (ttsEl('tts-runtime')) ttsEl('tts-runtime').value = c.runtimePath || '';
    if (ttsEl('tts-script')) ttsEl('tts-script').value = c.serverScript || '';
    if (ttsEl('tts-idle')) ttsEl('tts-idle').value = c.idleUnloadSec || 300;
    if (ttsEl('tts-on-chat')) ttsEl('tts-on-chat').checked = !!(c.speakOn && c.speakOn.chat);
    if (ttsEl('tts-on-bubble')) ttsEl('tts-on-bubble').checked = !!(c.speakOn && c.speakOn.bubble);
    if (ttsEl('tts-on-chatter')) ttsEl('tts-on-chatter').checked = !!(c.speakOn && c.speakOn.chatter);
    if (ttsEl('tts-by-role')) ttsEl('tts-by-role').checked = c.saveByRole !== false && !!c.saveByRole;
    document.querySelectorAll('#tts-device .tts-device-btn').forEach((b) => b.classList.toggle('pink', b.dataset.device === (c.device || 'cuda')));
    document.querySelectorAll('#tts-mirror .tts-mirror-btn').forEach((b) => b.classList.toggle('pink', b.dataset.mirror === (c.mirror || 'official')));
    if (ttsEl('tts-repo')) ttsEl('tts-repo').value = c.repoUrl || '';
    if (ttsEl('tts-mirror-custom')) ttsEl('tts-mirror-custom').value = c.mirrorCustom || '';
    if (ttsEl('tts-voices-dir')) ttsEl('tts-voices-dir').value = c.voicesDir || '';
    // 高级请求参数也必须在这块里回填 —— 它在 ttsCollect 里会被解析并合并进补丁，
    // 如果回填晚于快照，基准快照就会缺这几个字段，导致面板永远显示"有未保存改动"。
    if (ttsEl('tts-adv')) {
      try {
        ttsEl('tts-adv').value = JSON.stringify({
          apiPath: c.apiPath, params: c.params, extraBody: c.extraBody,
          refFields: c.refFields, refMode: c.refMode, healthPath: c.healthPath
        }, null, 1);
      } catch (e) { /* noop */ }
    }
    ttsFormReady = true;
    ttsSnap = ttsSnapNow();      // 刚刚按"已保存的值"回填过 → 这就是基准快照
    }
    const startBtn = ttsEl('tts-start');
    const stopBtn = ttsEl('tts-stop');
    const busy = (s.serviceState === 'running' || s.serviceState === 'starting');
    if (startBtn) { startBtn.disabled = busy; startBtn.style.opacity = busy ? '.45' : ''; startBtn.title = busy ? '服务已在运行' : '启动桌宠自带的 TTS 服务（首次加载模型约 1~3 分钟）'; }
    if (stopBtn) { stopBtn.disabled = !busy; stopBtn.style.opacity = busy ? '' : '.45'; stopBtn.title = busy ? '停止服务（释放显存/内存）' : '服务未运行'; }
    updateSaveFab();
  }
  async function refreshTts() { try { renderTts(await dk.ttsStatus()); } catch (e) { /* noop */ } }
  try { dk.onTtsStatus(renderTts); } catch (e) { /* noop */ }
  // 实时刷新：只在语音页可见时轮询（服务状态会自己变，比如"启动中"→"运行中"）
  let ttsTimer = null;
  function startTtsPoll() { stopTtsPoll(); ttsTimer = setInterval(refreshTts, 3000); }
  function stopTtsPoll() { if (ttsTimer) { clearInterval(ttsTimer); ttsTimer = null; } }  refreshTts();
  document.querySelectorAll('#tts-device .tts-device-btn').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tts-device .tts-device-btn').forEach((x) => x.classList.toggle('pink', x === b));
  }));
  document.querySelectorAll('#tts-mirror .tts-mirror-btn').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tts-mirror .tts-mirror-btn').forEach((x) => x.classList.toggle('pink', x === b));
    previewUrls();
  }));
  if (ttsEl('tts-mirror-custom')) ttsEl('tts-mirror-custom').addEventListener('change', previewUrls);
  if (ttsEl('tts-repo')) ttsEl('tts-repo').addEventListener('change', previewUrls);
  // ===== 下载源可用性检测：一键把所有镜像都测一遍，延迟直接标在按钮上 =====
  if (ttsEl('tts-check-mirrors')) ttsEl('tts-check-mirrors').addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const btn = ttsEl('tts-check-mirrors');
    const msg = ttsEl('mirror-check-msg');
    const btns = Array.from(document.querySelectorAll('.tts-mirror-btn'));
    const clearMarks = () => btns.forEach((b) => {
      b.classList.remove('mirror-ok', 'mirror-bad');
      const s = b.querySelector('.mirror-ms');
      if (s) s.remove();
    });
    clearMarks();
    const old = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '⏳ 检测中…'; btn.disabled = true; }
    if (msg) { msg.style.color = ''; msg.textContent = '正在并发测试各个下载源（最多 8 秒）…'; }
    try {
      const r = await dk.ttsCheckMirrors(ttsCollect());
      if (!r || !r.ok) {
        if (msg) { msg.style.color = '#c05050'; msg.textContent = '⚠ ' + ((r && r.error) || '检测失败'); }
        return;
      }
      const map = {};
      (r.results || []).forEach((x) => { map[x.id] = x; });
      btns.forEach((b) => {
        const id = b.dataset.mirror;
        const info = map[id];
        if (!info) return;
        if (info.ok) {
          b.classList.add('mirror-ok');
          const s = document.createElement('span');
          s.className = 'mirror-ms';
          s.textContent = info.ms + 'ms';
          b.appendChild(s);
        } else {
          b.classList.add('mirror-bad');
          b.title = '不可用：' + (info.error || ('HTTP ' + info.status));
        }
      });
      const okList = (r.results || []).filter((x) => x.ok);
      if (msg) {
        // 成功时不写总结文字 —— 每个按钮上的绿框 + 延迟已经一目了然，多一行反而啰嗦。
        // 只有"全军覆没"才需要文字提示（否则用户只看到一片灰，不知道发生了什么）。
        if (!okList.length) {
          msg.style.color = '#c05050';
          msg.textContent = '⚠ 所有下载源都不可用 —— 检查网络/代理，或稍后重试。';
        } else {
          msg.textContent = '';
        }
      }
    } catch (e) {
      if (msg) { msg.style.color = '#c05050'; msg.textContent = '⚠ 检测失败：' + ((e && e.message) || ''); }
    } finally {
      if (btn) { btn.textContent = old || '📶 检测可用性'; btn.disabled = false; }
    }
  });
  // 显示将要下载的地址（用户一眼可见，无需手输）
  // 注意：这里**不能**先保存配置来取 URL —— 那会让"点一下下载源"变成一次静默保存。
  // 改成把当前表单值当作临时参数传给主进程，只算不存。
  async function previewUrls() {
    const box = ttsEl('tts-url-preview');
    if (!box) return;
    try {
      const u = await dk.ttsUrls(ttsCollect());
      const rt = (u && u.runtime) || [];
      box.textContent = rt.length
        ? ('推理环境 ' + rt.length + ' 个分包：' + rt[0] + ' …　语音包：' + (((u.voices || {}).qianxia) || ''))
        : '尚未配置仓库地址（填入 GitHub 仓库地址后会自动拼出全部分包地址）';
    } catch (e) { /* noop */ }
  }
  function ttsCollect() {
    const devBtn = document.querySelector('#tts-device .tts-device-btn.pink');
    const mirrorBtn = document.querySelector('#tts-mirror .tts-mirror-btn.pink');
    const patch = {
      enabled: !!(ttsEl('tts-enabled') && ttsEl('tts-enabled').checked),
      mode: 'managed',                       // 只保留"桌宠启动"（一键下载环境包）
      device: devBtn ? devBtn.dataset.device : 'cuda',
      repoUrl: (ttsEl('tts-repo') && ttsEl('tts-repo').value.trim()) || '',
      mirror: mirrorBtn ? mirrorBtn.dataset.mirror : 'official',
      mirrorCustom: (ttsEl('tts-mirror-custom') && ttsEl('tts-mirror-custom').value.trim()) || '',
      voicesDir: (ttsEl('tts-voices-dir') && ttsEl('tts-voices-dir').value.trim()) || '',
      runtimePath: (ttsEl('tts-runtime') && ttsEl('tts-runtime').value.trim()) || '',
      serverScript: (ttsEl('tts-script') && ttsEl('tts-script').value.trim()) || '',
      idleUnloadSec: parseInt(ttsEl('tts-idle') && ttsEl('tts-idle').value, 10) || 300,
      saveByRole: !!(ttsEl('tts-by-role') && ttsEl('tts-by-role').checked),
      speakOn: {
        chat: !!(ttsEl('tts-on-chat') && ttsEl('tts-on-chat').checked),
        bubble: !!(ttsEl('tts-on-bubble') && ttsEl('tts-on-bubble').checked),
        chatter: !!(ttsEl('tts-on-chatter') && ttsEl('tts-on-chatter').checked)
      }
    };
    try {
      const adv = JSON.parse((ttsEl('tts-adv') && ttsEl('tts-adv').value) || '{}');
      Object.assign(patch, adv);
    } catch (e) { /* JSON 非法则忽略高级项 */ }
    return patch;
  }
  // 统一的"保存并应用"（语音页所有可保存项），供悬浮按钮与"未保存提示"共用
  async function ttsSave() {
    try {
      renderTts(await dk.ttsConfig(ttsCollect()));
      ttsSnap = ttsSnapNow();      // 保存成功 → 刷新快照，脏状态复位
    } catch (e) { /* noop */ }
    updateSaveFab();
  }
  // 语音页改动跟踪：只在"值真的和上次保存的不一样"时点亮悬浮保存按钮。
  // 注意这里**不追踪按钮点击** —— 点「浏览」「下载源」这类按钮本身不代表改了配置。
  (function bindVoiceDirty() {
    const on = () => updateSaveFab();
    document.querySelectorAll('#view-settings input, #view-settings textarea, #view-settings select').forEach((el) => {
      el.addEventListener('change', on);
      el.addEventListener('input', on);
    });
  })();
  if (ttsEl('tts-start')) ttsEl('tts-start').addEventListener('click', async () => { try { const r = await dk.ttsStart(); if (r && !r.ok) alert('启动失败：' + (r.error || '')); } catch (e) { /* noop */ } refreshTts(); });
  if (ttsEl('tts-stop')) ttsEl('tts-stop').addEventListener('click', async () => { try { await dk.ttsStop(); } catch (e) { /* noop */ } refreshTts(); });
  if (ttsEl('tts-open-cache')) ttsEl('tts-open-cache').addEventListener('click', async () => { try { await dk.ttsOpenCache(); } catch (e) { /* noop */ } });
  // ===== 版本与更新（查项目仓库最新 Release / 最近提交）=====
  if (ttsEl('tts-check-update')) ttsEl('tts-check-update').addEventListener('click', async () => {
    const res = ttsEl('update-result'), log = ttsEl('update-log');
    if (res) res.textContent = '正在查询 GitHub…';
    if (log) { log.style.display = 'none'; log.textContent = ''; }
    let r = null;
    try { r = await dk.ttsCheckUpdate(); } catch (e) { r = { ok: false, error: e && e.message }; }
    if (!r || !r.ok) { if (res) res.textContent = '❌ 检测失败：' + ((r && r.error) || '未知错误') + '（可稍后重试）'; return; }
    const latest = (r.releases && r.releases[0]) || null;
    if (res) {
      res.textContent = latest
        ? ('📦 最新版本 ' + (latest.tag || latest.name || '') + '（' + String(latest.publishedAt || '').slice(0, 10) + '）　本地 v' + (r.local || '') + '　共 ' + r.releases.length + ' 个发布')
        : ('仓库暂无 Release　本地 v' + (r.local || ''));
    }
    const lines = [];
    if (latest && latest.body) lines.push('【' + (latest.tag || latest.name) + ' 更新日志】\n' + latest.body);
    if (r.commits && r.commits.length) lines.push('【最近提交】\n' + r.commits.map((c) => '  ' + c.sha + '  ' + c.message + '  ' + String(c.date || '').slice(0, 10)).join('\n'));
    if (log && lines.length) { log.style.display = 'block'; log.textContent = lines.join('\n\n'); }
  });
  if (ttsEl('btn-open-repo')) ttsEl('btn-open-repo').addEventListener('click', () => { try { dk.openExternal('https://github.com/Hazellol/Re-Dreaming_Angels_DesktopPet/releases'); } catch (e) { /* noop */ } });
  // 一键下载并自动集成（下载→解压→探测→写配置）
  function renderInstall(s) {
    if (!s) return;
    const bar = ttsEl('tts-install-bar');
    const msg = ttsEl('tts-install-msg');
    if (bar) bar.style.width = (s.total ? Math.min(100, Math.round((s.got / s.total) * 100)) : (s.phase === 'done' ? 100 : 0)) + '%';
    const partTag = (s.parts > 1 && s.part) ? ('【包 ' + s.part + '/' + s.parts + '】') : '';
    const label = ({ idle: '下载→解压→自动探测 Python 与服务脚本→写入配置，完成后即可用', download: '下载中…', extract: '解压中…', detect: '探测运行时…', done: '✅ ' + (s.message || '安装完成'), error: '❌ ' + (s.message || '失败') }[s.phase] || s.message || '');
    // 进度细节：百分比 + 已下载/总大小 + 速度 + 剩余时间
    let detail = '';
    if (s.phase === 'download') {
      const mb = (v) => (v / 1048576).toFixed(1);
      const sp = s.speed > 0 ? (s.speed >= 1048576 ? (s.speed / 1048576).toFixed(1) + ' MB/s' : Math.round(s.speed / 1024) + ' KB/s') : '';
      const eta = s.eta > 0 ? ('剩 ' + (s.eta >= 60 ? Math.round(s.eta / 60) + ' 分' : s.eta + ' 秒')) : '';
      detail = [s.total ? (mb(s.got) + ' / ' + mb(s.total) + ' MB') : (mb(s.got) + ' MB'), sp, eta].filter(Boolean).join('　');
    } else if (s.phase === 'extract' && s.total) {
      detail = ((s.total / 1048576).toFixed(1) + ' MB 解压中（大文件较慢，请稍候）');
    }
    if (msg) msg.textContent = partTag + label + (detail ? '　' + detail : '');
  }
  try { dk.onTtsInstallProgress(renderInstall); } catch (e) { /* noop */ }
  (async () => { try { renderInstall(await dk.ttsInstallState()); } catch (e) { /* noop */ } })();
  if (ttsEl('tts-install')) ttsEl('tts-install').addEventListener('click', async () => {
    const repo = (ttsEl('tts-repo') && ttsEl('tts-repo').value.trim()) || '';
    if (!repo) { alert('请先填写仓库地址（形如 https://github.com/<用户名>/<仓库名>）'); return; }
    try {
      await dk.ttsConfig(ttsCollect());                     // 保存仓库地址与下载源
      const r = await dk.ttsInstallRuntime();               // 自动拼装分卷地址；已安装会自动跳过
      if (r && r.skipped) { alert('推理环境已安装，未重复下载 ✓\n（如需重新下载请点「🔄 重新下载」）'); }
      else if (r && !r.ok) alert('安装失败：' + (r.error || '') + '\n\n可点「📜 后台日志」查看详细过程');
    } catch (e) { alert('安装异常：' + (e && e.message)); }
    refreshTts();
  });
  // 重新下载（强制覆盖）
  if (ttsEl('tts-reinstall')) ttsEl('tts-reinstall').addEventListener('click', async () => {
    if (!confirm('将重新下载并覆盖推理环境（约 5.45 GB），确定吗？\n\n如果是想修复问题，通常只需要「重新启动服务」即可。')) return;
    try {
      await dk.ttsConfig(ttsCollect());
      const r = await dk.ttsInstallRuntime({ force: true });
      if (r && !r.ok) alert('安装失败：' + (r.error || ''));
    } catch (e) { alert('异常：' + (e && e.message)); }
    refreshTts();
  });
  // ===== 后台日志面板 =====
  // 日志查看统一走「终端模式」（侧边栏再点一次控制台按钮，或点信息页里的按钮）。
  // 原来这里还有一个内嵌日志框，功能与终端重复，已删除。
  const csTerm = document.getElementById('cs-term');
  if (csTerm) csTerm.addEventListener('click', (e) => { e.stopPropagation(); setConsoleMode('term'); });
  if (ttsEl('tts-open-logs')) ttsEl('tts-open-logs').addEventListener('click', async () => { try { await dk.ttsOpenLogs(); } catch (e) { /* noop */ } });
  if (ttsEl('tts-open-data')) ttsEl('tts-open-data').addEventListener('click', async () => { try { await dk.ttsOpenData(); } catch (e) { /* noop */ } });
  // 自定义目录选择（浏览）：runtime=推理环境目录 | script=服务脚本 | voices=语音包目录
  async function pickPath(kind) {
    try {
      const r = await dk.ttsPick(kind);
      if (!r || r.canceled) return;
      if (!r.ok) { alert('未检测到有效内容：' + (r.error || '') + '\n\n请确认所选目录包含 python.exe 与 api_v2.py'); return; }
      if (kind === 'runtime') {
        alert('已识别并保存：\n\n运行时：' + (r.runtimePath || '(未找到 python.exe)') + '\n服务脚本：' + (r.serverScript || '(未找到 api_v2.py)'));
      } else if (kind === 'script') {
        alert('服务脚本已设置为：\n' + r.file);
      } else if (kind === 'voices') {
        alert(r.detected ? '语音包目录已设置（检测到情绪映射）✓' : '目录已保存，但未在其中检测到 <角色>/emotions.json');
      }
      refreshTts();
    } catch (e) { alert('操作失败：' + (e && e.message)); }
  }
  if (ttsEl('tts-pick-runtime')) ttsEl('tts-pick-runtime').addEventListener('click', () => pickPath('runtime'));
  if (ttsEl('tts-pick-script')) ttsEl('tts-pick-script').addEventListener('click', () => pickPath('script'));
  if (ttsEl('tts-pick-voices')) ttsEl('tts-pick-voices').addEventListener('click', () => pickPath('voices'));
  // 语音包（按需下载单只；已安装会先确认再覆盖）
  document.querySelectorAll('.tts-voice-btn').forEach((b) => b.addEventListener('click', async () => {
    const repo = (ttsEl('tts-repo') && ttsEl('tts-repo').value.trim()) || '';
    if (!repo) { alert('请先填写仓库地址'); return; }
    const role = b.dataset.role;
    const nameMap = { airui: '爱芮', qianxia: '千夏', nangong: '南宫羽' };
    const st = (lastTtsStatus && lastTtsStatus.installed && lastTtsStatus.installed.voices) || {};
    let force = false;
    if (st[role]) {
      if (!confirm('语音包【' + (nameMap[role] || role) + '】已安装，是否重新下载覆盖？')) return;
      force = true;
    }
    b.disabled = true;
    try {
      await dk.ttsConfig(ttsCollect());
      const r = await dk.ttsInstallVoice(role, { force });
      if (r && r.skipped) alert('语音包已安装，未重复下载 ✓');
      else if (r && !r.ok) alert('语音包下载失败：' + (r.error || '') + '\n\n可点「📜 后台日志」查看详情');
      else alert('语音包已安装：' + (nameMap[role] || role) + ' ✓');
    } catch (e) { alert('异常：' + (e && e.message)); }
    b.disabled = false;
    refreshTts();
  }));

  // ================= 设置页：显示兼容（窗口区域裁剪开关） =================
  async function refreshUiCfg() {
    try {
      const c = await dk.uiConfigGet();
      if (!c) return;
      if (ttsEl('ui-region')) ttsEl('ui-region').checked = c.regionEnabled !== false;
      const f = c.fix || {};
      if (ttsEl('ui-fix-nogpucomp')) ttsEl('ui-fix-nogpucomp').checked = f.noGpuCompositing === true;
      if (ttsEl('ui-fix-disablegpu')) ttsEl('ui-fix-disablegpu').checked = f.disableGpu === true;
      const fa = c.fixActive || {};
      const pendingRestart = f.noGpuCompositing !== fa.noGpuCompositing
        || f.disableGpu !== fa.disableGpu;
      // 混合显卡（独显 + 核显）笔记本是「黑块」的高发机型：主动把该勾的开关指出来
      const gh = ttsEl('ui-gpu-hint');
      if (gh) {
        const g = c.gpu || {};
        if (g.hybrid && f.noGpuCompositing !== true) {
          gh.style.display = '';
          gh.textContent = '💡 检测到混合显卡（' + ((g.names || []).join(' + ') || (g.vendors || []).join(' + ')) + '）。'
            + '这类机型上「角色周围黑块 / 关掉区域裁剪后整窗全黑」基本都由此引起：'
            + '请勾选上面的「关闭 GPU 合成」并重启桌宠（若仍发黑，再改勾「关闭硬件加速」）。';
        } else {
          gh.style.display = 'none';
          gh.textContent = '';
        }
      }
      const hint = ttsEl('ui-region-hint');
      if (hint) {
        let extra = '';
        if (!c.regionAvailable) extra = '（当前环境不支持该功能，已自动忽略）';
        // 系统「透明效果」关闭 → 透明窗口会整块变黑；此时"区域裁剪"反而是唯一可用的外观（只显示角色）
        if (c.sysTransparency === false) {
          extra += '\n\n⚠ 检测到系统「透明效果」已关闭：桌宠窗口会显示为黑色块。'
            + '请到「设置 → 个性化 → 颜色 → 透明效果」开启后重启桌宠；'
            + '在开启之前，请保持此处「窗口区域裁剪」为开启状态，否则会整窗全黑。';
        } else if (c.sysTransparency === true) {
          extra += '\n\n系统「透明效果」：已开启（正常）';
        }
        // 已实测确认：黑块的根因是透明窗口的 GPU 合成失效，区域裁剪只是"把黑块遮小一点"
        if (f.noGpuCompositing === true) {
          extra += '\n\n✅ 已启用「关闭 GPU 合成」——这是黑块的实测有效修复（黑块像素占比 15% → 0%）。';
        }
        if (pendingRestart) {
          extra += '\n\n⚠ 显示兼容开关有改动尚未生效，请完全退出并重新打开桌宠（仅关窗口不算）。';
        }
        // 这一块只承载"随环境变化"的动态提示；静态说明都收进上面的 ? 悬浮里了
        hint.style.whiteSpace = 'pre-wrap';
        hint.textContent = extra.replace(/^\n+/, '');
      }
    } catch (e) { /* noop */ }
  }
  if (ttsEl('ui-region')) ttsEl('ui-region').addEventListener('change', async () => {
    const on = ttsEl('ui-region').checked;
    try {
      await dk.uiConfigSet({ regionEnabled: on });
      alert(on
        ? '已开启窗口区域裁剪，重启桌宠后生效。'
        : '已关闭窗口区域裁剪，重启桌宠后生效。\n\n若播放视频时出现黑屏，说明该环境仍需要它，可以再打开。');
    } catch (e) { /* noop */ }
  });
  // 显示兼容：排查开关（重启生效）+ 打开配置目录
  // fileKey 为写入配置文件用的键名（带 fix 前缀，与 main.js 的读取键名保持一致）；
  // readKey 为 ui-config-get 返回的 fix 对象里的字段名。写入后必须回读校验，
  // 否则一旦键名写错，界面照样提示「已保存」，用户却永远等不到生效。
  const fixBind = [
    ['ui-fix-nogpucomp', 'fixNoGpuCompositing', 'noGpuCompositing'],
    ['ui-fix-disablegpu', 'fixDisableGpu', 'disableGpu']
  ];
  // 提示文案：黑块首选「关 GPU 合成」；关硬件加速是更彻底但更耗 CPU 的备选
  const fixTip = {
    'ui-fix-nogpucomp': '已勾选「关闭 GPU 合成」（黑块的首选修复），重启桌宠后生效。\n\n'
      + '若重启后仍有黑块，请再勾选「关闭硬件加速」；若一切正常，就保持这一项即可。',
    'ui-fix-disablegpu': '已勾选「关闭硬件加速」，重启桌宠后生效。\n\n'
      + '注意：这是全部改走软件渲染，CPU 占用会明显上升。如果「关闭 GPU 合成」已经能解决黑块，建议只用那一项。'
  };
  for (const [id, fileKey, readKey] of fixBind) {
    if (!ttsEl(id)) continue;
    ttsEl(id).addEventListener('change', async () => {
      const on = ttsEl(id).checked;
      try {
        await dk.uiConfigSet({ [fileKey]: on });
        const c = await dk.uiConfigGet();          // 回读磁盘上的真实结果
        const saved = c && c.fix ? c.fix[readKey] : undefined;
        if (saved === on) {
          alert(on ? fixTip[id] : '已取消，重启桌宠后生效。');
          refreshUiCfg();
        } else {
          ttsEl(id).checked = !on;
          alert('写入校验失败：配置文件里仍是旧值。\n请把这条日志发给开发者：\nuiConfigSet ' + fileKey + '=' + on
            + ' 回读=' + String(saved) + '\n文件：' + ((c && c.configFile) || '未知'));
        }
      } catch (e) { /* noop */ }
    });
  }
  if (ttsEl('ui-open-config')) ttsEl('ui-open-config').addEventListener('click', async () => {
    try {
      const c = await dk.uiConfigGet();
      if (c && c.configFile) dk.openExternal('file:///' + String(c.configFile).replace(/\\/g, '/'));
    } catch (e) { /* noop */ }
  });
  refreshUiCfg();

  // ================= 设置页：多显示器（运行屏幕） =================
  const screenBtns = Array.from(document.querySelectorAll('#set-screen-modes .screen-mode'));
  function renderScreenMode(mode) {
    const m = (mode === 'secondary' || mode === 'follow') ? mode : 'primary';
    screenBtns.forEach((b) => b.classList.toggle('pink', b.getAttribute('data-mode') === m));
    try { localStorage.setItem('QX_SCREENMODE', m); } catch (e) { /* noop */ }
    return m;
  }
  (async () => {
    try {
      const info = await dk.getScreenInfo();
      const hasSec = !!(info && info.secondary);
      const hint = document.getElementById('set-screen-hint');
      for (const b of screenBtns) {
        const needSec = b.getAttribute('data-mode') !== 'primary';
        b.disabled = needSec && !hasSec;
        b.style.opacity = (needSec && !hasSec) ? '.45' : '';
      }
      if (hint) {
        hint.textContent = hasSec
          ? `检测到 ${info.count} 块屏幕：主屏 ${info.primary.w}×${info.primary.h}（缩放 ${info.primary.sf}x）· 副屏 ${info.secondary.w}×${info.secondary.h}（缩放 ${info.secondary.sf}x）。「跟随角色」= 她们走到/被拖到另一块屏时窗口自动贴过去`
          : '当前只有一块屏幕（副屏 / 跟随角色 不可用）';
      }
      let saved = 'primary';
      try { saved = localStorage.getItem('QX_SCREENMODE') || 'primary'; } catch (e) { /* noop */ }
      renderScreenMode(saved);
      try { await dk.setScreenMode(saved); } catch (e) { /* noop */ }
    } catch (e) { /* noop */ }
  })();
  for (const b of screenBtns) {
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      const m = renderScreenMode(b.getAttribute('data-mode'));
      try { await dk.setScreenMode(m); } catch (e) { /* noop */ }
    });
  }

  // ================= 三小只开关卡片 =================
  const cardsEl = document.getElementById('cards');
  const map = {};
  for (const r of ROLES) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="c-img"><img alt=""></div>' +
      '<div class="c-name">' + r.name + '</div>' +
      '<div class="c-state">营业中</div>' +
      '<div class="c-switch"><div class="knob"></div></div>';
    card.querySelector('img').src = dk.readImage(r.img);
    const sw = card.querySelector('.c-switch');
    const st = card.querySelector('.c-state');
    function setUi(on) {
      sw.classList.toggle('on', on);
      card.classList.toggle('off', !on);
      st.textContent = on ? '营业中' : '休息中';
    }
    sw.addEventListener('click', () => {
      const on = !state[r.key];
      state[r.key] = on;
      setUi(on);
      dk.sendVisibility(r.key, on);
    });
    cardsEl.appendChild(card);
    map[r.key] = { card, sw, st, setUi };
  }

  function applyState(s) {
    for (const r of ROLES) {
      const on = !!(s && s[r.key] !== false);
      state[r.key] = on;
      map[r.key].setUi(on);
    }
  }
  dk.onPanelInit(applyState);

  // 显示/隐藏小偶像（勾选框形式；状态与主进程同步——救援快捷键恢复显示时这里也会跟着变）
  const elIdolsShow = document.getElementById('idols-show');
  const elIdolsShowState = document.getElementById('idols-show-state');
  // 总开关关闭时，"分别控制三小只"的开关变灰不可点（用户要求）
  function applyCardsLock() {
    for (const r of ROLES) {
      const m = map[r.key];
      if (m && m.card) m.card.classList.toggle('locked', !idolsShown);
    }
  }
  function renderIdolsShown(on) {
    idolsShown = !!on;
    if (elIdolsShow) elIdolsShow.checked = !!on;
    if (elIdolsShowState) elIdolsShowState.textContent = '👀 显示小偶像：' + (on ? '开' : '关');
    applyCardsLock();
  }
  let idolsShown = true;
  (async () => {
    try { renderIdolsShown(await dk.getIdolsShown()); } catch (e) { /* noop */ }
  })();
  if (elIdolsShow) {
    elIdolsShow.addEventListener('change', async (e) => {
      e.stopPropagation();
      try { renderIdolsShown(await dk.setIdolsShown(elIdolsShow.checked)); } catch (err) { renderIdolsShown(elIdolsShow.checked); }
    });
  }
  const elShowWrap = document.getElementById('btn-show-wrap');
  if (elShowWrap) {
    elShowWrap.addEventListener('click', (e) => { if (e.target !== elIdolsShow && elIdolsShow) elIdolsShow.click(); });
  }
  try { dk.onIdolsShown((on) => renderIdolsShown(on)); } catch (e) { /* noop */ }
  document.getElementById('btn-min').addEventListener('click', () => dk.minimizePanel());
  const btnClose = document.getElementById('btn-close');
  if (btnClose) btnClose.addEventListener('click', () => { confirmSaveIfDirty(); dk.closePanel(); });   // 关闭控制台（有未保存改动会先询问）
  document.getElementById('btn-quit').addEventListener('click', () => { confirmSaveIfDirty(); dk.quit(); });

  // ================= 对话配置（DeepSeek；存 data/ai_config.json，与主窗共享） =================
  const DEFAULTS = { provider: 'deepseek', apiKey: '', model: 'deepseek-v4-flash', temperature: 1.0, maxTokens: 256, contextRounds: 20, historyOn: true, chatMode: 'panel', webSearch: false };
  let cfg = Object.assign({}, DEFAULTS);
  function loadCfg() {
    let raw = null;
    try { raw = dk.readAICfg(); } catch (e) { raw = null; }
    if (raw) { try { const o = JSON.parse(raw); if (o) Object.assign(cfg, o); } catch (e) { /* noop */ } }
  }
  function saveCfg() {
    dk.writeAICfg(JSON.stringify(cfg));
    dk.notifyAICfgSaved();   // 通知主窗立即热更新（所有配置统一走保存按钮）
  }
  const elKey = document.getElementById('ai-key');
  const elModel = document.getElementById('ai-model');
  const elTemp = document.getElementById('ai-temp');
  const elTempVal = document.getElementById('ai-temp-val');
  const elMax = document.getElementById('ai-max');
  const elRounds = document.getElementById('ai-rounds');
  const elHistory = document.getElementById('ai-history');
  const elMode = document.getElementById('ai-mode');
  const elWeb = document.getElementById('ai-web');
  const elRslt = document.getElementById('ai-test-rslt');

  function fillForm() {
    elKey.value = cfg.apiKey || '';
    elModel.value = cfg.model || 'deepseek-v4-flash';
    elTemp.value = cfg.temperature;
    elTempVal.textContent = (+cfg.temperature || 1.0).toFixed(1);
    elMax.value = cfg.maxTokens;
    elRounds.value = cfg.contextRounds;
    elHistory.checked = !!cfg.historyOn;
    elMode.value = (cfg.chatMode === 'bubble') ? 'bubble' : 'panel';
    elWeb.checked = !!cfg.webSearch;
  }
  function readForm() {
    cfg.apiKey = elKey.value.trim();
    cfg.model = elModel.value;
    cfg.temperature = Math.min(2, Math.max(0, +elTemp.value || 1.0));
    cfg.maxTokens = Math.min(2048, Math.max(32, parseInt(elMax.value, 10) || 256));
    cfg.contextRounds = Math.min(100, Math.max(2, parseInt(elRounds.value, 10) || 20));
    cfg.historyOn = elHistory.checked;
    cfg.chatMode = elMode.value === 'bubble' ? 'bubble' : 'panel';
    cfg.webSearch = !!elWeb.checked;
  }
  // 表单联动：仅更新内存值；写盘 + 热更新统一由右下角的悬浮「保存并应用」按钮触发
  // 每次联动后重算脏状态，决定悬浮按钮是否出现
  const aiTouched = () => { readForm(); updateSaveFab(); };
  elKey.addEventListener('input', aiTouched);
  elModel.addEventListener('change', aiTouched);
  elTemp.addEventListener('input', () => { elTempVal.textContent = (+elTemp.value).toFixed(1); aiTouched(); });
  elMax.addEventListener('change', aiTouched);
  elRounds.addEventListener('change', aiTouched);
  elHistory.addEventListener('change', aiTouched);
  elMode.addEventListener('change', aiTouched);
  elWeb.addEventListener('change', aiTouched);
  document.getElementById('ai-key-eye').addEventListener('click', (e) => {
    elKey.type = elKey.type === 'password' ? 'text' : 'password';
    e.currentTarget.textContent = elKey.type === 'password' ? '👁' : '🙈';
  });
  // 重置数字配置（温度/字数上限/上下文轮数；不动 Key/模型/历史开关/样式）——保存并立即生效
  document.getElementById('ai-reset').addEventListener('click', () => {
    cfg.temperature = 1.0;
    cfg.maxTokens = 256;
    cfg.contextRounds = 20;
    fillForm();
    saveCfg();
    aiSnap = JSON.stringify(cfg);   // 重置后立即落盘 → 基准快照同步
    updateSaveFab();
    elRslt.className = 'ok';
    elRslt.textContent = '↺ 温度 / 回复字数上限 / 上下文轮数 已恢复默认并保存';
  });

  // 连接测试
  document.getElementById('ai-test').addEventListener('click', async () => {
    readForm();
    elRslt.className = '';
    elRslt.textContent = '连接测试中…';
    const res = await dk.aiTest(cfg);
    if (res && res.ok) {
      elRslt.className = 'ok';
      elRslt.textContent = '✅ 连接成功！DeepSeek 已就绪';
      cfg.connected = true;          // 记录"连通"（捏捏 AI 反应等功能的开启条件）
      saveCfg();
    } else { elRslt.className = 'bad'; elRslt.textContent = '❌ ' + ((res && res.error) || '测试失败'); }
  });

  // 清空历史（panel 窗口与主窗进程不同，先由主窗侧删除文件：通过 preload 直接删除）
  const clearBtn = { airui: document.getElementById('ai-clear-1'), nangong: document.getElementById('ai-clear-2'), qianxia: document.getElementById('ai-clear-3') };
  for (const key of KEYS) {
    clearBtn[key].addEventListener('click', () => {
      const ok = dk.clearChatHistory(key);
      elRslt.className = ok ? 'ok' : 'bad';
      elRslt.textContent = ok ? '🗑️ ' + ROLES.find((r) => r.key === key).name + ' 的历史已清空' : '清空失败';
    });
  }

  // 开机自启动（主页开关；系统级登录项，切换即生效；状态由系统记录，读取刷新）
  const elAuto = document.getElementById('sys-autolaunch');
  const elAutoState = document.getElementById('sys-autolaunch-state');
  const elAutoWrap = document.getElementById('btn-autolaunch-wrap');
  function renderAutoState(on) {
    if (elAuto) elAuto.checked = !!on;
    if (elAutoState) elAutoState.textContent = '⚙ 开机自启动：' + (on ? '开' : '关');
  }
  (async () => {
    try { renderAutoState(await dk.getAutoLaunch()); } catch (e) { /* noop */ }
  })();
  if (elAuto) {
    elAuto.addEventListener('change', async (e) => {
      e.stopPropagation();
      try {
        const now = await dk.setAutoLaunch(elAuto.checked);
        renderAutoState(now);
      } catch (err) { renderAutoState(elAuto.checked); }
    });
  }
  if (elAutoWrap) {
    elAutoWrap.addEventListener('click', (e) => {
      if (e.target === elAuto) return;   // 复选框自身已处理
      if (elAuto) elAuto.click();
    });
  }

  // ================= 控制台页：项目所有后台信息集中在这里 =================
  function csSet(id, text, cls) {
    const e = document.getElementById(id);
    if (!e) return;
    e.textContent = text;
    e.className = cls || '';
  }
  async function refreshConsole() {
    // 1) 应用/环境信息
    try {
      const a = await dk.appInfo();
      if (a) {
        csSet('cs-version', 'v' + a.version);
        csSet('cs-os', a.platform);
        csSet('cs-runtime', 'Electron ' + a.electron + ' · Chromium ' + String(a.chrome).split('.')[0] + ' · Node ' + a.node);
        csSet('cs-mode', a.isPackaged ? '打包版（便携）' : '源码运行');
        const g = a.gpu || {};
        const names = (g.names || []).join(' + ') || (g.vendors || []).join(' + ');
        csSet('cs-gpu', names || '未识别');
        if (g.hybrid) {
          csSet('cs-hybrid', '是（黑块高发机型）', 'warn');
        } else if (g.vendors && g.vendors.length) {
          csSet('cs-hybrid', '否', 'ok');
        } else {
          csSet('cs-hybrid', '未知');
        }
        csSet('cs-transparency',
          a.sysTransparency === true ? '已开启' : (a.sysTransparency === false ? '已关闭（会导致窗口发黑）' : '未知'),
          a.sysTransparency === false ? 'warn' : 'ok');
        // 显示修复开关（这是排查黑块最直接的一行）
        const f = a.fix || {};
        const parts = [];
        if (f.noGpuCompositing) parts.push('关闭 GPU 合成');
        if (f.disableGpu) parts.push('关闭硬件加速');
        if (f.keepVideoOverlay) parts.push('保留视频叠加特性');
        const fixTxt = parts.length ? parts.join(' + ') : '全部关闭（默认）';
        const fx = document.getElementById('cs-fix');
        if (fx) fx.textContent = '显示修复开关：' + fixTxt + '　|　窗口区域裁剪：' + (a.regionActive ? '启用' : '关闭');
      }
    } catch (e) { /* noop */ }
    // 2) 语音服务状态（复用 TTS 的实时状态，不额外请求）
    let ttsTxt = '未知', ttsCls = '';
    try {
      if (lastTtsStatus) {
        const running = lastTtsStatus.running;
        ttsTxt = running ? '运行中' : '未运行';
        ttsCls = running ? 'ok' : '';
      }
    } catch (e) { /* noop */ }
    csSet('cs-tts', ttsTxt, ttsCls);
    // 3) 登录自启
    try {
      const on = await dk.getAutoLaunch();
      csSet('cs-autolaunch', on ? '已开启' : '已关闭', on ? 'ok' : '');
    } catch (e) { csSet('cs-autolaunch', '未知'); }
    // 4) 运行屏幕
    try {
      const m = localStorage.getItem('QX_SCREENMODE') || 'primary';
      csSet('cs-screen', m === 'secondary' ? '副显示器' : (m === 'follow' ? '跟随角色' : '主显示器'));
    } catch (e) { /* noop */ }
  }
  const csRefresh = document.getElementById('cs-refresh');
  if (csRefresh) csRefresh.addEventListener('click', (e) => { e.stopPropagation(); refreshConsole(); });
  const csCopy = document.getElementById('cs-copy-diag');
  if (csCopy) {
    csCopy.addEventListener('click', async (e) => {
      e.stopPropagation();
      const msg = document.getElementById('cs-copy-msg');
      try {
        const text = await dk.uiDiagText();
        if (!text) throw new Error('empty');
        await navigator.clipboard.writeText(text);
        if (msg) msg.textContent = '✅ 已复制完整诊断信息，直接粘贴给开发者即可。';
      } catch (err) {
        try {
          const text = await dk.uiDiagText();
          if (msg) { msg.style.whiteSpace = 'pre-wrap'; msg.textContent = text; }
        } catch (e2) { if (msg) msg.textContent = '⚠ 复制失败，请改用「日志文件」手动发送。'; }
      }
    });
  }

  // ================= 控制台页：信息页 ⇄ 终端页 =================
  let consoleMode = 'info';
  let termTimer = null;
  function stopTerm() { if (termTimer) { clearInterval(termTimer); termTimer = null; } }
  function termEsc(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  // 按内容给日志上色：一眼看出哪些是错误、哪些是诊断、哪些只是普通信息
  function termColor(line) {
    const t = termEsc(line);
    if (/\[ERROR\]|\[ERR\]|失败|错误|ECONNREFUSED|Exception|未安装/.test(line)) return '<span class="tl-err">' + t + '</span>';
    if (/\[WARN\]|⚠|超时|不可用|跳过|未配置/.test(line)) return '<span class="tl-warn">' + t + '</span>';
    if (/\[诊断\]/.test(line)) return '<span class="tl-diag">' + t + '</span>';
    if (/合成|语音|TTS/.test(line)) return '<span class="tl-tts">' + t + '</span>';
    if (/https?:\/\//.test(line)) return '<span class="tl-url">' + t + '</span>';
    if (/成功|已就绪|已安装|✓|✅/.test(line)) return '<span class="tl-ok">' + t + '</span>';
    if (/\[INFO\]/.test(line)) return '<span class="tl-info">' + t + '</span>';
    return '<span class="tl-dim">' + t + '</span>';
  }
  async function refreshTerm() {
    const box = document.getElementById('term-body');
    if (!box) return;
    try {
      // sinceStart=true：只显示"本次启动之后"的日志，不再把上次运行的记录一起滚出来
      const text = await dk.ttsGetLogs(400, true);
      const lines = String(text || '').split(/\r?\n/);
      // 用户手动往上翻看历史时，不要强行把他拽回底部
      const atBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 60;
      box.innerHTML = lines.map((l) => '<div>' + (l ? termColor(l) : '&nbsp;') + '</div>').join('');
      if (atBottom) box.scrollTop = box.scrollHeight;
    } catch (e) { /* noop */ }
  }
  async function renderTermHeader() {
    const box = document.getElementById('term-body');
    if (!box) return;
    const head = [];
    try {
      const a = await dk.appInfo();
      const g = a.gpu || {};
      head.push('ReDreamingAngels-DesktopPet  v' + (a.version || '?') + '  [' + (a.isPackaged ? 'packaged' : 'dev') + ']');
      head.push('OS   ' + (a.platform || '?'));
      head.push('GPU  ' + (((g.names || []).join(' + ')) || 'unknown') + (g.hybrid ? '   [混合显卡]' : ''));
      head.push('RUN  Electron ' + a.electron + ' · Chromium ' + a.chrome + ' · Node ' + a.node);
      head.push('LOG  ' + String(a.userData || '') + '\\tts\\logs\\app.log');
    } catch (e) { /* noop */ }
    box.innerHTML = head.map((l) => '<div class="tl-head">' + termEsc(l) + '</div>').join('')
      + '<div class="tl-dim">' + termEsc('──────── 以下为后台日志，每 1 秒自动刷新 ────────') + '</div>';
    box.scrollTop = box.scrollHeight;
  }
  function setConsoleMode(mode) {
    consoleMode = (mode === 'term') ? 'term' : 'info';
    const vc = document.getElementById('view-console');
    if (vc) vc.classList.toggle('term-on', consoleMode === 'term');
    if (consoleMode === 'term') {
      // 先铺表头，再开始滚日志
      try { renderTermHeader().then(refreshTerm); } catch (e) { refreshTerm(); }
      stopTerm();
      termTimer = setInterval(refreshTerm, 1000);
    } else {
      stopTerm();
    }
  }

  // ================= 快捷键页 =================
  let keysPayload = null;
  let capturing = null;   // 正在录制的键位按钮
  function fmtKey(k) {
    return String(k || '').replace(/CommandOrControl/g, 'Ctrl').replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win');
  }
  // 把键盘事件转成 Electron accelerator 写法；只按修饰键时返回 null（继续等主键）
  function accelFromEvent(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    let k = e.key;
    if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta') return null;
    if (k === 'Escape') return 'ESC';
    if (k === ' ') k = 'Space';
    else if (k.indexOf('Arrow') === 0) k = k.slice(5);
    else if (k.length === 1) k = k.toUpperCase();
    else if (!/^F\d{1,2}$/.test(k) && ['Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].indexOf(k) < 0) {
      k = String(k).slice(0, 12);
    }
    return mods.concat([k]).join('+');
  }
  async function renderKeys(msg) {
    const box = document.getElementById('keys-list');
    if (!box) return;
    try { keysPayload = await dk.hotkeysGet(); } catch (e) { /* noop */ }
    const p = keysPayload;
    if (!p) return;
    const st = p.state || {};
    box.innerHTML = '';
    (p.defs || []).forEach((d) => {
      const s = st[d.id] || {};
      const row = document.createElement('div');
      row.className = 'keys-row';
      const name = document.createElement('span'); name.className = 'k-name'; name.textContent = d.name;
      const btn = document.createElement('span'); btn.className = 'k-btn'; btn.setAttribute('data-id', d.id);
      btn.textContent = fmtKey(s.active || (p.cfg && p.cfg[d.id]) || d.def);
      const flag = document.createElement('span');
      flag.className = 'k-flag ' + (s.ok ? 'ok' : 'bad');
      flag.textContent = s.ok ? (s.error || '✅ 已生效') : ('⚠ ' + (s.error || '注册失败'));
      const desc = document.createElement('span'); desc.className = 'k-desc'; desc.textContent = d.desc || '';
      row.appendChild(name); row.appendChild(btn); row.appendChild(flag); row.appendChild(desc);
      box.appendChild(row);
    });
    const msgEl = document.getElementById('keys-msg');
    if (msgEl) { msgEl.textContent = msg || ''; msgEl.style.color = (msg && msg.indexOf('⚠') === 0) ? '#c05050' : '#2e9e6b'; }
  }
  const keysResetBtn = document.getElementById('keys-reset');
  if (keysResetBtn) {
    keysResetBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      let r = null;
      try { r = await dk.hotkeysReset(); } catch (err) { r = { ok: false, error: err && err.message }; }
      if (r && r.ok) { keysPayload = r.payload || keysPayload; await renderKeys('✅ 已恢复默认快捷键'); }
      else await renderKeys('⚠ ' + ((r && r.error) || '恢复失败'));
    });
  }
  // 录制：点键位按钮 → 直接按新组合 → 立即写配置并重新注册（热更新，无需重启）
  document.addEventListener('click', async (e) => {
    const btn = (e.target && e.target.classList && e.target.classList.contains('k-btn')) ? e.target : null;
    if (!btn) return;
    if (capturing) { try { capturing.btn.classList.remove('listening'); capturing.btn.textContent = capturing.old; } catch (err) { /* noop */ } }
    const id = btn.getAttribute('data-id');
    const old = btn.textContent;
    capturing = { btn, id, old };
    btn.classList.add('listening');
    btn.textContent = '按下新组合…（Esc 取消）';
    const onKey = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const acc = accelFromEvent(ev);
      if (!acc) return;                     // 只按了修饰键 → 继续等主键
      window.removeEventListener('keydown', onKey, true);
      capturing = null;
      try { btn.classList.remove('listening'); } catch (err) { /* noop */ }
      if (acc === 'ESC') { btn.textContent = old; return; }
      let r = null;
      try { r = await dk.hotkeysSet(id, acc); } catch (err) { r = { ok: false, error: err && err.message }; }
      if (r && r.ok) {
        keysPayload = r.payload || keysPayload;
        await renderKeys('✅ 已改为 ' + fmtKey(acc) + '（立即生效）');
      } else {
        await renderKeys('⚠ ' + ((r && r.error) || '设置失败'));
        btn.textContent = old;
      }
    };
    window.addEventListener('keydown', onKey, true);
  });

  loadCfg();
  fillForm();
  aiSnap = JSON.stringify(cfg);   // 初始基准：刚加载的配置就是"已保存"状态
  updateSaveFab();
})();
