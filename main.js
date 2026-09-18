// 妄想天使桌宠 - Electron 主进程
// 模式：v2.4 起仅桌面版（透明窗口、点击穿透、角色直接站在桌面上；房间版已移除）
//   控制面板：启动时打开（分别控制三小只开关）；叉掉 = 隐藏到系统托盘
//   调试：--screenshot [delayMs] ["query"] 自动截图退出；--drag-test 自动模拟拖动；--panel-shot [delayMs]
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, clipboard, dialog, globalShortcut, protocol, net } = require('electron');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

let win = null;
let panel = null;
let tray = null;
const DESKTOP = true;   // 仅桌面版（房间版已移除）
const NOTOP = process.env.QX_NOTOP === '1';
// 用户歌曲目录（播放器"添加歌曲"导入处；打包版 assets 只读 → 用户曲目统一放这里）
const USER_BGM_DIR = path.join(process.env.APPDATA || path.dirname(process.execPath), 'ReDreamingAngels', 'bgm');

// ===== pet:// 自定义协议：音频/资源流式加载（避免 base64 data URL 常驻内存）=====
// pet://bgm/xxx.mp3 → assets/bgm/xxx.mp3（不存在则用户歌曲目录）；支持 asar（net.fetch + file://）
try {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'pet',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }]);
} catch (e) { /* noop */ }

// 单实例锁：防止重复启动产生多个桌宠实例（重复双击启动器/vbs → 唤起已有实例的控制台并退出）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); return; }
// ⚠️ 关键：禁用 Chromium 的"原生窗口遮挡计算"（Windows）。
// 默认情况下 Chromium 一旦判定透明桌宠窗口被其它窗口完全遮挡，就会把窗口标记为 occluded，
// 停止其渲染/输入通道；用户实测"被全屏窗口覆盖过一次后，鼠标交互永久失效（待机动画仍正常）"
// 正是这个机制造成的（backgroundThrottling:false 只保证动画，救不了输入通道）。
// 桌面宠物的窗口本来就长期处于"被遮挡/部分遮挡"状态，必须关掉该特性。
// 同时顺带裁剪一批桌宠用不到的 Chromium 服务以降低常驻占用（内存优化）。
const DISABLED_FEATURES = [
  'CalculateNativeWinOcclusion',      // 修"被遮挡后输入失效"（必需）
  'MediaSessionService',              // 媒体会话服务（桌宠不需要系统媒体控制）
  'HardwareMediaKeyHandling',         // 硬件媒体键接管
  'GlobalMediaControls',              // 全局媒体控制按钮
  'Translate',                        // 页面翻译
  'AutofillServerCommunication',      // 自动填充云通信
  'OptimizationHints',                // 优化提示下载
  'InterestFeedContentSuggestions',   // 内容建议
  'CalculateNativeWinOcclusion'       // 去重占位（列表合并为单次 switch）
].join(',');
try { app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES); } catch (e) { /* noop */ }
// 任务栏图标规范：AppUserModelId 保证任务栏/窗口显示正确的应用图标（不回归默认图标）
app.setAppUserModelId('com.master.re-dreaming-angels-desktop-pet');
app.on('second-instance', () => {
  if (panel && !panel.isDestroyed()) panel.show();
  else ensurePanel();
});
// 三小只开关状态（控制面板持有真源）
let idolVis = { airui: true, qianxia: true, nangong: true };
// 一键"显示/隐藏小偶像"：逻辑层隐藏（三只 hidden），窗口永不 hide/show —— 绕开穿透 Bug A
// （win.hide/show 后 setIgnoreMouseEvents(forward) 转发不可靠 → 拖动/右键失效）
let idolsAllHidden = false;
// 设置显示/隐藏（**可指定目标状态**，供控制台勾选框、托盘、救援快捷键共用）
function setIdolsShown(shown) {
  if (!win || win.isDestroyed() || !win.webContents) return !idolsAllHidden;
  idolsAllHidden = !shown;
  for (const key of Object.keys(idolVis)) {
    // 隐藏=全部 false；显示=恢复各滑块状态（idolVis 真源，不覆盖滑块值）
    win.webContents.send('set-idol-visibility', key, shown ? idolVis[key] : false);
  }
  if (panel && !panel.isDestroyed() && panel.webContents) {
    panel.webContents.send('idols-shown', shown);   // 控制台勾选框同步
  }
  return shown;
}
function toggleMainWindow() { return setIdolsShown(idolsAllHidden); }

// 保底召回：把三小只**立即显示在最上层**（脉冲式，~300ms 后恢复用户置顶设置，不锁层级）
// 用途：未置顶时被其它窗口盖住 → 用户按快捷键/点托盘即可让她们立刻出现；之后仍可被正常覆盖。
let activeHotkey = null;   // 实际注册成功的救援快捷键（候选降级后）
function hotkeyLabel() {
  if (!activeHotkey) return '';
  return activeHotkey.replace('Control', 'Ctrl');
}

// ===== 主进程鼠标轮询穿透裁决（核心健壮性机制）=====
// 原理：screen.getCursorScreenPoint() 是系统级取全局鼠标位置（GetCursorPos），**不受窗口遮挡、
// 不受其他进程 SetCapture 影响**；renderer 只负责周期性上报"可交互矩形"（角色 bbox + 打开的浮层）。
// 每 ~70ms 裁决一次：鼠标在矩形内 → 关闭穿透（可交互）+ moveTop；否则开启穿透。
// 相比"依赖 renderer mousemove"的方案：被覆盖/被截图工具接管后可自动恢复，不会永久卡死。
let hitRects = [];              // [{x,y,w,h}] 窗口 client 坐标（CSS px）
let hitForceInteractive = false; // 拖动/编辑等强制可交互
let hitForceSince = 0;           // force 起始时间（超时兜底：renderer 若卡住则不再永久置顶）
let mousePollTimer = null;
let mousePollInside = null;     // null=未初始化（首次必定下发）
let mousePollTicks = 0;
const POLL_LOG = process.env.QX_POLLLOG === '1';

// ===== 交互时"临时置顶"（根治未置顶时的点击死锁）=====
// Windows z-order 铁律：鼠标点击永远由最上层窗口接收。未置顶时窗口沉在下层，
// ===== "立即显示在最上层"（脉冲式，不做层级锁定）=====
// 语义（用户要求）：用户主动召回时，三小只**立刻出现在最上层**；但不锁定层级——
// 短暂置顶(~300ms)后立即恢复用户的置顶设置，此后其它窗口可以正常覆盖她们。
// （旧实现用"临时置顶 5 秒"，那 5 秒内用户无法用别的窗口盖住她们，体验很差，已废弃。）
let userTopmost = true;      // 用户"保持置顶"开关真源
let pulseTimer = null;
function showOnTopOnce(ms) {
  if (!win || win.isDestroyed()) return;
  // 用户主动召回时：如果当前是"隐藏小偶像"状态 → 先恢复显示（用户按快捷键就是要看到她们）
  if (idolsAllHidden) {
    try { setIdolsShown(true); } catch (e) { /* noop */ }
  }
  try {
    win.setAlwaysOnTop(true, 'floating');
    win.moveTop();
  } catch (e) { /* noop */ }
  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => {
    pulseTimer = null;
    try {
      if (!win || win.isDestroyed() || userTopmost) return;
      win.setAlwaysOnTop(false, 'floating');   // 恢复"可被覆盖"
    } catch (e) { /* noop */ }
  }, ms || 300);
}

function startMousePoll() {
  if (mousePollTimer) clearInterval(mousePollTimer);
  mousePollTimer = setInterval(mousePollTick, 70);
}

// ===== 拖动状态守护（针对"截图工具吞掉 mouseup"造成点击全面失效的兜底）=====
// 原理：交叉验证"物理按键状态"与"我们以为的拖动状态"。
//   · renderer 报告拖动中，但系统物理左键已松开（GetAsyncKeyState）→ mouseup 丢失，拖动状态卡死 → 立即清理
//   · 拖动状态持续超过硬上限（用户不可能按住那么久）→ 强制清理
// 只在"疑似拖动"时每 2s 查一次（powershell 调用约 150ms），平时零开销。
let guardBusy = false;
let lastGuardAt = 0;
let dragStuckSince = 0;
function checkMouseGuard() {
  const now = Date.now();
  if (guardBusy || now - lastGuardAt < 2000) return;
  lastGuardAt = now;
  guardBusy = true;
  const script = path.join(__dirname, 'scripts', 'mouse_guard.ps1');
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { timeout: 4000, windowsHide: true }, (err, stdout) => {
      guardBusy = false;
      if (err || !stdout) return;
      const line = String(stdout).trim().split(/\r?\n/).pop() || '';
      const m = line.match(/LEFT=(\w+)\s+FG=([^|]+)\|(\d+)\|(.*)/);
      if (!m) return;
      const leftDown = m[1] === 'DOWN';
      const fgTitle = (m[4] || '').trim();
      if (!hitForceInteractive) return;   // 已不是拖动状态：无需处理
      if (!leftDown) {
        console.log('[GUARD] physical left button is UP but drag state stuck → abort drag | fg=', fgTitle);
        abortDragFromMain('mouseup-lost');
      }
    });
}
function abortDragFromMain(reason) {
  hitForceInteractive = false;
  hitForceSince = 0;
  dragStuckSince = 0;
  try { if (win && !win.isDestroyed()) win.webContents.send('drag-abort', reason); } catch (e) { /* noop */ }
}
// （拖动守护逻辑见下方 mousePollTick 内的 GUARD 段）
// ===== 输入通道心跳 + 自愈 =====
// 背景（用户实测）：桌宠被全屏窗口覆盖过一次后，鼠标交互会永久失效（待机动画仍正常）——
// 即 Chromium 的输入通道被破坏/遮挡判定卡住，而窗口样式、层级、我们的轮询状态全部看起来正常。
// 方案：不猜根因——renderer 上报"鼠标事件计数"，主进程发现"鼠标就在可交互区域、却长时间收不到
// 任何鼠标事件"即判定输入通道失效，并按 L1→L2→L3 递增强度自动修复。
let lastEvtCount = 0;
let lastEvtChangeAt = Date.now();
let healLevel = 0;
let lastHealAt = 0;
let reloadCount = 0;
let prevCursor = { x: -1, y: -1 };
let cursorMovedAt = 0;
// 判据（精确、无误报）：**光标正在移动** 却 **renderer 长时间收不到任何鼠标事件** → 输入通道失效。
// （鼠标静止不动时事件计数本就不增长，不能据此判断——否则会疯狂误报。）
function checkInputChannel(cx, cy) {
  const now = Date.now();
  if (cx >= 0 && (cx !== prevCursor.x || cy !== prevCursor.y)) {
    prevCursor = { x: cx, y: cy };
    cursorMovedAt = now;
  }
  if (mousePollInside !== true) { lastEvtChangeAt = now; return; }   // 鼠标不在可交互区域：无需判断
  if (now - lastHealAt < 3000) return;                               // 自愈限频（3s）
  const cursorActive = (now - cursorMovedAt) < 1200;                 // 光标最近 1.2s 内移动过
  const evtStale = (now - lastEvtChangeAt) > 1200;                   // renderer 却 1.2s 没收到事件
  if (!(cursorActive && evtStale)) return;
  lastHealAt = now;
  healLevel++;
  const level = ((healLevel - 1) % 3) + 1;
  console.log('[SELFHEAL] input channel stalled (cursor moving, no renderer events) → level ' + level + ' (#' + healLevel + ')');
  if (POLL_LOG) {
    try {
      fs.appendFileSync(path.join(__dirname, 'poll_diag.log'),
        new Date().toISOString() + ' SELFHEAL level=' + level + ' stale=' + stale + ' healCount=' + healLevel + '\n');
    } catch (e) { /* noop */ }
  }
  try {
    if (level === 1) {
      // L1：强制刷新穿透状态（值变化才会真正重设窗口扩展样式）
      win.setIgnoreMouseEvents(true, { forward: true });
      setTimeout(() => { try { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false, { forward: true }); } catch (e) { /* noop */ } }, 120);
    } else if (level === 2) {
      // L2：刷新层级 + 轻微改变窗口尺寸（触发窗口重新配置与重绘）
      // ⚠️ 恢复时**必须尊重用户的置顶开关**——早期版本这里无条件 setAlwaysOnTop(true)，
      // 导致"关闭置顶后她们偶尔自己冒到最上层"（用户实测反馈），已修。
      const b = win.getBounds();
      win.setAlwaysOnTop(false, 'floating');
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height + 1 });
      setTimeout(() => {
        try {
          if (!win || win.isDestroyed()) return;
          win.setBounds(b);
          if (userTopmost) win.setAlwaysOnTop(true, 'floating');
          win.moveTop();
        } catch (e) { /* noop */ }
      }, 120);
    } else {
      // L3：兜底——重载渲染进程（会重置角色位置/关闭聊天）；每会话最多 3 次
      if (reloadCount < 3) {
        reloadCount++;
        console.log('[SELFHEAL] L3 reload webContents (' + reloadCount + '/3)');
        win.webContents.reload();
      }
    }
  } catch (e) { /* noop */ }
}
function applyMouseIgnore(inside, cx, cy, why) {
  mousePollInside = inside;
  try {
    if (why === 'resync') {
      // 周期性"强制重应用"：先用相反值再切回——某些平台状态下（被截图工具/其它进程扰动后）
      // 相同值重复下发不会真正刷新窗口扩展样式，值变化才会
      win.setIgnoreMouseEvents(!inside ? false : true, { forward: true });
    }
    win.setIgnoreMouseEvents(!inside, { forward: true });
    // ⚠️ 这里**刻意不做"悬停临时置顶"**：关闭"保持置顶"的语义就是"不抢层级、可以被别的窗口盖住"。
    // 早期为了修"被覆盖无法点击"曾在此处 setInterimTop(true)，副作用是"鼠标一经路过她们就自动浮出、
    // 用户聚焦别的窗口时她们也不被覆盖"（用户实测反馈）。现在改为：只有**用户主动救援**
    // （全局快捷键 / 托盘点击 / 托盘菜单「提到最前」）才会临时置顶。
    if (POLL_LOG) {
      let hit = '';
      if (inside && hitRects.length) {
        for (const r of hitRects) {
          if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) { hit = ' hit=(' + r.x + ',' + r.y + ',' + r.w + 'x' + r.h + ')'; break; }
        }
      }
      console.log('[POLL]', why, inside ? 'INTERACTIVE' : 'passthrough', 'cursor=(' + cx + ',' + cy + ')', 'rects=' + hitRects.length + hit);
      // 持久化现场轨迹（QX_POLLLOG=1 时写入项目根 poll_diag.log，用于复现后取证）
      try {
        const rectsDump = hitRects.slice(0, 4).map((r) => r.x + ',' + r.y + ',' + r.w + 'x' + r.h).join(' | ');
        fs.appendFileSync(path.join(__dirname, 'poll_diag.log'),
          new Date().toISOString() + ' ' + why + ' ' + (inside ? 'INTERACTIVE' : 'passthrough') +
          ' cursor=(' + cx + ',' + cy + ') rects=' + hitRects.length +
          ' ignore=' + (mousePollInside ? 0 : 1) + ' top=' + (win.isAlwaysOnTop() ? 1 : 0) +
           ' focusable=' + (win.isFocusable() ? 1 : 0) + hit +
          ' R[' + rectsDump + ']\n');
      } catch (e) { /* noop */ }
    }
  } catch (e) { /* noop */ }
}
function mousePollTick() {
  if (!win || win.isDestroyed()) return;
  // 超时兜底：force（拖动中）持续 >20s 视为 renderer 状态卡住 → 忽略，避免永久临时置顶
  if (hitForceInteractive && hitForceSince && Date.now() - hitForceSince > 20000) {
    hitForceInteractive = false;
    hitForceSince = 0;
  }
  // GUARD：拖动守护——QQ/截图工具会吞掉 mouseup，使 renderer 的拖动状态卡死（点击全面失效）。
  // 交叉验证物理左键状态（powershell 调 mouse_guard.ps1，仅在疑似拖动时每 2s 一次）。
  if (hitForceInteractive) {
    if (!dragStuckSince) dragStuckSince = Date.now();
    if (Date.now() - dragStuckSince > 12000) {
      console.log('[GUARD] drag state stuck >12s → force abort');
      abortDragFromMain('timeout');
    } else {
      checkMouseGuard();
    }
  } else {
    dragStuckSince = 0;
  }
  let inside = hitForceInteractive;
  let cx = -1, cy = -1;
  if (!inside && hitRects.length) {
    const p = screen.getCursorScreenPoint();   // 屏幕 DIP 坐标（不受遮挡/SetCapture 影响）
    const b = win.getBounds();
    cx = p.x - b.x; cy = p.y - b.y;            // → 窗口 client 坐标（1:1 CSS px）
    for (const r of hitRects) {
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) { inside = true; break; }
    }
  }
  mousePollTicks++;
  // 每 ~1s 强制重下发一次：幂等操作，用于修复被其它程序（截图工具/捕获鼠标）扰动后的平台状态漂移
  const force = (mousePollTicks % 15 === 0);
  if (inside === mousePollInside && !force) return;
  applyMouseIgnore(inside, cx, cy, force ? 'resync' : 'change');
  checkInputChannel(cx, cy);   // 输入通道心跳检测（光标在动却收不到事件 → L1→L2→L3 自愈）
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

  // 桌面版：默认整窗点击穿透；**穿透状态由主进程鼠标轮询统一裁决**（不依赖 renderer 的 mousemove——
  // 被其他窗口覆盖/被 SetCapture（QQ 截图等）接管时窗口收不到鼠标消息会永久死锁，用户实测）
  win.setIgnoreMouseEvents(true, { forward: true });
  startMousePoll();

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
  // 关闭即销毁（省内存：控制台是独立渲染进程，常驻约占 100MB+）；下次打开时重建
  panel.on('closed', () => { panel = null; });
  panel.webContents.on('did-finish-load', () => {
    panel.webContents.send('panel-init', idolVis);
    panel.webContents.send('idols-shown', !idolsAllHidden);
  });
  return panel;
}
// 按需打开控制台（懒加载：启动时不创建，省一个渲染进程的内存）
function ensurePanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return panel; }
  return createPanelWindow();
}

app.whenReady().then(() => {
  // pet:// 协议 handler：音频流式读取（assets 优先，用户歌曲目录兜底；支持 asar 内文件）
  try {
    protocol.handle('pet', (req) => {
      try {
        const u = new URL(req.url);
        const rel = decodeURIComponent((u.hostname || '') + (u.pathname || '')).replace(/^\/+/, '');
        let abs = path.join(__dirname, 'assets', rel);
        if (!fs.existsSync(abs)) {
          const cand = path.join(USER_BGM_DIR, path.basename(rel));
          if (fs.existsSync(cand)) abs = cand;
        }
        if (!fs.existsSync(abs)) return new Response('', { status: 404 });
        return net.fetch(pathToFileURL(abs).toString());
      } catch (e) {
        return new Response('', { status: 404 });
      }
    });
  } catch (e) { console.error('[PET-PROTOCOL] init failed', e); }
  createWindow();
  // ⚠️ 控制台改为**按需创建**（懒加载）：它曾是常驻的独立渲染进程（≈100MB+），
  // 用户反馈内存占用高 → 启动不创建，从托盘/右键菜单打开时才建，关闭即销毁。

  // 系统托盘图标（Hidden-icons menu 入口）
  try {
    tray = new Tray(appIcon(32));
    tray.setToolTip('妄想天使桌宠（点击提到最前）');
    rebuildTrayMenu();
    tray.on('click', () => showOnTopOnce(300));   // 点托盘=召回（比"显示/隐藏"更符合直觉）
  } catch (e) { console.error('tray init failed', e); }
  // 全局快捷键：把三小只提到最前（未置顶被覆盖/被截图工具接管时的救援入口）
  // ⚠️ globalShortcut 需独占注册：被其他软件占用会返回 false → 依次尝试候选，成功即用并告知 UI
  const HOTKEY_CANDIDATES = ['Control+Alt+Z', 'Control+Alt+D', 'Control+Alt+F9', 'Control+Shift+Alt+Z'];
  activeHotkey = null;
  for (const hk of HOTKEY_CANDIDATES) {
    try {
      if (globalShortcut.register(hk, () => showOnTopOnce(300))) { activeHotkey = hk; break; }
    } catch (e) { /* try next */ }
  }
  console.log('[HOTKEY] active =', activeHotkey || '(none)');
  if (tray) { try { tray.setToolTip('妄想天使桌宠（点击提到最前' + (activeHotkey ? ' · ' + hotkeyLabel() : '') + '）'); } catch (e) { /* noop */ } }
  // 调试：QX_FRONTTEST=1 → 启动 5s 后自动执行一次"提到最前"（验证被覆盖时的提层机制）
  if (process.env.QX_FRONTTEST === '1') {
    setTimeout(() => { console.log('[FRONTTEST] bring pet to front now'); showOnTopOnce(600); }, 5000);
  }

  // 调试：QX_AUTOLAUNCH_TEST=1 → 启动时验证"写入→读取"往返（排查开关打不上钩）
  if (process.env.QX_AUTOLAUNCH_TEST === '1') {
    setTimeout(() => {
      try {
        const opts = loginItemOpts();
        const before = !!app.getLoginItemSettings(opts).openAtLogin;
        app.setLoginItemSettings({ openAtLogin: true, path: opts.path, args: opts.args });
        const afterOn = !!app.getLoginItemSettings(opts).openAtLogin;
        app.setLoginItemSettings({ openAtLogin: false, path: opts.path, args: opts.args });
        const afterOff = !!app.getLoginItemSettings(opts).openAtLogin;
        console.log('[AUTOLAUNCH-TEST] before=', before, 'setTrue→', afterOn, 'setFalse→', afterOff);
      } catch (e) { console.log('[AUTOLAUNCH-TEST] error', e.message); }
    }, 1200);
  }

  ipcMain.on('quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.on('toggle-idol-window', () => toggleMainWindow());
  ipcMain.on('panel-minimize', () => {
    if (panel && !panel.isDestroyed()) panel.minimize();
  });
  // 控制台：按需打开（右键菜单入口）+ 显示/隐藏小偶像的状态查询与设置
  ipcMain.on('open-panel', () => ensurePanel());
  ipcMain.handle('get-idols-shown', () => !idolsAllHidden);
  ipcMain.handle('set-idols-shown', (e, shown) => setIdolsShown(!!shown));
  // 控制台「保存配置」→ 通知主窗立即热更新（AI 配置变化由 QX_AI/样式等统一走保存按钮）
  ipcMain.on('ai-config-saved', () => {
    if (win && !win.isDestroyed() && win.webContents) win.webContents.send('ai-config-refresh');
  });
  // 剪贴板（聊天输入右键复制/粘贴/消息复制按钮用）
  ipcMain.handle('clipboard-read', () => clipboard.readText());
  ipcMain.handle('clipboard-write', (e, text) => { clipboard.writeText(String(text == null ? '' : text)); return true; });
  // 实际生效的救援快捷键（供 UI 提示；未被占用时才有值）
  ipcMain.handle('get-hotkey', () => hotkeyLabel());

  // ===== 系统类开关：开机自启动 / 保持置顶 =====
  // ⚠️ Windows 上 getLoginItemSettings 必须与写入时使用**完全相同的 path+args** 才会返回 true，
  //    否则出现"设置成功但开关打不上钩"（用户实测 bug）。
  function loginItemOpts() {
    return { path: process.execPath, args: app.isPackaged ? [] : [path.resolve(__dirname)] };
  }
  ipcMain.handle('get-auto-launch', () => {
    try { return !!app.getLoginItemSettings(loginItemOpts()).openAtLogin; } catch (e) { return false; }
  });
  ipcMain.handle('set-auto-launch', (e, v) => {
    try {
      const opts = loginItemOpts();
      app.setLoginItemSettings({ openAtLogin: !!v, path: opts.path, args: opts.args });
      const now = !!app.getLoginItemSettings(opts).openAtLogin;
      console.log('[AUTOLAUNCH] set', v, '→ now', now);
      return now;
    } catch (err) { console.error('[AUTOLAUNCH] failed', err); return false; }
  });
  ipcMain.handle('get-topmost', () => {
    try { return win && !win.isDestroyed() ? win.isAlwaysOnTop() : true; } catch (e) { return true; }
  });
  ipcMain.handle('set-topmost', (e, v) => {
    try {
      userTopmost = !!v;   // 用户"保持置顶"真源
      if (win && !win.isDestroyed()) {
        // 无条件应用：早期版本在"临时置顶残留"时会跳过关闭分支，导致"关了置顶却仍盖不住别的东西"（用户实测反馈）
        win.setAlwaysOnTop(userTopmost, 'floating');
        if (userTopmost) win.moveTop();
      }
      return !!(win && !win.isDestroyed() && win.isAlwaysOnTop());
    } catch (err) { return false; }
  });

  // ===== 播放器：导入歌曲（对话框多选 → 复制到用户歌曲目录 %APPDATA%/ReDreamingAngels/bgm） =====
  // USER_BGM_DIR 定义在文件顶部（pet:// 协议 handler 也要用）
  ipcMain.handle('import-bgm', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '选择要加入播放器的歌曲',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '音频文件', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'] }]
      });
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true, added: [] };
      fs.mkdirSync(USER_BGM_DIR, { recursive: true });
      const added = [];
      for (const src of r.filePaths) {
        try {
          const base = path.basename(src);
          let dst = path.join(USER_BGM_DIR, base);
          if (fs.existsSync(dst)) {                       // 重名：加序号后缀，避免覆盖
            const ext = path.extname(base);
            const stem = path.basename(base, ext);
            let n = 2;
            while (fs.existsSync(dst)) { dst = path.join(USER_BGM_DIR, stem + '_' + n + ext); n++; }
          }
          fs.copyFileSync(src, dst);
          added.push(path.basename(dst));
        } catch (err) { /* 单个失败跳过 */ }
      }
      return { ok: added.length > 0, added };
    } catch (err) {
      return { ok: false, error: err.message, added: [] };
    }
  });
  ipcMain.handle('list-user-bgm', () => {
    try {
      if (!fs.existsSync(USER_BGM_DIR)) return [];
      return fs.readdirSync(USER_BGM_DIR).filter((f) => /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f));
    } catch (e) { return []; }
  });

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
  // 鼠标穿透切换：**已由主进程轮询统一裁决**（见 mousePollTick）；此 IPC 保留作兼容/手动覆盖
  ipcMain.on('set-mouse-ignore', (e, ignore) => {
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  // renderer 上报"可交互矩形"（角色 bbox + 打开的浮层）→ 主进程轮询裁决穿透；同时上报鼠标事件计数（心跳）
  ipcMain.on('hit-rects', (e, payload) => {
    if (!payload) return;
    hitRects = Array.isArray(payload.rects) ? payload.rects : [];
    const f = !!payload.force;
    if (f && !hitForceInteractive) hitForceSince = Date.now();
    if (!f) hitForceSince = 0;
    hitForceInteractive = f;
    const ec = payload.evtCount | 0;
    if (ec !== lastEvtCount) { lastEvtCount = ec; lastEvtChangeAt = Date.now(); }
  });
  // 显式提起窗口层级（浮层显示/菜单弹出等场景；不改变 alwaysOnTop 属性）
  ipcMain.on('move-top', () => {
    if (win && !win.isDestroyed()) { try { win.moveTop(); } catch (e) { /* noop */ } }
  });
  ipcMain.on('context-menu', () => { /* 菜单已迁移为 renderer DOM 菜单 */ });

  // 调试：--panel-shot [delayMs] 截图控制面板（懒加载后需先创建）
  const panelShotArg = process.argv.indexOf('--panel-shot');
  if (panelShotArg !== -1) {
    const delay = parseInt(process.argv[panelShotArg + 1] || '1800', 10) || 1800;
    setTimeout(async () => {
      try {
        ensurePanel();   // 控制台按需创建：调试截图前先确保存在
        await new Promise((r) => setTimeout(r, 1200));
        const img = await panel.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'panel-shot.png'), img.toPNG());
        console.log('panel-shot saved');
      } catch (e) { console.error('panel-shot failed', e); }
      app.exit(0);
    }, delay + 200);
  }
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { /* noop */ } });

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '📌 把三小只提到最前', click: () => showOnTopOnce(300) },
    { label: '打开控制面板', click: () => ensurePanel() },
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
