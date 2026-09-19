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

  // ================= 视图切换（主页 / 对话配置 / 设置） =================
  const viewHome = document.getElementById('view-home');
  const viewAi = document.getElementById('view-ai');
  const viewSettings = document.getElementById('view-settings');
  const btnHome = document.getElementById('btn-home');
  const btnAi = document.getElementById('btn-ai');
  const btnSettings = document.getElementById('btn-settings');
  const tTitle = document.getElementById('t-title');
  const tSub = document.getElementById('t-sub');
  // view: 'home' | 'ai' | 'settings'
  function showView(view) {
    viewHome.style.display = view === 'home' ? 'block' : 'none';
    viewAi.style.display = view === 'ai' ? 'block' : 'none';
    if (viewSettings) viewSettings.style.display = view === 'settings' ? 'block' : 'none';
    btnHome.classList.toggle('active', view === 'home');
    btnAi.classList.toggle('active', view === 'ai');
    if (btnSettings) btnSettings.classList.toggle('active', view === 'settings');
    if (view === 'ai') {
      tTitle.textContent = '💬 妄想天使 · 对话配置';
      tSub.textContent = 'DeepSeek AI 聊天设置（三小只会按各自人设和你聊天～）';
    } else if (view === 'settings') {
      tTitle.textContent = '⚙ 妄想天使 · 设置';
      tSub.textContent = '性能与显示选项（帧率等；改动立即生效）';
    } else {
      tTitle.textContent = '🎀 妄想天使 · 控制台';
      tSub.textContent = '分别控制三小只的桌宠开关（关掉后她会去休息哦～）';
    }
    const v = view === 'ai' ? viewAi : (view === 'settings' ? viewSettings : viewHome);
    if (v) { v.classList.remove('view-swap'); void v.offsetWidth; v.classList.add('view-swap'); }
  }
  btnHome.addEventListener('click', () => showView('home'));
  btnAi.addEventListener('click', () => showView('ai'));
  if (btnSettings) btnSettings.addEventListener('click', () => showView('settings'));

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
  function renderTts(s) {
    if (!s) return;
    const c = s.config || {};
    if (ttsEl('tts-enabled')) ttsEl('tts-enabled').checked = !!c.enabled;
    if (ttsEl('tts-host')) ttsEl('tts-host').value = c.host || '127.0.0.1';
    if (ttsEl('tts-port')) ttsEl('tts-port').value = c.port || 9880;
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
    // 按钮语义：external（已有服务）模式下"启动服务"无意义 → 禁用并给出提示（用户实测困惑点）
    const isManaged = (c.mode || 'external') === 'managed';
    const startBtn = ttsEl('tts-start');
    if (startBtn) {
      startBtn.disabled = !isManaged;
      startBtn.style.opacity = isManaged ? '' : '.45';
      startBtn.title = isManaged ? '启动桌宠自带的 TTS 服务（便携包）' : '当前是「已有服务」模式：请在外部启动 GPT-SoVITS，或切到「桌宠启动」';
    }
    const stopBtn = ttsEl('tts-stop');
    if (stopBtn) stopBtn.title = isManaged ? '停止桌宠启动的服务' : '当前是「已有服务」模式：服务由外部管理';
    if (ttsEl('tts-adv')) {
      try {
        ttsEl('tts-adv').value = JSON.stringify({
          apiPath: c.apiPath, params: c.params, extraBody: c.extraBody,
          refFields: c.refFields, refMode: c.refMode, healthPath: c.healthPath
        }, null, 1);
      } catch (e) { /* noop */ }
    }
    const line = ttsEl('tts-status-line');
    if (line) {
      const parts = [];
      parts.push(s.running ? '🟢 服务运行中' : '⚪ 服务未运行');
      parts.push(c.enabled ? '语音已启用' : '语音已关闭');
      parts.push('设备 ' + (c.device || 'cuda'));
      parts.push('语音包 ' + (s.hasVoices ? '已就绪' : '缺失（需下载/放置 emotions.json + 参考音频）'));
      if (s.lastError) parts.push('⚠ ' + s.lastError);
      line.textContent = '状态：' + parts.join(' · ') + '　（目录：' + (s.voicesRoot || '') + '）';
    }
  }
  async function refreshTts() { try { renderTts(await dk.ttsStatus()); } catch (e) { /* noop */ } }
  try { dk.onTtsStatus(renderTts); } catch (e) { /* noop */ }
  refreshTts();
  document.querySelectorAll('#tts-device .tts-device-btn').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tts-device .tts-device-btn').forEach((x) => x.classList.toggle('pink', x === b));
  }));
  document.querySelectorAll('#tts-mirror .tts-mirror-btn').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tts-mirror .tts-mirror-btn').forEach((x) => x.classList.toggle('pink', x === b));
    previewUrls();
  }));
  if (ttsEl('tts-mirror-custom')) ttsEl('tts-mirror-custom').addEventListener('change', previewUrls);
  if (ttsEl('tts-repo')) ttsEl('tts-repo').addEventListener('change', previewUrls);
  // 显示将要下载的地址（用户一眼可见，无需手输）
  async function previewUrls() {
    const box = ttsEl('tts-url-preview');
    if (!box) return;
    try {
      const saved = await dk.ttsConfig(ttsCollect());   // 先保存，再取拼接结果
      const u = await dk.ttsUrls();
      const rt = (u && u.runtime) || [];
      box.textContent = rt.length
        ? ('推理环境 ' + rt.length + ' 个分包：' + rt[0] + ' …　语音包：' + (((u.voices || {}).qianxia) || ''))
        : '尚未配置仓库地址（填入 GitHub 仓库地址后会自动拼出全部分包地址）';
      void saved;
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
  if (ttsEl('tts-save')) ttsEl('tts-save').addEventListener('click', async () => { try { renderTts(await dk.ttsConfig(ttsCollect())); } catch (e) { /* noop */ } });
  if (ttsEl('tts-probe')) ttsEl('tts-probe').addEventListener('click', async () => { try { await dk.ttsProbe(); } catch (e) { /* noop */ } refreshTts(); });
  if (ttsEl('tts-start')) ttsEl('tts-start').addEventListener('click', async () => { try { const r = await dk.ttsStart(); if (r && !r.ok) alert('启动失败：' + (r.error || '')); } catch (e) { /* noop */ } refreshTts(); });
  if (ttsEl('tts-stop')) ttsEl('tts-stop').addEventListener('click', async () => { try { await dk.ttsStop(); } catch (e) { /* noop */ } refreshTts(); });
  if (ttsEl('tts-open-cache')) ttsEl('tts-open-cache').addEventListener('click', async () => { try { await dk.ttsOpenCache(); } catch (e) { /* noop */ } });
  // 一键下载并自动集成（下载→解压→探测→写配置）
  function renderInstall(s) {
    if (!s) return;
    const bar = ttsEl('tts-install-bar');
    const msg = ttsEl('tts-install-msg');
    if (bar) bar.style.width = (s.total ? Math.min(100, Math.round((s.got / s.total) * 100)) : (s.phase === 'done' ? 100 : 0)) + '%';
    const partTag = (s.parts > 1 && s.part) ? ('【包 ' + s.part + '/' + s.parts + '】') : '';
    const label = ({ idle: '下载→解压→自动探测 Python 与服务脚本→写入配置，完成后即可用', download: '下载中…', extract: '解压中…', detect: '探测运行时…', done: '✅ 安装完成，可直接使用', error: '❌ ' + (s.message || '失败') }[s.phase] || s.message || '');
    if (msg) msg.textContent = partTag + label + ((s.phase === 'download' && s.message) ? '（' + String(s.message).replace(/^第 \d+\/\d+ 包 /, '') + '）' : '');
  }
  try { dk.onTtsInstallProgress(renderInstall); } catch (e) { /* noop */ }
  (async () => { try { renderInstall(await dk.ttsInstallState()); } catch (e) { /* noop */ } })();
  if (ttsEl('tts-install')) ttsEl('tts-install').addEventListener('click', async () => {
    const repo = (ttsEl('tts-repo') && ttsEl('tts-repo').value.trim()) || '';
    if (!repo) { alert('请先填写仓库地址（形如 https://github.com/<用户名>/<仓库名>）'); return; }
    try {
      await dk.ttsConfig(ttsCollect());                     // 保存仓库地址与下载源
      const r = await dk.ttsInstallRuntime();               // 自动拼装分卷地址并依次下载
      if (r && !r.ok) alert('安装失败：' + (r.error || ''));
    } catch (e) { alert('安装异常：' + (e && e.message)); }
    refreshTts();
  });
  // 语音包（按需下载单只）
  document.querySelectorAll('.tts-voice-btn').forEach((b) => b.addEventListener('click', async () => {
    const repo = (ttsEl('tts-repo') && ttsEl('tts-repo').value.trim()) || '';
    if (!repo) { alert('请先填写仓库地址'); return; }
    const role = b.dataset.role;
    b.disabled = true;
    try {
      await dk.ttsConfig(ttsCollect());
      const r = await dk.ttsInstallVoice(role);
      if (r && !r.ok) alert('语音包下载失败：' + (r.error || ''));
      else alert('语音包已安装：' + role);
    } catch (e) { alert('异常：' + (e && e.message)); }
    b.disabled = false;
    refreshTts();
  }));

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
  if (btnClose) btnClose.addEventListener('click', () => dk.closePanel());   // 关闭控制台（窗口销毁，释放该渲染进程）
  document.getElementById('btn-quit').addEventListener('click', () => dk.quit());

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
  // 表单联动（仅在输入时更新内存值；写盘+热更新统一由「保存配置」按钮触发）
  elKey.addEventListener('input', () => { readForm(); });
  elModel.addEventListener('change', () => { readForm(); });
  elTemp.addEventListener('input', () => { elTempVal.textContent = (+elTemp.value).toFixed(1); readForm(); });
  elMax.addEventListener('change', () => { readForm(); });
  elRounds.addEventListener('change', () => { readForm(); });
  elHistory.addEventListener('change', () => { readForm(); });
  elMode.addEventListener('change', () => { readForm(); });
  elWeb.addEventListener('change', () => { readForm(); });
  document.getElementById('ai-save').addEventListener('click', () => {
    readForm();
    saveCfg();
    elRslt.className = 'ok';
    elRslt.textContent = '✅ 配置已保存并立即生效';
  });
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
  const elAutoHint = document.getElementById('sys-autolaunch-hint');
  const elAutoState = document.getElementById('sys-autolaunch-state');
  const elAutoWrap = document.getElementById('btn-autolaunch-wrap');
  function renderAutoState(on) {
    if (elAuto) elAuto.checked = !!on;
    if (elAutoState) elAutoState.textContent = '⚙ 开机自启动：' + (on ? '开' : '关');
    if (elAutoHint) {
      elAutoHint.textContent = on ? '✅ 已开启：随 Windows 登录自动启动' : '开机自启动可在此开关';
      elAutoHint.style.color = on ? '#d0408a' : '';
    }
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

  loadCfg();
  fillForm();
})();
