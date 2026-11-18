// Patches for main-win32.js (Qobuz 8.3.0-b028), matched against the minified
// bundle. Each `find` must occur exactly `count` (default 1) times, so a
// Qobuz update that moves this code fails the build instead of silently
// producing a broken app.
module.exports = [
  {
    // Window-controls overlay: the shared code has a "linux" layout, but the
    // win32 build hardcodes the device type.
    name: 'title-bar overlay uses linux layout',
    find: 'getDeviceType(){return"windows"}',
    replace: 'getDeviceType(){return"linux"}',
  },
  {
    // Taskbar thumbnail toolbar/tooltip are Windows-only BrowserWindow APIs and
    // throw on Linux every time the play queue changes. Keep the window title.
    name: 'drop Windows thumbar calls',
    find: 'A.win.setThumbnailToolTip(t),A.win.setTitle(i),A.win.setThumbarButtons(a)',
    replace: 'A.win.setTitle(i)',
  },
  {
    // Squirrel.Windows auto-update + UI hot-swap into the app directory: no
    // Squirrel on Linux and the AppImage mount is read-only.
    name: 'disable Windows auto-updater',
    find: 'init:function(e,a){v("[DESKTOP] RECHERCHE DE MISE A JOUR")',
    replace: 'init:function(e,a){return;v("[DESKTOP] RECHERCHE DE MISE A JOUR")',
  },
  {
    // Login: the UI navigates to Qobuz's web sign-in page with
    // redirect_url=qobuzapp://..., and this guard sends that page to the
    // system browser. On Windows the OS hands the qobuzapp:// redirect back to
    // Qobuz.exe; on Linux the scheme may be unregistered or owned by another
    // app, so the code never arrives. Instead, open sign-in in an in-app
    // window and catch the qobuzapp:// redirect there, delivering it through
    // the same "open-url" channel the OS deep link would use.
    name: 'in-app OAuth sign-in window',
    find: 'a.startsWith("mailto")||(e.preventDefault(),t.shell.openExternal(a))}))',
    replace:
      'a.startsWith("mailto")||(e.preventDefault(),/\\/signin\\/oauth/.test(a)?(()=>{' +
        'const w=new t.BrowserWindow({width:560,height:760,parent:i,autoHideMenuBar:!0,title:"Qobuz - Log in",' +
          'webPreferences:{sandbox:!0,contextIsolation:!0,nodeIntegration:!1}});' +
        'let done=!1;' +
        'const h=(ev,u)=>{if(!done&&"string"==typeof u&&u.startsWith("qobuzapp:")){done=!0;ev&&ev.preventDefault&&ev.preventDefault();' +
          'A.send("open-url",u),i.show(),i.focus(),setImmediate((()=>{w.isDestroyed()||w.destroy()}))}};' +
        'w.webContents.on("will-redirect",h),w.webContents.on("will-navigate",h),' +
        'w.webContents.on("did-fail-load",((ev,c,d,u)=>h(null,u))),' +
        'w.webContents.setWindowOpenHandler((({url:u})=>u.startsWith("qobuzapp:")?(h(null,u),{action:"deny"}):/^https:/.test(u)?{action:"allow"}:(t.shell.openExternal(u),{action:"deny"}))),' +
        'w.webContents.on("did-create-window",(c=>{c.webContents.on("will-redirect",h),c.webContents.on("will-navigate",h)})),' +
        'w.loadURL(a)})():t.shell.openExternal(a))}))',
  },
  {
    // Tray: Linux can't decode .ico, so the tray icon was blank. Use the
    // shipped 1024px PNG scaled for the tray, add a tooltip, and let a system
    // shutdown/logout bypass close-to-tray.
    name: 'tray uses PNG icon',
    find: 'l=new t.Tray(`${r.default.APP_ICON}.ico`),',
    replace:
      'l=new t.Tray(t.nativeImage.createFromPath(`${r.default.APP_ICON}.png`).resize({width:32,height:32,quality:"best"})),' +
      'l.setToolTip("Qobuz"),t.powerMonitor.on("shutdown",(()=>{t.app.__qbzForceClose=!0})),',
  },
  {
    // Taskbar/window icon (was a generic icon: no icon passed on Linux).
    name: 'main window icon',
    find: 'frame:!1,...p.default.getInitialTitleBarOverlay()',
    // 1024px is too large for the X11 _NET_WM_ICON property (gets truncated);
    // scale to 256px.
    replace:
      'frame:!1,icon:t.nativeImage.createFromPath(S.join(g.STATIC_PATH,"icons","prod","icon.png")).resize({width:256,height:256,quality:"best"}),' +
      '...p.default.getInitialTitleBarOverlay()',
  },
  {
    // Close button hides to tray; real quits (tray "Quit", app.quit, system
    // shutdown) set isQuitting / __qbzForceClose and close normally.
    name: 'close to tray',
    find: 'm.default.registerWindowPosition(i),A.win=null}))',
    replace:
      'm.default.registerWindowPosition(i),t.app.isQuitting||t.app.__qbzForceClose?A.win=null:(e.preventDefault(),i.hide())}))',
  },
  {
    // First-run "updating" window downloads a newer UI bundle into the app
    // directory (read-only in an AppImage). Go straight to the main window.
    name: 'skip first-run UI download window',
    find: 'then((()=>{if(e){const e=new m.BrowserWindow({show:!0,frame:!1,width:430',
    replace: 'then((()=>{if(!1){const e=new m.BrowserWindow({show:!0,frame:!1,width:430',
  },
];
