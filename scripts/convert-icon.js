// 一次性工具：把 WebP 图标（assets/icon.webp）转成 PNG（Electron nativeImage 不支持 webp）
// 运行：npx electron scripts/convert-icon.js
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const base64 = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.webp')).toString('base64');

app.whenReady().then(() => {
  const html = 'data:text/html,<html><body><img id="i"><script>' +
    'const i=document.getElementById("i");i.onload=()=>{const c=document.createElement("canvas");' +
    'c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext("2d").drawImage(i,0,0);' +
    'window.__SRC=c.toDataURL("image/png");};i.src="data:image/webp;base64,' + base64 + '";</script></body></html>';
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true } });
  w.loadURL(html);
  w.webContents.on('did-finish-load', () => {
    const poll = setInterval(() => {
      w.webContents.executeJavaScript('window.__SRC || ""').then((src) => {
        if (src && src.startsWith('data:image/png')) {
          clearInterval(poll);
          const b64 = src.split(',')[1];
          fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), Buffer.from(b64, 'base64'));
          console.log('icon.png saved', b64.length);
          app.quit();
        }
      }).catch(() => {});
    }, 200);
    setTimeout(() => { console.error('timeout'); app.exit(1); }, 8000);
  });
});
