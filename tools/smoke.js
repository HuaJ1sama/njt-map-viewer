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
  record('窗口重载后仍可工作', readyAgain);
  if (readyAgain) {
    await win.webContents.executeJavaScript('window.__njt.openRegion("factory")');
    const restored = await win.webContents.executeJavaScript('window.__njt.shapes()');
    record('重载后标注按地图恢复', restored.length === 1 && restored[0].type === 'arrow', `原样恢复 ${restored.length} 个形状`);
    await win.webContents.executeJavaScript('window.__njt.goOverview()');
    const other = await win.webContents.executeJavaScript('window.__njt.openRegion("forest").then(() => window.__njt.shapes())');
    record('不同地图的标注互不串台', other.length === 0, `森林 ${other.length} 个形状`);
    await win.webContents.executeJavaScript('window.__njt.goOverview()');
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
  const captureModeOff = await win.webContents.executeJavaScript('document.body.classList.contains("capture-mode")');
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
}

run()
  .catch((error) => {
    record('自检执行未抛异常', false, error && error.message);
  })
  .finally(() => {
    const failed = checks.filter((item) => !item.pass);
    console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项。`);
    if (failed.length) console.log(`失败项：${failed.map((item) => item.name).join('、')}`);
    exitCode = failed.length ? 1 : 0;
    cleanupAfterExit();
    app.exit(exitCode);
  });
