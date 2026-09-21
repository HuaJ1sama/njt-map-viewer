'use strict';

/**
 * 生成界面截图，用于人工确认排版与热区对位。
 * 用法：npm run shots   产物在 tools/screenshots/
 */

const { app } = require('electron');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'njt-shots-'));
app.setPath('userData', tempUserData);

const main = require('../src/main/main.js');

const OUT_DIR = path.join(__dirname, 'screenshots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForApp(win, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await win.webContents.executeJavaScript('window.__njtReady === true')) return true;
    } catch {
      /* 页面还在加载 */
    }
    await sleep(200);
  }
  return false;
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`已保存 ${file}`);
}

async function run() {
  const win = await main.readyPromise;
  await waitForApp(win);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 重新加载一次，趁启动加载页还在的时候截一张
  win.webContents.reload();
  await sleep(320);
  await shot(win, '11-loading');
  await waitForApp(win);
  await sleep(800);

  await sleep(2500);

  await win.webContents.executeJavaScript(`
    document.querySelectorAll('.hotspot').forEach((node) => {
      if (node.dataset.id === 'customs' || node.dataset.id === 'icebreaker') node.classList.add('is-hover');
    });
    document.body.classList.add('ui-idle');
    true;
  `);
  await sleep(500);
  await shot(win, '1-overview');

  await win.webContents.executeJavaScript('window.__njt.calibrate.enable(true)');
  await sleep(600);
  await shot(win, '2-overview-calibration');
  await win.webContents.executeJavaScript('window.__njt.calibrate.enable(false)');

  await win.webContents.executeJavaScript('window.__njt.scav.open(); true');
  await sleep(700);
  await shot(win, '8-scav-box');
  await win.webContents.executeJavaScript('window.__njt.scav.close(); true');
  await sleep(200);

  await win.webContents.executeJavaScript('window.__njt.dance.open(); true');
  await sleep(900);
  await shot(win, '10-dance');
  await win.webContents.executeJavaScript('window.__njt.dance.close(); true');
  await sleep(200);

  await win.webContents.executeJavaScript('window.__njt.openRegion("customs")');
  await sleep(3500);
  await win.webContents.executeJavaScript(`
    window.__njt.zoomTo(0.5);
    window.__njt.setColor('#ffd166');
    window.__njt.setWidth(4);
    window.__njt.drawShape('rect', [0.34, 0.34], [0.44, 0.44]);
    window.__njt.setColor('#ff6b6b');
    window.__njt.drawShape('ellipse', [0.46, 0.34], [0.56, 0.44]);
    window.__njt.setColor('#4dd4ac');
    window.__njt.drawShape('arrow', [0.35, 0.5], [0.45, 0.58]);
    window.__njt.setColor('#5aa9ff');
    window.__njt.setWidth(2);
    window.__njt.addPen([[0.48, 0.5], [0.51, 0.54], [0.55, 0.51], [0.58, 0.56], [0.6, 0.52]]);
    document.body.classList.remove('ui-idle');
    true;
  `);
  await sleep(900);
  await shot(win, '3-map-annotated');

  await win.webContents.executeJavaScript('window.__njt.zoomTo(1); window.__njt.setTool("ellipse"); true');
  await sleep(900);
  await shot(win, '4-map-zoom-100');

  await win.webContents.executeJavaScript(`
    window.__njt.zoomTo(0.45);
    const t1 = window.__njt.createTask('安装信号发生器', '#ffd166', '东楼102');
    window.__njt.addTaskBox(t1.id, [0.33, 0.3, 0.12, 0.09]);
    window.__njt.addTaskBox(t1.id, [0.52, 0.42, 0.1, 0.08]);
    window.__njt.stopFraming();
    const t2 = window.__njt.createTask('收集燃料', '#5aa9ff', '宿舍2层');
    window.__njt.addTaskBox(t2.id, [0.4, 0.58, 0.14, 0.1]);
    window.__njt.stopFraming();
    document.body.classList.remove('ui-idle');
    true;
  `);
  await sleep(900);
  await shot(win, '5-map-tasks');

  await win.webContents.executeJavaScript(`
    const task = window.__njt.tasks()[0];
    const box = task.boxes[0];
    window.__njt.toggleBoxDone(task.id, box.id);
    window.__njt.setTool('select');
    const rect = window.__njt.selectAt(0.35, 0.35);
    document.body.classList.remove('ui-idle');
    rect;
  `);
  await sleep(600);
  await shot(win, '13-edit-and-progress');

  await win.webContents.executeJavaScript('window.__njt.goOverview(); true');
  await sleep(900);
  await shot(win, '14-overview-tasks');
  await win.webContents.executeJavaScript('window.__njt.openRegion("customs"); true');
  await sleep(500);

  await win.webContents.executeJavaScript(`
    window.__njt.startFraming(window.__njt.tasks()[0].id);
    document.body.classList.remove('ui-idle');
    true;
  `);
  await sleep(700);
  await shot(win, '6-task-framing');

  await win.webContents.executeJavaScript(`
    window.__njt.stopFraming();
    document.getElementById('btn-task-add').click();
    document.body.classList.remove('ui-idle');
    true;
  `);
  await sleep(700);
  await shot(win, '7-task-form');

  await win.webContents.executeJavaScript(`
    window.__njt.ui.set(true);
    document.body.classList.remove('ui-idle');
    true;
  `);
  await sleep(600);
  await shot(win, '9-panel-hidden');
  await win.webContents.executeJavaScript('window.__njt.ui.set(false); true');
  await sleep(300);

  await win.webContents.executeJavaScript('window.__njt.clear(); true');
  await sleep(300);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      if (tempUserData.startsWith(os.tmpdir())) fs.rmSync(tempUserData, { recursive: true, force: true });
    } catch {
      /* 句柄可能仍被占用，忽略 */
    }
    app.exit(process.exitCode || 0);
  });
