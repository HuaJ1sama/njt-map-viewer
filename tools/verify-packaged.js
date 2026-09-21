'use strict';

/**
 * 验证已打包的程序：启动 exe，通过 DevTools 协议在真实窗口里跑一遍页面自检，
 * 确认 extraResources 里的地图能被读取、界面能正常渲染。
 * 用法：node tools/verify-packaged.js [exe 路径]
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const exePath = process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', '尼沙皇版图浏览小工具.exe');
const port = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!fs.existsSync(exePath)) {
  console.error(`找不到可执行文件：${exePath}`);
  process.exit(1);
}

async function findPage() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.url.includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return null;
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      seq += 1;
      pending.set(seq, resolve);
      socket.send(JSON.stringify({ id: seq, method, params: params || {} }));
    });
  return { socket, ready, send };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.text);
  return result.result?.result?.value;
}

async function main() {
  console.log(`启动：${exePath}`);
  const startedAt = Date.now();
  const child = spawn(exePath, [`--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let exitCode = 1;
  try {
    const page = await findPage();
    if (!page) throw new Error('未能在 60 秒内连上渲染进程');
    const client = connect(page.webSocketDebuggerUrl);
    await client.ready;
    let ready = false;
    const deadline = Date.now() + 60000;
    while (!ready && Date.now() < deadline) {
      ready = await evaluate(client, 'window.__njtReady === true').catch(() => false);
      if (!ready) await sleep(300);
    }
    console.log(`渲染进程就绪：${ready}（从启动到界面可用 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）`);
    if (!ready) throw new Error('页面未初始化完成');

    const battery = await evaluate(client, 'window.__njt.selfCheck()');
    let failed = 0;
    for (const item of battery.results) {
      if (!item.pass) failed += 1;
      console.log(`[${item.pass ? 'PASS' : 'FAIL'}] ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
    }
    const mapsDir = path.join(path.dirname(exePath), 'resources', '尼沙皇吊图');
    if (fs.existsSync(mapsDir)) {
      console.log(`\n打包内地图目录：${mapsDir}（${fs.readdirSync(mapsDir).length} 张）`);
    } else {
      console.log('\n免安装单文件 exe：运行时自动解压，地图随包内置。');
    }
    console.log(`合计 ${battery.results.length} 项，失败 ${failed} 项。`);
    exitCode = failed ? 1 : 0;
    // 让程序自己退出，否则免安装版解压出来的进程会一直占着 exe 文件
    await evaluate(client, 'window.njt.quit()').catch(() => {});
    client.socket.close();
  } catch (error) {
    console.error(`验证失败：${error.message}`);
  } finally {
    await sleep(1200);
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    await sleep(500);
    process.exit(exitCode);
  }
}

main();
