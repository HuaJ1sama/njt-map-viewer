'use strict';

/**
 * 端到端自检：在临时 userData 目录里跑一遍真实窗口，
 * 覆盖热点导航、图片协议、缩放钳制、标注绘制与持久化、热区校准持久化。
 * 用法：npm run smoke
 */

const { app } = require('electron');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'njt-smoke-'));
app.setPath('userData', tempUserData);

const main = require('../src/main/main.js');

const checks = [];
let exitCode = 0;

/** 退出后再删临时目录：窗口关闭时 Chromium 仍持有文件句柄。 */
function cleanupAfterExit() {
  if (!tempUserData.startsWith(os.tmpdir())) return;
  const script = `setTimeout(() => { try { require('fs').rmSync(${JSON.stringify(tempUserData)}, { recursive: true, force: true }); } catch (e) {} }, 1200)`;
  try {
    spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref();
    console.log(`已在后台安排清理临时数据目录：${tempUserData}`);
  } catch (error) {
    console.log(`临时目录清理安排失败（不影响结果）：${error.message}`);
  }
}
const record = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass), detail: String(detail) });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForApp(win, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const ready = await win.webContents.executeJavaScript('window.__njtReady === true');
      if (ready) return true;
    } catch {
      /* 页面可能还在加载 */
    }
    await sleep(200);
  }
  return false;
}

/** 启动加载页收起前会盖住整个窗口、吃掉鼠标事件，所以要等它退场再模拟点击。 */
async function waitForLoadingGone(win, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const gone = await win.webContents
      .executeJavaScript("document.getElementById('loading').classList.contains('hidden')")
      .catch(() => true);
    if (gone) return true;
    await sleep(100);
  }
  return false;
}

async function run() {
  const win = await main.readyPromise;
  const startedAt = Date.now();
  const ready = await waitForApp(win);
  record('渲染进程启动完成', ready, `界面可用耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
  if (!ready) throw new Error('渲染进程未能启动');

  // 启动公告：本版本第一次打开应该弹出来，勾「不再提醒」后写进 settings.json
  await sleep(1000);
  const announceShown = await win.webContents.executeJavaScript(`(() => {
    const modal = document.getElementById('announce-modal');
    return {
      open: window.__njt.announcement.state().open,
      visible: !modal.classList.contains('hidden'),
      title: document.getElementById('announce-title').textContent,
      items: Array.from(document.querySelectorAll('#announce-list li')).map((li) => li.textContent),
      version: window.__njt.announcement.state().version,
    };
  })()`);
  record(
    '启动时弹出本版本更新公告',
    announceShown.open &&
      announceShown.visible &&
      announceShown.items.length >= 3 &&
      announceShown.items.some((item) => item.includes('橡皮擦')) &&
      announceShown.title.includes('1.0.1'),
    JSON.stringify(announceShown),
  );
  const announceClosed = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('announce-mute').checked = true;
    document.getElementById('btn-announce-ok').click();
    return {
      state: window.__njt.announcement.state(),
      hidden: document.getElementById('announce-modal').classList.contains('hidden'),
    };
  })()`);
  await sleep(400);
  const settingsAfterAnnounce = JSON.parse(fs.readFileSync(main.paths.settingsFile(), 'utf8'));
  record(
    '公告可以关掉，勾「不再提醒」会写进 settings.json',
    !announceClosed.state.open &&
      announceClosed.hidden &&
      announceClosed.state.muted &&
      announceClosed.state.seen === '1.0.1' &&
      settingsAfterAnnounce.announcement?.muted === true &&
      settingsAfterAnnounce.announcement?.seen === '1.0.1',
    `${JSON.stringify(announceClosed.state)} / 文件里 ${JSON.stringify(settingsAfterAnnounce.announcement)}`,
  );

  // 右下角版本旁边的「公告」按钮：随时能再翻一遍（勾了不再提醒也一样）
  const announceButton = await win.webContents.executeJavaScript(`(() => {
    const btn = document.getElementById('btn-announce');
    if (!btn) return null;
    const versionAt = document.getElementById('credit-version').getBoundingClientRect();
    const btnAt = btn.getBoundingClientRect();
    const besideVersion = Math.abs(btnAt.top - versionAt.top) < 14 && btnAt.left >= versionAt.left;
    btn.click();
    return {
      text: btn.textContent.trim(),
      besideVersion,
      visible: btn.offsetParent !== null,
      opened: window.__njt.announcement.state().open && !document.getElementById('announce-modal').classList.contains('hidden'),
      items: document.querySelectorAll('#announce-list li').length,
      muteChecked: document.getElementById('announce-mute').checked,
    };
  })()`);
  record(
    '版本旁边有「公告」按钮，点了能再看公告',
    Boolean(announceButton) &&
      announceButton.visible &&
      announceButton.besideVersion &&
      announceButton.text === '公告' &&
      announceButton.opened &&
      announceButton.items >= 3 &&
      announceButton.muteChecked === true,
    JSON.stringify(announceButton),
  );
  await win.webContents.executeJavaScript('window.__njt.announcement.close(); true');
  await sleep(150);

  const battery = await win.webContents.executeJavaScript('window.__njt.selfCheck()');
  for (const item of battery.results) record(item.name, item.pass, item.detail);
  record('页面自检整体通过', battery.ok);

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const credit = await win.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('.credit');
    const link = document.getElementById('credit-author');
    if (!box) return null;
    return {
      text: box.textContent.replace(/\\s+/g, ' ').trim(),
      href: link ? link.href : '',
      shown: getComputedStyle(box).display !== 'none',
    };
  })()`);
  record(
    '主界面右下角署名（名称 / 版本 / 作者链接）',
    Boolean(credit) &&
      credit.shown &&
      credit.text.includes(`v${pkg.version}`) &&
      credit.text.includes('一只非常屑的彩虹滑稽') &&
      credit.href === 'https://space.bilibili.com/500638825?spm_id_from=333.1007.0.0',
    credit ? credit.text : '页面里没有 .credit',
  );

  const mapsDir = main.paths.mapsDir();
  const config = JSON.parse(fs.readFileSync(main.paths.configFile(), 'utf8'));
  const missing = config.regions
    .map((region) => region.image)
    .filter((file) => !fs.existsSync(path.join(mapsDir, file)));
  record('原图文件齐全且未被改动', missing.length === 0, missing.length ? missing.join(',') : '14 张图片可读');
  const imageFiles = fs.readdirSync(mapsDir).filter((name) => /\.(jpe?g|png|webp)$/i.test(name));
  record('原图目录里的地图图片仍是 14 张', imageFiles.length === 14, `${imageFiles.length} 张（其它类型文件不计）`);

  await win.webContents.executeJavaScript('window.__njt.openRegion("factory")');
  await win.webContents.executeJavaScript('window.__njt.drawShape("arrow", [0.1, 0.1], [0.3, 0.3])');
  await win.webContents.executeJavaScript('window.__njt.save()');
  await sleep(150);

  const annotationsFile = main.paths.annotationsFile();
  const annotations = JSON.parse(fs.readFileSync(annotationsFile, 'utf8'));
  const factoryShapes = annotations?.maps?.factory?.shapes || [];
  record(
    '标注写入 userData/annotations.json',
    factoryShapes.length === 1 && factoryShapes[0].type === 'arrow',
    `${annotationsFile} → ${factoryShapes.length} 个形状`,
  );

  win.webContents.reload();
  const readyAgain = await waitForApp(win);
  const reloadError = readyAgain
    ? ''
    : await win.webContents
        .executeJavaScript('`阶段=${window.__njtInitStage || "无"} / ${window.__njtLastError || "没有记录到错误"}`')
        .catch(() => '读不到错误');
  record('窗口重载后仍可工作', readyAgain, reloadError);
  if (readyAgain) {
    await win.webContents.executeJavaScript('window.__njt.openRegion("factory")');
    const restored = await win.webContents.executeJavaScript('window.__njt.shapes()');
    record('重载后标注按地图恢复', restored.length === 1 && restored[0].type === 'arrow', `原样恢复 ${restored.length} 个形状`);
    await win.webContents.executeJavaScript('window.__njt.goOverview()');
    const other = await win.webContents.executeJavaScript('window.__njt.openRegion("forest").then(() => window.__njt.shapes())');
    record('不同地图的标注互不串台', other.length === 0, `森林 ${other.length} 个形状`);
    await win.webContents.executeJavaScript('window.__njt.goOverview()');
    await sleep(1000);
    const announceAfterReload = await win.webContents.executeJavaScript(`({
      open: window.__njt.announcement.state().open,
      hidden: document.getElementById('announce-modal').classList.contains('hidden'),
      muted: window.__njt.announcement.state().muted,
    })`);
    record(
      '勾了「不再提醒」以后重开不再弹公告',
      announceAfterReload.muted === true && announceAfterReload.open === false && announceAfterReload.hidden === true,
      JSON.stringify(announceAfterReload),
    );
  }

  const rows = await win.webContents.executeJavaScript('window.__njt.calibrate.enable(true); window.__njt.calibrate.listRows().length');
  record('校准面板列出全部地区', rows === config.regions.length, rows);
  const moved = await win.webContents.executeJavaScript('window.__njt.calibrate.move("icebreaker", 0.2, 0.2)');
  await sleep(500);
  const hotspotsFile = main.paths.hotspotsFile();
  const hotspots = JSON.parse(fs.readFileSync(hotspotsFile, 'utf8'));
  record(
    '校准结果写入 userData/hotspots.json',
    Array.isArray(hotspots?.hotspots?.icebreaker) && Math.abs(hotspots.hotspots.icebreaker[0] - 0.2) < 1e-6,
    `${JSON.stringify(moved)} → ${JSON.stringify(hotspots?.hotspots?.icebreaker)}`,
  );

  win.webContents.reload();
  const readyThird = await waitForApp(win);
  const persisted = await win.webContents.executeJavaScript(
    'window.__njt.hotspots().find((item) => item.id === "icebreaker").hotspot',
  );
  record(
    '重载后校准位置依然生效',
    readyThird && Math.abs(persisted[0] - 0.2) < 1e-6 && Math.abs(persisted[1] - 0.2) < 1e-6,
    JSON.stringify(persisted),
  );

  await win.webContents.executeJavaScript('window.__njt.calibrate.reset()');
  await sleep(500);
  const afterReset = await win.webContents.executeJavaScript(
    'window.__njt.hotspots().find((item) => item.id === "icebreaker").hotspot',
  );
  record(
    '恢复默认位置回到配置坐标',
    Math.abs(afterReset[0] - 0.1025) < 1e-6 && Math.abs(afterReset[1] - 0.2991) < 1e-6,
    JSON.stringify(afterReset),
  );
  await win.webContents.executeJavaScript('window.__njt.calibrate.enable(false)');

  // 用真实指针事件走一遍「加号 → 起名 → 在地图上拖拽框选」的完整交互
  const framed = await win.webContents.executeJavaScript(`
    (async () => {
      await window.__njt.openRegion('customs');
      document.getElementById('btn-task-add').click();
      document.getElementById('task-name').value = '情报任务';
      document.getElementById('btn-task-create').click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const view = document.getElementById('map-viewport');
      const rect = view.getBoundingClientRect();
      const send = (type, x, y) =>
        view.dispatchEvent(new PointerEvent(type, {
          clientX: x, clientY: y, bubbles: true, cancelable: true,
          button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 7, isPrimary: true,
        }));
      const x0 = rect.left + rect.width * 0.35;
      const y0 = rect.top + rect.height * 0.35;
      send('pointerdown', x0, y0);
      send('pointermove', x0 + 180, y0 + 130);
      send('pointerup', x0 + 180, y0 + 130);
      const x1 = rect.left + rect.width * 0.6;
      const y1 = rect.top + rect.height * 0.55;
      send('pointerdown', x1, y1);
      send('pointermove', x1 + 150, y1 + 90);
      send('pointerup', x1 + 150, y1 + 90);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const tasks = window.__njt.tasks();
      return {
        name: tasks.length ? tasks[0].name : '',
        boxes: tasks.length ? tasks[0].boxes.length : 0,
        elements: document.querySelectorAll('#task-layer .task-box').length,
        labels: document.querySelectorAll('#task-layer .task-label').length,
        framing: Boolean(window.__njt.framingTaskId()),
      };
    })()
  `);
  record(
    '鼠标拖拽可以框出任务地点',
    framed.name === '情报任务' && framed.boxes === 2 && framed.elements === 2 && framed.labels === 2 && framed.framing,
    `${framed.name} / ${framed.boxes} 个框 / ${framed.elements} 个元素`,
  );

  const edited = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('#task-list .task-row');
      row.querySelectorAll('button')[1].click();
      const formVisible = !document.getElementById('task-form').classList.contains('hidden');
      document.getElementById('task-name').value = '情报任务A';
      document.getElementById('task-note').value = '东楼102';
      document.getElementById('btn-task-create').click();
      const task = window.__njt.tasks()[0];
      return {
        formVisible,
        name: task.name,
        note: task.note,
        label: document.querySelector('#task-layer .task-label text').textContent,
        rowNote: document.querySelector('.task-note') ? document.querySelector('.task-note').textContent : '',
        boxes: task.boxes.length,
      };
    })()
  `);
  record(
    '任务可以改名和加备注',
    edited.formVisible &&
      edited.name === '情报任务A' &&
      edited.note === '东楼102' &&
      edited.label === '情报任务A（东楼102）' &&
      edited.rowNote === '（东楼102）' &&
      edited.boxes === 2,
    `${edited.name}（${edited.note}） / 标签 ${edited.label}`,
  );

  const undone = await win.webContents.executeJavaScript(`
    (() => {
      const button = document.getElementById('btn-task-undo');
      button.click();
      const afterOne = window.__njt.tasks()[0].boxes.length;
      button.click();
      const afterTwo = window.__njt.tasks()[0].boxes.length;
      return {
        afterOne,
        afterTwo,
        disabled: button.disabled,
        elements: document.querySelectorAll('#task-layer .task-box').length,
      };
    })()
  `);
  record(
    '框选撤销按钮可以一步步回退',
    undone.afterOne === 1 && undone.afterTwo === 0 && undone.disabled && undone.elements === 0,
    `${undone.afterOne} → ${undone.afterTwo}，剩余元素 ${undone.elements}`,
  );

  const stopped = await win.webContents.executeJavaScript(`
    window.__njt.addTaskBox(window.__njt.tasks()[0].id, [0.3, 0.3, 0.1, 0.08]);
    window.__njt.stopFraming();
    const stillThere = window.__njt.tasks()[0].boxes.length;
    window.__njt.deleteTask(window.__njt.tasks()[0].id);
    ({ stillThere, framing: Boolean(window.__njt.framingTaskId()), left: window.__njt.tasks().length })
  `);
  record(
    '结束框选与删除任务',
    stopped.stillThere === 1 && !stopped.framing && stopped.left === 0,
    JSON.stringify(stopped),
  );

  // 右上角面板显隐开关：点按钮 → 收起 → 写设置 → 重载后仍然收起
  const panel = await win.webContents.executeJavaScript(`
    (() => {
      const button = document.getElementById('btn-ui-toggle');
      const before = document.body.classList.contains('ui-right-hidden');
      button.click();
      return {
        before,
        after: document.body.classList.contains('ui-right-hidden'),
        sideDisplay: getComputedStyle(document.getElementById('side-column')).display,
        active: button.classList.contains('active'),
        title: button.title,
      };
    })()
  `);
  record(
    '点右上角开关能收起 UI',
    !panel.before && panel.after && panel.sideDisplay === 'none' && panel.active,
    `${panel.title}`,
  );
  await sleep(350);
  const settingsFile = main.paths.settingsFile();
  const savedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  record('收起状态写入 settings.json', savedSettings.rightPanelHidden === true, settingsFile);

  win.webContents.reload();
  const readyAfterPanel = await waitForApp(win);
  const restoredPanel = await win.webContents.executeJavaScript(
    '({ hidden: document.body.classList.contains("ui-right-hidden"), title: document.getElementById("btn-ui-toggle").title })',
  );
  record(
    '重载后依然保持收起状态',
    readyAfterPanel && restoredPanel.hidden && restoredPanel.title.includes('显示'),
    restoredPanel.title,
  );
  await win.webContents.executeJavaScript('document.getElementById("btn-ui-toggle").click(); true');
  await sleep(250);

  // 尼沙皇跳舞：点左下角按钮 → 播放 GIF → 重播 → 关闭
  const danceCheck = await win.webContents.executeJavaScript(`
    (async () => {
      const button = document.getElementById('btn-dance');
      const modal = document.getElementById('dance-modal');
      const img = document.getElementById('dance-gif');
      button.click();
      await new Promise((resolve) => {
        if (img.naturalWidth) {
          resolve();
          return;
        }
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 10000);
      });
      const opened = !modal.classList.contains('hidden');
      const firstSrc = img.getAttribute('src');
      document.getElementById('btn-dance-replay').click();
      const replayed = img.getAttribute('src') !== firstSrc;
      const size = { w: img.naturalWidth, h: img.naturalHeight };
      document.getElementById('btn-dance-close').click();
      return { opened, replayed, size, closed: modal.classList.contains('hidden'), cleared: !img.getAttribute('src') };
    })()
  `);
  record(
    '左下角按钮能播放尼沙皇跳舞',
    danceCheck.opened && danceCheck.replayed && danceCheck.closed && danceCheck.cleared && danceCheck.size.w > 0,
    `${danceCheck.size.w}x${danceCheck.size.h}`,
  );

  // 复制视图到剪贴板（主进程读剪贴板核对）
  await win.webContents.executeJavaScript('window.__njt.goOverview(); true');
  await sleep(300);
  await waitForLoadingGone(win);
  // 异步剪贴板 API 要求文档处于聚焦状态（真实用户点按钮时窗口本来就是聚焦的）
  win.focus();
  win.webContents.focus();
  await sleep(200);
  // 用真实鼠标事件点击，才能带上用户手势（Chromium 要求）
  const copyButtonAt = await win.webContents.executeJavaScript(`
    (() => {
      const rect = document.getElementById('btn-copy-overview').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()
  `);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: copyButtonAt.x, y: copyButtonAt.y });
  // 工具栏是 idle 状态时 pointer-events 会被关掉，鼠标移动要等一下才生效
  await sleep(150);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: copyButtonAt.x, y: copyButtonAt.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: copyButtonAt.x, y: copyButtonAt.y, button: 'left', clickCount: 1 });
  await sleep(1200);
  const copyToast = await win.webContents.executeJavaScript('document.getElementById("toast").textContent');
  // 主进程这个构建没有图片剪贴板 API，改用系统剪贴板核对（PowerShell 需要 -STA）
  // 系统剪贴板真正落盘比 JS 里的 Promise 慢一点，所以要轮询几次再判定
  const readClipboardImage = () => {
    const probe = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-STA',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { $i = [System.Windows.Forms.Clipboard]::GetImage(); "$($i.Width)x$($i.Height)" } else { "none" }',
      ],
      { encoding: 'utf8' },
    );
    return (probe.stdout || '').trim() || 'none';
  };
  let clipText = 'none';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    clipText = readClipboardImage();
    if (/^\d+x\d+$/.test(clipText)) break;
    await sleep(400);
  }
  record(
    '复制视图会把图片写进系统剪贴板',
    /^\d+x\d+$/.test(clipText) && Number(clipText.split('x')[0]) > 500,
    `系统剪贴板：${clipText}｜界面提示：${copyToast}`,
  );
  // 剪贴板写入是异步的，capture-mode 可能晚几十毫秒才摘掉，轮询一下再判定
  let captureModeOff = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    captureModeOff = await win.webContents.executeJavaScript('document.body.classList.contains("capture-mode") === false');
    if (captureModeOff) break;
    await sleep(200);
  }
  record('复制后界面元素会恢复显示', captureModeOff === false, '');

  // 最近浏览 + 启动回到上次看的地图
  const recentInfo = await win.webContents.executeJavaScript(`
    (async () => {
      window.__njt.openRegion('customs');
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        chips: Array.from(document.querySelectorAll('.recent-chip')).map((chip) => chip.textContent),
        lastView: window.__njt.prefs().lastView,
        hidden: document.getElementById('recent-bar').classList.contains('hidden'),
      };
    })()
  `);
  record(
    '看过的地图会进最近浏览',
    !recentInfo.hidden && recentInfo.chips.includes('海关') && recentInfo.lastView && recentInfo.lastView.regionId === 'customs',
    recentInfo.chips.join('、'),
  );

  win.webContents.reload();
  const readyRestore = await waitForApp(win);
  const restoredView = await win.webContents.executeJavaScript(
    '({ view: window.__njt.state().view, region: window.__njt.state().regionId })',
  );
  record(
    '重新打开会回到上次看的地图',
    readyRestore && restoredView.view === 'map' && restoredView.region === 'customs',
    `${restoredView.view} / ${restoredView.region}`,
  );
  const backToOverview = await win.webContents.executeJavaScript(`
    (async () => {
      window.__njt.goOverview();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return window.__njt.prefs().lastView;
    })()
  `);
  record('从大地图退出时记住的是大地图', backToOverview && backToOverview.type === 'overview', JSON.stringify(backToOverview));

  // ---------------------------------------------------------------------
  // v1.0.1：笔输入自愈 / 文字标注 / 箭头中段字符 / 赛季文件刷点
  // ---------------------------------------------------------------------
  const rawSuite = await win.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const view = document.getElementById('map-viewport');
      const editor = document.getElementById('text-editor');
      const result = {};
      const press = (x, y, extra) =>
        view.dispatchEvent(
          new PointerEvent('pointerdown', Object.assign({
            clientX: x, clientY: y, bubbles: true, cancelable: true,
            pointerType: 'pen', pointerId: 21, isPrimary: true, pressure: 0.5, button: 0, buttons: 1,
          }, extra || {})),
        );
      const move = (x, y, extra) =>
        view.dispatchEvent(
          new PointerEvent('pointermove', Object.assign({
            clientX: x, clientY: y, bubbles: true, cancelable: true,
            pointerType: 'pen', pointerId: 21, isPrimary: true, pressure: 0.5, button: -1, buttons: 1,
          }, extra || {})),
        );
      const release = (x, y, extra) =>
        view.dispatchEvent(
          new PointerEvent('pointerup', Object.assign({
            clientX: x, clientY: y, bubbles: true, cancelable: true,
            pointerType: 'pen', pointerId: 21, isPrimary: true, pressure: 0, button: 0, buttons: 0,
          }, extra || {})),
        );
      const line = (from, to, steps) => {
        const box = view.getBoundingClientRect();
        const at = (t) => ({
          x: box.left + box.width * (from[0] + (to[0] - from[0]) * t),
          y: box.top + box.height * (from[1] + (to[1] - from[1]) * t),
        });
        const list = [];
        for (let i = 0; i <= steps; i += 1) list.push(at(i / steps));
        return list;
      };
      const stroke = (from, to) => {
        const points = line(from, to, 8);
        press(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i += 1) move(points[i].x, points[i].y);
        release(points[points.length - 1].x, points[points.length - 1].y);
      };
      const typeAndSend = (value, key) => {
        editor.value = value;
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: key || 'Enter', bubbles: true, cancelable: true }));
      };

      try {
      await window.__njt.openRegion('customs');
      await sleep(250);

      // 1) 两笔正常的笔输入 = 两条独立形状
      window.__njt.clear();
      await sleep(120);
      window.__njt.setTool('pen');
      stroke([0.2, 0.2], [0.3, 0.3]);
      stroke([0.4, 0.2], [0.5, 0.3]);
      const twoStrokes = window.__njt.shapes();
      result.twoPenStrokes = { count: twoStrokes.length, points: twoStrokes.map((s) => s.points.length) };

      // 2) 一笔被 pointercancel 打断后继续按下的移动 = 仍然是同一条形状
      window.__njt.clear();
      await sleep(120);
      window.__njt.setTool('pen');
      const cancelLine = line([0.25, 0.55], [0.55, 0.7], 14);
      press(cancelLine[0].x, cancelLine[0].y);
      for (let i = 1; i <= 5; i += 1) move(cancelLine[i].x, cancelLine[i].y);
      const pointsBeforeCancel = window.__njt.shapes()[0].points.length;
      view.dispatchEvent(
        new PointerEvent('pointercancel', {
          clientX: cancelLine[5].x, clientY: cancelLine[5].y, bubbles: true, cancelable: true,
          pointerType: 'pen', pointerId: 21, isPrimary: true, button: 0, buttons: 0,
        }),
      );
      await sleep(120);
      const interruptedState = window.__njt.state().pointers;
      for (let i = 6; i < cancelLine.length; i += 1) move(cancelLine[i].x, cancelLine[i].y);
      release(cancelLine[cancelLine.length - 1].x, cancelLine[cancelLine.length - 1].y);
      await sleep(80);
      const resumed = window.__njt.shapes();
      result.cancelResume = {
        count: resumed.length,
        pointsBeforeCancel,
        points: resumed[0] ? resumed[0].points.length : 0,
        interrupted: Boolean(interruptedState.interrupted),
      };

      // 3) 悬停（buttons=0）不延长已收笔的形状，宽限期过后自动收尾，下一笔仍然能画
      window.__njt.clear();
      await sleep(120);
      window.__njt.setTool('pen');
      const looseLine = line([0.3, 0.3], [0.5, 0.4], 8);
      press(looseLine[0].x, looseLine[0].y);
      for (let i = 1; i <= 4; i += 1) move(looseLine[i].x, looseLine[i].y);
      const pointsBeforeHover = window.__njt.shapes()[0].points.length;
      move(looseLine[7].x, looseLine[7].y, { buttons: 0, button: -1 });
      move(looseLine[8].x, looseLine[8].y, { buttons: 0, button: -1 });
      const pointsAfterHover = window.__njt.shapes()[0].points.length;
      await sleep(700);
      const afterGrace = window.__njt.shapes();
      stroke([0.6, 0.6], [0.7, 0.7]);
      const afterNextStroke = window.__njt.shapes();
      result.hoverAndRecover = {
        pointsBeforeHover,
        pointsAfterHover,
        afterGrace: afterGrace.length,
        afterNextStroke: afterNextStroke.length,
        previewLeft: 'preview' in (afterGrace[0] || {}),
      };

      // 4) 笔按下期间手掌（touch）落屏不画线、也不抢笔
      window.__njt.clear();
      await sleep(120);
      window.__njt.setTool('pen');
      const palmLine = line([0.3, 0.3], [0.45, 0.4], 6);
      press(palmLine[0].x, palmLine[0].y);
      for (let i = 1; i <= 3; i += 1) move(palmLine[i].x, palmLine[i].y);
      const palmX = palmLine[3].x + 60;
      const palmY = palmLine[3].y + 60;
      view.dispatchEvent(new PointerEvent('pointerdown', { clientX: palmX, clientY: palmY, bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 31, isPrimary: false, button: 0, buttons: 1 }));
      view.dispatchEvent(new PointerEvent('pointermove', { clientX: palmX + 20, clientY: palmY, bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 31, isPrimary: false, button: -1, buttons: 1 }));
      view.dispatchEvent(new PointerEvent('pointerup', { clientX: palmX + 20, clientY: palmY, bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 31, isPrimary: false, button: 0, buttons: 0 }));
      for (let i = 4; i < palmLine.length; i += 1) move(palmLine[i].x, palmLine[i].y);
      release(palmLine[palmLine.length - 1].x, palmLine[palmLine.length - 1].y);
      await sleep(80);
      result.palmRejection = window.__njt.shapes().length;

      // 5) 画笔工具下双击不改缩放，平移工具下双击仍然适合窗口
      window.__njt.setTool('pen');
      window.__njt.zoomTo(2);
      const box = view.getBoundingClientRect();
      const clickX = box.left + box.width * 0.5;
      const clickY = box.top + box.height * 0.5;
      const scaleBefore = window.__njt.state().scale;
      view.dispatchEvent(new MouseEvent('dblclick', { clientX: clickX, clientY: clickY, bubbles: true, cancelable: true }));
      const scaleAfterPen = window.__njt.state().scale;
      window.__njt.setTool('pan');
      view.dispatchEvent(new MouseEvent('dblclick', { clientX: clickX, clientY: clickY, bubbles: true, cancelable: true }));
      const scaleAfterPan = window.__njt.state().scale;
      result.doubleClick = {
        scaleBefore,
        scaleAfterPen,
        scaleAfterPan,
        fitScale: window.__njt.state().fitScale,
      };

      // 6) 手写一笔之后再撤销，任务表不能被顺手清掉（历史里存的是快照）
      window.__njt.clear();
      await sleep(120);
      const task = window.__njt.createTask('测试任务', '#ffd166', '');
      window.__njt.addTaskBox(task.id, [0.1, 0.1, 0.08, 0.08]);
      // createTask 会直接进入框选模式，先结束掉，否则后面的笔 / 文字都会被框选抢走
      window.__njt.stopFraming();
      await sleep(80);
      const tasksBeforeUndo = window.__njt.tasks().length;
      window.__njt.setTool('pen');
      stroke([0.2, 0.2], [0.4, 0.35]);
      const shapesBeforeUndo = window.__njt.shapes().length;
      window.__njt.undo();
      await sleep(80);
      result.undoKeepsTasks = {
        tasksBeforeUndo,
        tasksAfterUndo: window.__njt.tasks().length,
        shapesBeforeUndo,
        shapesAfterUndo: window.__njt.shapes().length,
      };

      // 7) 文字工具：T 快捷键 / 三档字号 / 点地图就地输入回车落字
      window.__njt.clear();
      await sleep(120);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
      const toolAfterShortcut = window.__njt.state().tool;
      const sizeGroup = document.getElementById('size-group');
      const sizeButtons = Array.from(sizeGroup.querySelectorAll('.size-btn'));
      const sizeRect = sizeGroup.getBoundingClientRect();
      window.__njt.setTextSize(36);
      result.textToolUi = {
        toolAfterShortcut,
        count: sizeButtons.length,
        sizes: sizeButtons.map((button) => button.dataset.size),
        insideWindow: sizeRect.bottom <= window.innerHeight && sizeRect.top >= 0,
        activeSizes: Array.from(sizeGroup.querySelectorAll('.size-btn.active')).map((button) => button.dataset.size),
      };
      window.__njt.setTool('text');
      const textPoint = window.__njt.screenPoint(0.4, 0.4);
      press(textPoint.x, textPoint.y, { pointerType: 'mouse', pointerId: 41 });
      release(textPoint.x, textPoint.y, { pointerType: 'mouse', pointerId: 41 });
      const editorOpened = window.__njt.editorOpen() && !editor.classList.contains('hidden');
      typeAndSend('撤离点');
      const textShapes = window.__njt.shapes();
      result.textCreate = {
        editorOpened,
        editorClosed: !window.__njt.editorOpen(),
        editorHidden: editor.classList.contains('hidden'),
        count: textShapes.length,
        shape: textShapes[0]
          ? { type: textShapes[0].type, text: textShapes[0].text, size: textShapes[0].size, color: textShapes[0].color, points: textShapes[0].points.length }
          : null,
        nodeTag: textShapes[0] ? (document.querySelector('#shape-layer text.map-text') || {}).tagName || '' : '',
      };

      // 8) Esc 取消、空内容不落字
      const cancelPoint = window.__njt.screenPoint(0.6, 0.6);
      press(cancelPoint.x, cancelPoint.y, { pointerType: 'mouse', pointerId: 41 });
      release(cancelPoint.x, cancelPoint.y, { pointerType: 'mouse', pointerId: 41 });
      typeAndSend('不要的', 'Escape');
      const afterEsc = window.__njt.editorOpen() ? -1 : window.__njt.shapes().length;
      press(cancelPoint.x, cancelPoint.y, { pointerType: 'mouse', pointerId: 41 });
      release(cancelPoint.x, cancelPoint.y, { pointerType: 'mouse', pointerId: 41 });
      typeAndSend('   ');
      result.textCancel = { afterEsc, afterEmpty: window.__njt.shapes().length, editorClosed: !window.__njt.editorOpen() };

      // 9) 双击文字改内容，字号跟随当前档位
      window.__njt.setTool('select');
      window.__njt.setTextSize(16);
      const textScreen = window.__njt.screenPoint(0.4, 0.4);
      view.dispatchEvent(new MouseEvent('dblclick', { clientX: textScreen.x + 6, clientY: textScreen.y + 6, bubbles: true, cancelable: true }));
      const editingText = window.__njt.editorOpen();
      typeAndSend('新撤离点');
      const edited = window.__njt.shapes()[0];
      result.textEdit = { editingText, text: edited.text, size: edited.size };

      // 10) 选中文字后改字号 / 改颜色 / 删除 / 撤销
      window.__njt.selectAt(0.405, 0.405);
      window.__njt.setTextSize(36);
      const resized = window.__njt.shapes()[0];
      window.__njt.setColor('#4dd4ac');
      const recolored = window.__njt.shapes()[0];
      window.__njt.deleteSelected();
      const afterDelete = window.__njt.shapes().length;
      window.__njt.undo();
      await sleep(80);
      result.textStyle = {
        size: resized.size,
        color: recolored.color,
        afterDelete,
        afterUndo: window.__njt.shapes().length,
      };

      // 11) 箭头中段字符：画完箭头弹输入框，箭头+字符只占一步撤销
      window.__njt.clear();
      await sleep(120);
      window.__njt.setTool('arrow');
      window.__njt.setTextSize(24);
      const historyBefore = window.__njt.state().history;
      const arrowLine = line([0.2, 0.6], [0.6, 0.6], 8);
      press(arrowLine[0].x, arrowLine[0].y);
      for (let i = 1; i < arrowLine.length; i += 1) move(arrowLine[i].x, arrowLine[i].y);
      release(arrowLine[arrowLine.length - 1].x, arrowLine[arrowLine.length - 1].y);
      const arrowEditorOpen = window.__njt.editorOpen();
      const arrowEditorMode = window.__njt.state().editor ? window.__njt.state().editor.mode : '';
      typeAndSend('250');
      const arrows = window.__njt.shapes();
      const labelNode = document.querySelector('#shape-layer .arrow-label');
      result.arrowLabel = {
        arrowEditorOpen,
        arrowEditorMode,
        count: arrows.length,
        label: arrows[0] ? arrows[0].label : null,
        size: arrows[0] ? arrows[0].size : 0,
        hasTextNode: Boolean(labelNode) && labelNode.textContent === '250',
        historyStep: window.__njt.state().history - historyBefore,
        previewLeft: 'preview' in (arrows[0] || {}),
      };

      // 12) 点中段字符能选中箭头，拖动时字符跟着走
      const arrow = arrows[0];
      const midNormX = (arrow.points[0][0] + arrow.points[1][0]) / 2;
      const midNormY = (arrow.points[0][1] + arrow.points[1][1]) / 2;
      window.__njt.setTool('select');
      const pickedId = window.__njt.selectAt(midNormX, midNormY);
      const movedArrow = window.__njt.moveSelected(0.05, 0.03);
      const labelAfterMove = document.querySelector('#shape-layer .arrow-label');
      const expectedX = ((movedArrow.points[0][0] + movedArrow.points[1][0]) / 2) * window.__njt.state().imgW;
      result.arrowLabelMove = {
        pickedArrow: pickedId === arrow.id,
        actualX: Number(labelAfterMove.getAttribute('x')),
        expectedX,
      };

      // 13) 箭头字符跳过（Esc）= 只有箭头，而且不留 preview 标记
      window.__njt.clear();
      await sleep(120);
      window.__njt.setTool('arrow');
      const skipLine = line([0.3, 0.3], [0.6, 0.45], 8);
      press(skipLine[0].x, skipLine[0].y);
      for (let i = 1; i < skipLine.length; i += 1) move(skipLine[i].x, skipLine[i].y);
      release(skipLine[skipLine.length - 1].x, skipLine[skipLine.length - 1].y);
      typeAndSend('', 'Escape');
      const skipped = window.__njt.shapes();
      result.arrowSkipLabel = {
        count: skipped.length,
        label: skipped[0] ? skipped[0].label || null : 'missing',
        previewLeft: 'preview' in (skipped[0] || {}),
      };

      // 14) 地图左下「赛季文件刷点」预备栏位
      const seasonBtn = document.getElementById('btn-season-points');
      const badge = seasonBtn ? seasonBtn.querySelector('.prep-badge') : null;
      const seasonVisibleInMap = Boolean(seasonBtn) && seasonBtn.offsetParent !== null;
      if (seasonBtn) seasonBtn.click();
      await sleep(500);
      const seasonToast = document.getElementById('toast').textContent;
      document.body.classList.add('capture-mode');
      const seasonHiddenInCapture = getComputedStyle(document.querySelector('.map-prep')).opacity === '0';
      document.body.classList.remove('capture-mode');
      window.__njt.goOverview();
      await sleep(200);
      const seasonVisibleInOverview = seasonBtn ? seasonBtn.offsetParent !== null : true;
      result.seasonSlot = {
        exists: Boolean(seasonBtn),
        visibleInMap: seasonVisibleInMap,
        badge: badge ? badge.textContent.trim() : '',
        toast: seasonToast,
        hiddenInCapture: seasonHiddenInCapture,
        visibleInOverview: seasonVisibleInOverview,
      };

      // 15) 橡皮擦：划过就擦掉，擦错了一步能整体撤销
      await window.__njt.openRegion('customs');
      await sleep(150);
      window.__njt.clear();
      await sleep(120);
      window.__njt.addText('擦我', 0.3, 0.3, 24);
      window.__njt.addText('留我', 0.7, 0.7, 24);
      window.__njt.setTool('eraser');
      const beforeErase = window.__njt.shapes().length;
      const eraseLine = line([0.28, 0.28], [0.35, 0.35], 6);
      press(eraseLine[0].x, eraseLine[0].y, { pointerType: 'mouse', pointerId: 51 });
      for (let i = 1; i < eraseLine.length; i += 1) {
        move(eraseLine[i].x, eraseLine[i].y, { pointerType: 'mouse', pointerId: 51 });
      }
      release(eraseLine[eraseLine.length - 1].x, eraseLine[eraseLine.length - 1].y, { pointerType: 'mouse', pointerId: 51 });
      await sleep(200);
      const afterErase = window.__njt.shapes();
      result.eraser = {
        before: beforeErase,
        after: afterErase.length,
        left: afterErase.map((shape) => shape.text || shape.type),
        toast: document.getElementById('toast').textContent,
      };
      window.__njt.undo();
      await sleep(150);
      result.eraser.afterUndo = window.__njt.shapes().length;

      await window.__njt.openRegion('customs');
      await sleep(200);
      // 最后留一组「文字 + 带字符箭头」验证落盘
      window.__njt.clear();
      window.__njt.setTool('arrow');
      const persistLine = line([0.3, 0.3], [0.5, 0.42], 8);
      press(persistLine[0].x, persistLine[0].y);
      for (let i = 1; i < persistLine.length; i += 1) move(persistLine[i].x, persistLine[i].y);
      release(persistLine[persistLine.length - 1].x, persistLine[persistLine.length - 1].y);
      typeAndSend('A1');
      window.__njt.addText('车队路线', 0.7, 0.7, 24);
      await window.__njt.save();
      return result;
      } catch (error) {
        return { error: String((error && error.stack) || error), partial: result };
      }
    })()
  `);

  // 套件里中途抛错时也把已有结果带回来，逐项判定能看清楚断在哪一步
  const penSuite = Object.assign(
    {
      twoPenStrokes: { count: 0, points: [] },
      cancelResume: { count: 0, interrupted: false, points: 0, pointsBeforeCancel: 0 },
      hoverAndRecover: { pointsBeforeHover: -1, pointsAfterHover: -2, afterGrace: 0, afterNextStroke: 0, previewLeft: true },
      doubleClick: { scaleBefore: 1, scaleAfterPen: 2, scaleAfterPan: 3, fitScale: 0 },
      undoKeepsTasks: { tasksBeforeUndo: 0, tasksAfterUndo: -1, shapesAfterUndo: -1 },
      textCreate: { editorOpened: false, editorClosed: false, count: 0, shape: { type: '', text: '', size: 0, color: '' }, nodeTag: '' },
      textToolUi: { toolAfterShortcut: '', count: 0, sizes: [], insideWindow: false, activeSizes: [] },
      textCancel: { afterEsc: -1, afterEmpty: -1, editorClosed: false },
      textEdit: { editingText: false, text: '', size: 0 },
      textStyle: { size: 0, color: '', afterDelete: -1, afterUndo: -1 },
      arrowLabel: { arrowEditorOpen: false, arrowEditorMode: '', count: 0, label: '', size: 0, hasTextNode: false, historyStep: 0, previewLeft: true },
      arrowLabelMove: { pickedArrow: false, actualX: 0, expectedX: -1 },
      arrowSkipLabel: { count: 0, label: 'x', previewLeft: true },
      eraser: { before: 0, after: -1, left: [], toast: '', afterUndo: -1 },
      seasonSlot: { exists: false, visibleInMap: false, badge: '', toast: '', hiddenInCapture: false, visibleInOverview: true },
    },
    rawSuite || {},
  );
  if (rawSuite && rawSuite.error) record('笔输入 / 文字功能套件跑完', false, rawSuite.error);
  if (penSuite.partial) Object.assign(penSuite, penSuite.partial);
  const ps = penSuite;
  record(
    '笔输入两笔得到两条独立形状',
    penSuite.twoPenStrokes.count === 2 && penSuite.twoPenStrokes.points.every((n) => n > 1),
    `${penSuite.twoPenStrokes.count} 条 / 点数 ${penSuite.twoPenStrokes.points.join(',')}`,
  );
  record(
    'pointercancel 之后能续回同一条笔迹',
    penSuite.cancelResume.count === 1 &&
      penSuite.cancelResume.interrupted &&
      penSuite.cancelResume.points > penSuite.cancelResume.pointsBeforeCancel,
    `${penSuite.cancelResume.count} 条，打断时 ${penSuite.cancelResume.pointsBeforeCancel} 点 → 续笔后 ${penSuite.cancelResume.points} 点`,
  );
  record(
    '缺少 pointerup 时悬停不会继续画，宽限过后自动收尾且能画下一笔',
    penSuite.hoverAndRecover.pointsAfterHover === penSuite.hoverAndRecover.pointsBeforeHover &&
      penSuite.hoverAndRecover.afterGrace === 1 &&
      penSuite.hoverAndRecover.afterNextStroke === 2 &&
      penSuite.hoverAndRecover.previewLeft === false,
    JSON.stringify(penSuite.hoverAndRecover),
  );
  record('笔按下时手掌触摸不会画出笔迹', penSuite.palmRejection === 1, `${penSuite.palmRejection} 条形状`);
  record(
    '双击只在平移工具下适合窗口',
    Math.abs(penSuite.doubleClick.scaleAfterPen - penSuite.doubleClick.scaleBefore) < 1e-9 &&
      Math.abs(penSuite.doubleClick.scaleAfterPan - penSuite.doubleClick.fitScale) < 1e-6,
    `${penSuite.doubleClick.scaleBefore.toFixed(3)} → ${penSuite.doubleClick.scaleAfterPen.toFixed(3)} / ${penSuite.doubleClick.scaleAfterPan.toFixed(3)}`,
  );
  record(
    '撤销手写笔画不会连带清掉任务表',
    penSuite.undoKeepsTasks.shapesBeforeUndo === 1 &&
      penSuite.undoKeepsTasks.shapesAfterUndo === 0 &&
      penSuite.undoKeepsTasks.tasksAfterUndo === penSuite.undoKeepsTasks.tasksBeforeUndo &&
      penSuite.undoKeepsTasks.tasksBeforeUndo === 1,
    JSON.stringify(penSuite.undoKeepsTasks),
  );
  record(
    '文字工具入口齐备（T 快捷键 / 三档字号 / 面板不出屏）',
    ps?.textToolUi.toolAfterShortcut === 'text' &&
      ps?.textToolUi.count === 3 &&
      (ps?.textToolUi.sizes || []).join(',') === '16,24,36' &&
      ps?.textToolUi.insideWindow &&
      (ps?.textToolUi.activeSizes || []).join(',') === '36',
    JSON.stringify(ps?.textToolUi),
  );
  record(
    '文字工具点地图能就地输入并落字',
    penSuite.textCreate.editorOpened &&
      penSuite.textCreate.editorClosed &&
      penSuite.textCreate.count === 1 &&
      penSuite.textCreate.shape.type === 'text' &&
      penSuite.textCreate.shape.text === '撤离点' &&
      penSuite.textCreate.shape.size === 36 &&
      penSuite.textCreate.nodeTag.toLowerCase() === 'text',
    JSON.stringify(penSuite.textCreate),
  );
  record(
    'Esc 取消与空内容都不会落字',
    penSuite.textCancel.afterEsc === 1 && penSuite.textCancel.afterEmpty === 1 && penSuite.textCancel.editorClosed,
    JSON.stringify(penSuite.textCancel),
  );
  record(
    '双击文字可以改内容，字号跟随当前档位',
    penSuite.textEdit.editingText && penSuite.textEdit.text === '新撤离点' && penSuite.textEdit.size === 16,
    JSON.stringify(penSuite.textEdit),
  );
  record(
    '选中文字可以改字号改颜色删除并撤销',
    penSuite.textStyle.size === 36 &&
      penSuite.textStyle.color === '#4dd4ac' &&
      penSuite.textStyle.afterDelete === 0 &&
      penSuite.textStyle.afterUndo === 1,
    JSON.stringify(penSuite.textStyle),
  );
  record(
    '画完箭头会弹出中段字符输入框，箭头与字符合成一步',
    penSuite.arrowLabel.arrowEditorOpen &&
      penSuite.arrowLabel.arrowEditorMode === 'arrowLabel' &&
      penSuite.arrowLabel.count === 1 &&
      penSuite.arrowLabel.label === '250' &&
      penSuite.arrowLabel.hasTextNode &&
      penSuite.arrowLabel.historyStep === 1 &&
      penSuite.arrowLabel.previewLeft === false,
    JSON.stringify(penSuite.arrowLabel),
  );
  record(
    '中段字符能点中箭头并跟着箭头一起挪动',
    penSuite.arrowLabelMove.pickedArrow &&
      Math.abs(penSuite.arrowLabelMove.actualX - penSuite.arrowLabelMove.expectedX) < 0.5,
    JSON.stringify(penSuite.arrowLabelMove),
  );
  record(
    '箭头字符跳过时只留箭头',
    penSuite.arrowSkipLabel.count === 1 &&
      penSuite.arrowSkipLabel.label === null &&
      penSuite.arrowSkipLabel.previewLeft === false,
    JSON.stringify(penSuite.arrowSkipLabel),
  );
  record(
    '橡皮擦划过就擦掉，擦错一步能撤销',
    penSuite.eraser.before === 2 &&
      penSuite.eraser.after === 1 &&
      (penSuite.eraser.left || []).join(',') === '留我' &&
      penSuite.eraser.afterUndo === 2,
    JSON.stringify(penSuite.eraser),
  );
  record(
    '地图左下「赛季文件刷点」预备栏位',
    penSuite.seasonSlot.exists &&
      penSuite.seasonSlot.visibleInMap &&
      penSuite.seasonSlot.badge.includes('正在施工') &&
      penSuite.seasonSlot.toast.includes('还在做') &&
      penSuite.seasonSlot.hiddenInCapture &&
      penSuite.seasonSlot.visibleInOverview === false,
    JSON.stringify(penSuite.seasonSlot),
  );
  record(
    '赛季文件刷点还没做：点一下只提示在施工，不产生任何文件夹',
    !fs.existsSync(path.join(main.paths.userDir(), '赛季文件刷点')),
    penSuite.seasonSlot.toast,
  );

  const savedAfterSuite = JSON.parse(fs.readFileSync(main.paths.annotationsFile(), 'utf8'));
  const customsShapes = savedAfterSuite?.maps?.customs?.shapes || [];
  const savedText = customsShapes.find((shape) => shape.type === 'text');
  const savedArrow = customsShapes.find((shape) => shape.type === 'arrow' && shape.label);
  record(
    '文字与箭头字符按地图写进标注文件',
    Boolean(savedText) &&
      savedText.text === '车队路线' &&
      savedText.size === 24 &&
      Boolean(savedArrow) &&
      savedArrow.label === 'A1' &&
      !savedArrow.preview,
    `${customsShapes.length} 个形状：${customsShapes.map((shape) => `${shape.type}${shape.label ? `(${shape.label})` : ''}`).join(', ')}`,
  );

  // ---------------------------------------------------------------------
  // 真实鼠标 / 键盘事件（走 Chromium 输入管线，能测出焦点被抢的问题）
  // ---------------------------------------------------------------------
  await win.webContents.executeJavaScript(`
    window.__njt.openRegion('customs').then(() => {
      window.__njt.clear();
      window.__njt.setTool('text');
      window.__njt.setTextSize(24);
    })
  `);
  await sleep(300);
  const clickAt = await win.webContents.executeJavaScript('window.__njt.screenPoint(0.45, 0.45)');
  const clickX = Math.round(clickAt.x);
  const clickY = Math.round(clickAt.y);
  win.focus();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'mouseMove', x: clickX, y: clickY });
  await sleep(80);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
  await sleep(300);
  const editorFocus = await win.webContents.executeJavaScript(`(() => {
    const editor = document.getElementById('text-editor');
    const active = document.activeElement;
    return {
      open: window.__njt.editorOpen(),
      visible: !editor.classList.contains('hidden'),
      focused: active === editor,
      activeAt: active ? active.tagName + (active.id ? '#' + active.id : '') : 'none',
    };
  })()`);
  record(
    '真实鼠标点地图后输入框拿到焦点（可以打字）',
    editorFocus.open && editorFocus.visible && editorFocus.focused,
    JSON.stringify(editorFocus),
  );
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'X' });
  await sleep(150);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await sleep(250);
  const realTyped = await win.webContents.executeJavaScript(
    '({ texts: window.__njt.shapes().filter((shape) => shape.type === "text").map((shape) => shape.text), open: window.__njt.editorOpen() })',
  );
  record(
    '真实键盘打字能落成文字标注',
    realTyped.texts.includes('X') && realTyped.open === false,
    JSON.stringify(realTyped),
  );

  // 真实双击改字：先放一条文字，再真双击它，看能不能改
  await win.webContents.executeJavaScript(`
    window.__njt.openRegion('customs').then(() => {
      window.__njt.clear();
      window.__njt.addText('原文字', 0.4, 0.4, 24);
      window.__njt.setTool('select');
    })
  `);
  await sleep(300);
  const textAt = await win.webContents.executeJavaScript('window.__njt.screenPoint(0.4, 0.4)');
  const doubleClickAt = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await sleep(70);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(70);
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 });
  };
  await doubleClickAt(Math.round(textAt.x) + 6, Math.round(textAt.y) + 8);
  await sleep(400);
  const dblState = await win.webContents.executeJavaScript(`(() => {
    const editor = document.getElementById('text-editor');
    const shape = window.__njt.shapes()[0] || {};
    return {
      open: window.__njt.editorOpen(),
      value: editor.value,
      focused: document.activeElement === editor,
      text: shape.text || '',
      count: window.__njt.shapes().length,
    };
  })()`);
  record(
    '真实双击文字会打开输入框并带出原内容',
    dblState.open && dblState.value === '原文字' && dblState.focused && dblState.count === 1,
    JSON.stringify(dblState),
  );
  if (dblState.open) {
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'Z' });
    await sleep(150);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await sleep(300);
  }
  const afterEdit = await win.webContents.executeJavaScript(
    '({ text: (window.__njt.shapes()[0] || {}).text, count: window.__njt.shapes().length, open: window.__njt.editorOpen() })',
  );
  record(
    '真实双击改完回车后文字真的变了',
    afterEdit.text === 'Z' && afterEdit.count === 1 && afterEdit.open === false,
    JSON.stringify(afterEdit),
  );

  // 文字工具还开着的时候点已有的字，应该是「改这条」而不是又开一条新的
  await win.webContents.executeJavaScript(`
    window.__njt.openRegion('customs').then(() => {
      window.__njt.clear();
      window.__njt.addText('改我', 0.4, 0.4, 24);
      window.__njt.setTool('text');
    })
  `);
  await sleep(300);
  const textAt2 = await win.webContents.executeJavaScript('window.__njt.screenPoint(0.4, 0.4)');
  await doubleClickAt(Math.round(textAt2.x) + 6, Math.round(textAt2.y) + 8);
  await sleep(400);
  const textToolEdit = await win.webContents.executeJavaScript(`(() => {
    const editor = document.getElementById('text-editor');
    return {
      open: window.__njt.editorOpen(),
      mode: (window.__njt.state().editor || {}).mode || '',
      value: editor.value,
      focused: document.activeElement === editor,
      count: window.__njt.shapes().length,
    };
  })()`);
  record(
    '文字工具下点已有的字是改它，不是又新建一条',
    textToolEdit.open && textToolEdit.mode === 'editText' && textToolEdit.value === '改我' && textToolEdit.count === 1,
    JSON.stringify(textToolEdit),
  );
}

run()
  .catch((error) => {
    record('自检执行未抛异常', false, (error && (error.stack || error.message)) || String(error));
  })
  .finally(() => {
    const failed = checks.filter((item) => !item.pass);
    console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项。`);
    if (failed.length) console.log(`失败项：${failed.map((item) => item.name).join('、')}`);
    exitCode = failed.length ? 1 : 0;
    cleanupAfterExit();
    app.exit(exitCode);
  });
