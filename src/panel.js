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
  function renderIdolsShown(on) {
    if (elIdolsShow) elIdolsShow.checked = !!on;
    if (elIdolsShowState) elIdolsShowState.textContent = '👀 显示小偶像：' + (on ? '开' : '关');
  }
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
