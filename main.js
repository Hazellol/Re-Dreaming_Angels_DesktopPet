// 妄想天使桌宠 - Electron 主进程
// 模式：v2.4 起仅桌面版（透明窗口、点击穿透、角色直接站在桌面上；房间版已移除）
//   控制面板：启动时打开（分别控制三小只开关）；叉掉 = 隐藏到系统托盘
//   调试：--screenshot [delayMs] ["query"] 自动截图退出；--drag-test 自动模拟拖动；--panel-shot [delayMs]
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let panel = null;
let tray = null;
const DESKTOP = true;   // 仅桌面版（房间版已移除）
const NOTOP = process.env.QX_NOTOP === '1';

// 单实例锁：防止重复启动产生多个桌宠实例（重复双击启动器/vbs → 唤起已有实例的控制台并退出）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }
// 任务栏图标规范：AppUserModelId 保证任务栏/窗口显示正确的应用图标（不回归默认图标）
app.setAppUserModelId('com.master.re-dreaming-angels-desktop-pet');
app.on('second-instance', () => {
  if (panel && !panel.isDestroyed()) panel.show();
  else createPanelWindow();
});
// 三小只开关状态（控制面板持有真源）
let idolVis = { airui: true, qianxia: true, nangong: true };
// 一键"显示/隐藏小偶像"：逻辑层隐藏（三只 hidden），窗口永不 hide/show —— 绕开穿透 Bug A
// （win.hide/show 后 setIgnoreMouseEvents(forward) 转发不可靠 → 拖动/右键失效）
let idolsAllHidden = false;
function toggleMainWindow() {
  if (!win || win.isDestroyed() || !win.webContents) return;
  idolsAllHidden = !idolsAllHidden;
  for (const key of Object.keys(idolVis)) {
    // 隐藏=全部 false；显示=恢复各滑块状态（idolVis 真源，不覆盖滑块值）
    win.webContents.send('set-idol-visibility', key, idolsAllHidden ? false : idolVis[key]);
  }
}

function appIcon(size) {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    if (!img.isEmpty()) return size ? img.resize({ width: size, height: size }) : img;
  } catch (e) { /* fallback */ }
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: true,          // 任务栏不显示（图标进系统托盘）
    icon: appIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  // 不抢焦点：桌面版平时窗口不可聚焦（视频/游戏不会因聚焦桌宠而黑屏/暂停）；
  // 仅在需要输入（数字框聚焦）时通过 IPC 临时放行（见 renderer focusin/focusout）
  if (!NOTOP) win.setAlwaysOnTop(true, 'floating');
  win.setFocusable(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 桌面版：默认整窗点击穿透（鼠标事件转发给 renderer，由 renderer 决定是否放行互动）
  win.setIgnoreMouseEvents(true, { forward: true });

  // 调试截图参数：electron . --screenshot [delayMs] ["anim0=动作_X&anim1=表情_Y"]
  const shotArg = process.argv.indexOf('--screenshot');
  const queryStr = process.argv[shotArg + 2];
  const loadOpts = queryStr ? { query: Object.fromEntries(new URLSearchParams(queryStr)) } : undefined;

  win.loadFile(path.join(__dirname, 'src', 'index.html'), loadOpts);
  win.once('ready-to-show', () => win.showInactive());   // 不抢焦点（桌面不会因点击桌宠而停摆）
  win.on('closed', () => { win = null; });
  // 窗口重新显示时：重置穿透状态并通知 renderer 放行（修复 hide/show 后拖不动/点不了的 bug）
  win.on('show', () => {
    win.setIgnoreMouseEvents(true, { forward: true });
    if (win && win.webContents) win.webContents.send('main-shown');
  });

  win.webContents.on('did-finish-load', () => {
    // 同步角色开关初始状态
    win.webContents.send('set-idol-visibility', 'airui', idolVis.airui);
    win.webContents.send('set-idol-visibility', 'qianxia', idolVis.qianxia);
    win.webContents.send('set-idol-visibility', 'nangong', idolVis.nangong);
    // 调试：QX_ENTEST=1 复现"隐藏→显示→拖动/点击"
    if (process.env.QX_ENTEST === '1') {
      setTimeout(() => win.webContents.send('set-idol-visibility', 'airui', false), 1200);
      setTimeout(() => win.webContents.send('set-idol-visibility', 'airui', true), 2400);
    }
    // 调试：QX_WINTOG=1 复现"窗口 hide/show（控制台显示/隐藏小偶像）后交互失效"
    if (process.env.QX_WINTOG === '1') {
      setTimeout(() => win.hide(), 1200);
      setTimeout(() => win.showInactive(), 2200);
    }
    // 调试：QX_ONETOG=1 模拟"显示/隐藏小偶像"一键显隐时序（逻辑层；1200ms 隐藏全部 → 2400ms 恢复）
    if (process.env.QX_ONETOG === '1') {
      setTimeout(() => toggleMainWindow(), 1200);
      setTimeout(() => toggleMainWindow(), 2400);
      // 恢复后 1.2s：模拟点击千夏（验证恢复后交互链路；坐标=窗口 css 像素比例）
      setTimeout(() => {
        const d = screen.getPrimaryDisplay().bounds;
        const wc = win.webContents;
        const cx = Math.round(d.width * 0.78), cy = Math.round(d.height * 0.85);
        wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
        console.log('[CLICKTEST] click at', cx, cy);
      }, 3600);
    }
    // 调试：QX_FRONTTEST=1 点击音量面板头部（验证"点击聚焦置顶"；需配合 QX_VOLPANEL+QX_MUSICPANEL）
    if (process.env.QX_FRONTTEST === '1') {
      setTimeout(() => {
        const d = screen.getPrimaryDisplay().bounds;
        const wc = win.webContents;
        const cx = Math.round(d.width * 0.19), cy = Math.round(d.height * 0.34);
        wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
        console.log('[FRONTTEST] click', cx, cy);
      }, 2400);
    }
  });

  if (shotArg !== -1) {
    const delay = parseInt(process.argv[shotArg + 1] || '3000', 10) || 3000;
    win.webContents.on('did-finish-load', () => {
      // 调试：--drag-test 自动模拟"按住目标拖到右上方"（目标点 QX_DRAGX/QX_DRAGY 比例；触发延迟 QX_DRAG_DELAY ms）
      if (process.argv.includes('--drag-test')) {
        setTimeout(() => {
          const wc = win.webContents;
          const dxr = parseFloat(process.env.QX_DRAGX || '0.70') || 0.70;
          const dyr = parseFloat(process.env.QX_DRAGY || '0.72') || 0.72;
          const cx = Math.round(width * dxr), cy = Math.round(height * dyr);
          wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
          for (let i = 1; i <= 10; i++) {
            wc.sendInputEvent({ type: 'mouseMove', x: cx + i * 20, y: cy - i * 10 });
            wc.sendInputEvent({ type: 'mouseMove', x: cx + i * 20, y: cy - i * 10 });
          }
          setTimeout(() => {
            wc.sendInputEvent({ type: 'mouseUp', x: cx + 200, y: cy - 100, button: 'left', clickCount: 1 });
          }, 300);
        }, parseInt(process.env.QX_DRAG_DELAY || '1200', 10) || 1200);
      }
      // watchdog：防止 capturePage 挂起拖死调试
      const hard = setTimeout(() => {
        console.error('watchdog timeout, force exit');
        app.exit(2);
      }, delay + 10000);
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, 'shot.png'), img.toPNG());
          console.log('screenshot saved:', path.join(__dirname, 'shot.png'));
        } catch (e) { console.error('screenshot failed', e); }
        clearTimeout(hard);
        app.quit();
      }, delay);
    });
  }
}

// ================= 控制面板窗口（三小只开关；叉掉=隐藏到托盘） =================
function createPanelWindow() {
  const display = screen.getPrimaryDisplay();
  const pw = 720, ph = 650;
  panel = new BrowserWindow({
    width: pw, height: ph,
    x: display.bounds.x + Math.round((display.bounds.width - pw) / 2),
    y: display.bounds.y + Math.round((display.bounds.height - ph) / 2) - 40,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: false,          // 任务栏可见（用户要求）
    alwaysOnTop: false,
    icon: appIcon(),
    backgroundColor: '#fff6fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  panel.loadFile(path.join(__dirname, 'src', 'panel.html'));
  panel.once('ready-to-show', () => panel.show());
  // 叉掉任务栏窗口 = 隐藏（不关闭桌宠，转托盘）
  panel.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); panel.hide(); }
  });
  panel.on('closed', () => { panel = null; });
  panel.webContents.on('did-finish-load', () => {
    panel.webContents.send('panel-init', idolVis);
  });
  return panel;
}

app.whenReady().then(() => {
  createWindow();
  createPanelWindow();

  // 系统托盘图标（Hidden-icons menu 入口）
  try {
    tray = new Tray(appIcon(32));
    tray.setToolTip('妄想天使桌宠');
    rebuildTrayMenu();
    tray.on('click', () => toggleMainWindow());
  } catch (e) { console.error('tray init failed', e); }

  ipcMain.on('quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.on('toggle-idol-window', () => toggleMainWindow());
  ipcMain.on('panel-minimize', () => {
    if (panel && !panel.isDestroyed()) panel.minimize();
  });
  // 控制台「保存配置」→ 通知主窗立即热更新（AI 配置变化由 QX_AI/样式等统一走保存按钮）
  ipcMain.on('ai-config-saved', () => {
    if (win && !win.isDestroyed() && win.webContents) win.webContents.send('ai-config-refresh');
  });
  // 剪贴板（聊天输入右键复制/粘贴/消息复制按钮用）
  ipcMain.handle('clipboard-read', () => clipboard.readText());
  ipcMain.handle('clipboard-write', (e, text) => { clipboard.writeText(String(text == null ? '' : text)); return true; });

  // ===== AI 对话（DeepSeek）：渲染进程经 IPC 转发到主进程请求（浏览器 CORS 限制，Node fetch 无此限制） =====
  // payload: { role, messages:[{role,content}...], cfg:{apiKey,model,temperature,maxTokens,webSearch} }
  // 联网模式：走 Responses API（tools:[web_search] 服务端搜索 + tool_choice:auto 模型自主决定）
  // 内容统一清理：剥离模型思考块 <think>…</think>（V4 偶发把思考写进正文，会污染台词/用户界面/互聊解析）
  function stripThink(s) {
    let t = String(s == null ? '' : s);
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    t = t.replace(/<think>[\s\S]*$/gi, '');
    return t.replace(/^\s+|\s+$/g, '');
  }
  function extractResponsesText(data) {
    if (data && typeof data.output_text === 'string' && data.output_text) return data.output_text;
    if (data && Array.isArray(data.output)) {
      let t = '';
      for (const item of data.output) {
        if (item && item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c && c.type === 'output_text' && c.text) t += c.text;
          }
        }
      }
      return t;
    }
    return '';
  }
  async function deepseekChatCompletions(messages, cfg) {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model || 'deepseek-v4-flash',
        messages: messages || [],
        temperature: (typeof cfg.temperature === 'number') ? cfg.temperature : 1.0,
        max_tokens: cfg.maxTokens || 256,
        thinking: { type: 'disabled' },   // 聊天场景：关闭思考模式（更快、temperature/max_tokens 语义正常）
        stream: false
      })
    });
    let data = null;
    try { data = await res.json(); } catch (err) { /* non-json */ }
    if (!res.ok) return { ok: false, error: (data && data.error && data.error.message) || ('HTTP ' + res.status) };
    return { ok: true, content: stripThink((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '') };
  }
  async function deepseekResponsesWeb(messages, cfg) {
    // Responses API：instructions=人设 system；input=其余消息；web_search 由服务端执行
    const sysMsg = (messages || []).find((m) => m.role === 'system');
    const input = (messages || []).filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const body = {
      model: cfg.model || 'deepseek-v4-flash',
      instructions: (sysMsg && sysMsg.content) || '',
      input,
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      // 联网模式：V4 思考模式 + web_search 均消耗 output token（实测 256 会 incomplete、
      // 1024 仍可能截断句尾）→ 联网专用放宽到 4096（用户字数上限不再约束联网轮次）
      max_output_tokens: 4096,
      stream: false
    };
    if (typeof cfg.temperature === 'number') body.temperature = cfg.temperature;
    const res = await fetch('https://api.deepseek.com/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (err) { /* non-json */ }
    if (!res.ok) return { ok: false, error: (data && data.error && data.error.message) || ('HTTP ' + res.status) };
    return { ok: true, content: stripThink(extractResponsesText(data)) };
  }
  ipcMain.handle('ai-chat', async (e, payload) => {
    try {
      const { messages, cfg } = payload || {};
      if (!cfg || !cfg.apiKey) return { ok: false, error: '尚未配置 API Key' };
      if (cfg.webSearch) return await deepseekResponsesWeb(messages, cfg);
      return await deepseekChatCompletions(messages, cfg);
    } catch (err) {
      return { ok: false, error: '请求失败: ' + err.message };
    }
  });
  // 连接测试：发一条最小请求
  ipcMain.handle('ai-test', async (e, cfg) => {
    try {
      if (!cfg || !cfg.apiKey) return { ok: false, error: '请先填写 API Key' };
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model || 'deepseek-v4-flash',
          messages: [{ role: 'user', content: '你好' }],
          max_tokens: 8,
          thinking: { type: 'disabled' },
          stream: false
        })
      });
      let data = null;
      try { data = await res.json(); } catch (err) { /* non-json */ }
      if (!res.ok) return { ok: false, error: (data && data.error && data.error.message) || ('HTTP ' + res.status) };
      return { ok: true, content: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '' };
    } catch (err) {
      return { ok: false, error: '连接失败: ' + err.message };
    }
  });
  ipcMain.on('panel-visibility', (e, payload) => {
    if (!payload || !(payload.key in idolVis)) return;
    idolVis[payload.key] = !!payload.on;
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('set-idol-visibility', payload.key, idolVis[payload.key]);
    }
    if (panel && !panel.isDestroyed()) panel.webContents.send('panel-init', idolVis);
  });
  ipcMain.on('set-focusable', (e, v) => {
    if (win && !win.isDestroyed()) win.setFocusable(!!v);
  });
  ipcMain.on('set-mouse-ignore', (e, ignore) => {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('context-menu', () => { /* 菜单已迁移为 renderer DOM 菜单 */ });

  // 调试：--panel-shot [delayMs] 截图控制面板
  const panelShotArg = process.argv.indexOf('--panel-shot');
  if (panelShotArg !== -1) {
    const delay = parseInt(process.argv[panelShotArg + 1] || '1800', 10) || 1800;
    setTimeout(async () => {
      try {
        const img = await panel.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'panel-shot.png'), img.toPNG());
        console.log('panel-shot saved');
      } catch (e) { console.error('panel-shot failed', e); }
      app.exit(0);
    }, delay + 200);
  }
});

app.on('before-quit', () => { app.isQuitting = true; });

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制面板', click: () => { if (panel && !panel.isDestroyed()) panel.show(); else createPanelWindow(); } },
    { label: '显示/隐藏小偶像', click: () => toggleMainWindow() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

app.on('window-all-closed', () => {
  // 保持托盘存活；显式退出走 app.quit()
  if (tray) return;
  app.quit();
});
