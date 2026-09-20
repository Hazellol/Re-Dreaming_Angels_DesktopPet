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
  let currentView = 'home';
  // ===== 未保存提示：设置页里有改动但没点"保存并应用"时，离开/关闭会询问 =====
  let settingsDirty = false;
  function markSettingsDirty() { settingsDirty = true; }
  function confirmSaveIfDirty() {
    if (!settingsDirty) return true;
    const yes = confirm('设置尚未保存，是否保存？\n\n「确定」= 立即保存并应用\n「取消」= 放弃本次修改');
    if (yes) { try { saveAllSettings(); } catch (e) { /* noop */ } }
    settingsDirty = false;
    return true;
  }
  // view: 'home' | 'ai' | 'settings'
  function showView(view) {
    // 离开"设置"页时，若本次有未保存的修改 → 询问是否保存
    if (currentView === 'settings' && view !== 'settings') confirmSaveIfDirty();
    currentView = view;
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
  const ROLE_LIST = ['airui', 'qianxia', 'nangong'];
  let lastTtsStatus = null;   // 最近一次状态（用于"是否已安装"等交互判断）
  function renderTts(s) {
    if (!s) return;
    lastTtsStatus = s;
    const c = s.config || {};
    // 安装状态：已装则隐藏"一键下载"、显示"重新下载"与提示；语音包按钮加 ✅
    const ins = s.installed || {};
    const hint = ttsEl('tts-installed-hint');
    if (hint) {
      hint.textContent = ins.runtime
        ? '✅ 推理环境已安装（重复点下载会自动跳过；需要覆盖请点「🔄 重新下载」）'
        : '⚠ 尚未安装推理环境 —— 点「⬇ 一键下载推理环境」即可自动装好（约 5.45 GB）';
    }
    if (ttsEl('tts-install')) ttsEl('tts-install').style.display = ins.runtime ? 'none' : '';
    if (ttsEl('tts-reinstall')) ttsEl('tts-reinstall').style.display = ins.runtime ? '' : 'none';
    document.querySelectorAll('.tts-voice-btn').forEach((b) => {
      const role = b.dataset.role;
      const base = { airui: '爱芮', qianxia: '千夏', nangong: '南宫羽' }[role] || role;
      const has = !!(ins.voices && ins.voices[role]);
      if (!b.disabled) b.textContent = (has ? '✅ ' : '') + base;
    });
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
    if (ttsEl('tts-voices-dir')) ttsEl('tts-voices-dir').value = c.voicesDir || '';
    // 检测位置说明（让用户清楚程序实际在查哪里）
    const dh = ttsEl('tts-detect-hint');
    if (dh) {
      const nameMap = { airui: '爱芮', qianxia: '千夏', nangong: '南宫羽' };
      const vState = ROLE_LIST.map((r) => nameMap[r] + (ins.voices && ins.voices[r] ? '✓' : '✗')).join('　');
      dh.textContent = '推理环境：' + (ins.runtime ? '已安装 ✓' : '未安装 ✗')
        + '　语音包：' + vState
        + '\n数据目录：' + (s.dataRoot || '')
        + (c.voicesDir ? '\n语音包目录（自定义）：' + c.voicesDir : '');
      dh.style.whiteSpace = 'pre-wrap';
    }
    // 按钮状态联动：运行中/启动中 → 只能"停止"；未运行 → 只能"启动"
    const startBtn = ttsEl('tts-start');
    const stopBtn = ttsEl('tts-stop');
    const busy = (s.serviceState === 'running' || s.serviceState === 'starting');
    if (startBtn) { startBtn.disabled = busy; startBtn.style.opacity = busy ? '.45' : ''; startBtn.title = busy ? '服务已在运行' : '启动桌宠自带的 TTS 服务（首次加载模型约 1~3 分钟）'; }
    if (stopBtn) { stopBtn.disabled = !busy; stopBtn.style.opacity = busy ? '' : '.45'; stopBtn.title = busy ? '停止服务（释放显存/内存）' : '服务未运行'; }
    // 状态行文案（含"启动中"）
    const line = ttsEl('tts-status-line');
    if (line) {
      const parts = [];
      parts.push(s.serviceState === 'running' ? '🟢 服务运行中'
        : s.serviceState === 'starting' ? '🟡 服务启动中（正在加载模型，约 1~3 分钟）'
        : s.serviceState === 'disabled' ? '⚪ 语音已关闭（勾选"启用语音"并保存）'
        : '⚪ 服务未运行（点「启动服务」即可）');
      parts.push(c.enabled ? '语音已启用' : '语音未启用');
      parts.push('设备 ' + (c.device || 'cuda'));
      parts.push('语音包 ' + (s.hasVoices ? '已就绪' : '缺失（请在下方下载语音包）'));
      if (s.lastError) parts.push('⚠ ' + s.lastError);
      line.textContent = '状态：' + parts.join(' · ') + '　（数据目录：' + (s.dataRoot || s.voicesRoot || '') + '）';
    }
    if (ttsEl('tts-adv')) {
      try {
        ttsEl('tts-adv').value = JSON.stringify({
          apiPath: c.apiPath, params: c.params, extraBody: c.extraBody,
          refFields: c.refFields, refMode: c.refMode, healthPath: c.healthPath
        }, null, 1);
      } catch (e) { /* noop */ }
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
  // 统一的"保存并应用"（设置页所有可保存项），供按钮与"未保存提示"共用
  async function ttsSave() {
    try { renderTts(await dk.ttsConfig(ttsCollect())); settingsDirty = false; } catch (e) { /* noop */ }
  }
  function saveAllSettings() { ttsSave(); }
  if (ttsEl('tts-save')) ttsEl('tts-save').addEventListener('click', ttsSave);
  // 设置页改动跟踪：任意控件变化即视为"未保存"
  (function bindSettingsDirty() {
    document.querySelectorAll('#view-settings input, #view-settings textarea, #view-settings select').forEach((el) => {
      el.addEventListener('change', markSettingsDirty);
    });
    document.querySelectorAll('#view-settings .ai-btn').forEach((b) => {
      const ignore = ['tts-save', 'tts-open-cache', 'tts-probe', 'tts-start', 'tts-stop', 'tts-install', 'tts-check-update'];
      if (ignore.includes(b.id) || b.classList.contains('tts-voice-btn')) return;
      b.addEventListener('click', markSettingsDirty);
    });
  })();
  if (ttsEl('tts-probe')) ttsEl('tts-probe').addEventListener('click', async () => { try { await dk.ttsProbe(); } catch (e) { /* noop */ } refreshTts(); });
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
  let logTimer = null;
  async function refreshLogs() {
    const box = ttsEl('tts-logbox');
    if (!box || box.style.display === 'none') return;
    try { const t = await dk.ttsGetLogs(300); box.textContent = t; box.scrollTop = box.scrollHeight; } catch (e) { /* noop */ }
  }
  if (ttsEl('tts-logs-toggle')) ttsEl('tts-logs-toggle').addEventListener('click', () => {
    const box = ttsEl('tts-logbox');
    if (!box) return;
    const show = box.style.display === 'none';
    box.style.display = show ? 'block' : 'none';
    ttsEl('tts-logs-toggle').textContent = show ? '📜 收起日志' : '📜 后台日志';
    if (show) { refreshLogs(); logTimer = setInterval(refreshLogs, 2000); }
    else if (logTimer) { clearInterval(logTimer); logTimer = null; }
  });
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
