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

  // ================= 视图切换（主页 / 对话配置） =================
  const viewHome = document.getElementById('view-home');
  const viewAi = document.getElementById('view-ai');
  const btnHome = document.getElementById('btn-home');
  const btnAi = document.getElementById('btn-ai');
  const tTitle = document.getElementById('t-title');
  const tSub = document.getElementById('t-sub');
  function showView(ai) {
    viewHome.style.display = ai ? 'none' : 'block';
    viewAi.style.display = ai ? 'block' : 'none';
    btnHome.classList.toggle('active', !ai);
    btnAi.classList.toggle('active', ai);
    tTitle.textContent = ai ? '💬 妄想天使 · 对话配置' : '🎀 妄想天使 · 控制台';
    tSub.textContent = ai ? 'DeepSeek AI 聊天设置（三小只会按各自人设和你聊天～）' : '分别控制三小只的桌宠开关（关掉后她会去休息哦～）';
    const v = ai ? viewAi : viewHome;
    v.classList.remove('view-swap'); void v.offsetWidth; v.classList.add('view-swap');
  }
  btnHome.addEventListener('click', () => showView(false));
  btnAi.addEventListener('click', () => showView(true));

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

  document.getElementById('btn-show').addEventListener('click', () => dk.toggleIdolWindow());
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

  loadCfg();
  fillForm();
})();
