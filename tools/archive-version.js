'use strict';

/**
 * 版本归档：把当前工程快照 + 已打包的免安装 exe 收进 archive/v<版本>/，
 * 以后哪个版本出问题可以直接回退。
 * 用法：npm run archive            （归档 package.json 里的版本）
 *      npm run archive -- 1.0.0   （归档指定版本，exe 名字按版本匹配）
 *
 * 只做「复制 / 移动 / 写清单」三件事，不删除任何源码；
 * 同一版本已归档过会直接中止，避免覆盖旧档案。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const ARCHIVE_ROOT = path.join(ROOT, 'archive');
const ARCHIVE_README = path.join(ARCHIVE_ROOT, 'README.md');

// 不归档的内容：依赖、打包产物、原始大图、归档目录本身，以及自检生成的大截图
const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'dist', 'archive', '尼沙皇吊图', '.git']);
const EXCLUDE_RELATIVE = new Set([path.join('tools', 'screenshots')]);
const EXCLUDE_FILE_NAMES = new Set(['Thumbs.db', '.DS_Store']);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const productName = (pkg.build && pkg.build.productName) || pkg.productName || pkg.name;
const version = String(process.argv[2] || pkg.version || '').replace(/^v/i, '');

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`版本号看起来不对：${version || '(空)'}`);
  process.exit(1);
}

const targetDir = path.join(ARCHIVE_ROOT, `v${version}`);
const sourceDir = path.join(targetDir, 'source');

if (fs.existsSync(targetDir)) {
  console.error(`已经存在归档 ${path.relative(ROOT, targetDir)}，没有覆盖，也没有改动任何文件。`);
  console.error('想重新归档请先手动改名或删掉旧目录（脚本自己不会删东西）。');
  process.exit(1);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();

function collectSourceFiles(dir, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      if (EXCLUDE_RELATIVE.has(rel)) continue;
      files.push(...collectSourceFiles(path.join(dir, entry.name), rel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_FILE_NAMES.has(entry.name)) continue;
    if (rel.toLowerCase().endsWith('.log')) continue;
    files.push(rel);
  }
  return files;
}

function findPortableExe() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) return null;
  const candidates = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /-portable\.exe$/i.test(entry.name))
    .map((entry) => entry.name);
  if (!candidates.length) return null;
  const exact = candidates.find((name) => name.includes(version));
  return path.join(distDir, exact || (candidates.length === 1 ? candidates[0] : null) || candidates[0]);
}

function copyIntoSource(files) {
  for (const rel of files) {
    const to = path.join(sourceDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), to);
  }
}

function moveExe(from) {
  const to = path.join(targetDir, path.basename(from));
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
  return to;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function appendArchiveReadme(row) {
  fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
  if (!fs.existsSync(ARCHIVE_README)) {
    fs.writeFileSync(
      ARCHIVE_README,
      [
        '# 版本档案',
        '',
        '每个版本发布前先 `npm run archive`，把当时的完整源码快照和免安装 exe 收进 `archive/v<版本>/`。',
        '出问题时用归档里的源码覆盖工程即可回退，也可以直接把归档里的老 exe 发给用户。',
        '',
        '归档脚本只做复制、移动和写清单，不会删除源码；同一版本重复执行会安全中止。',
        '',
        '## 回滚步骤',
        '',
        '1. 把 `archive/v<版本>/source/` 里的内容复制回工程根目录（覆盖同名文件）。',
        '2. `npm start` 直接跑旧版源码，或直接用 `archive/v<版本>/` 里的免安装 exe。',
        '3. 标注数据是向前兼容的：v1.0.1 只是在形状里加了 `text` / `label` 字段，',
        '   退回 v1.0.0 不会丢数据，但地图上的文字会显示成一个小点、箭头中段字符不显示。',
        '   保险起见回滚前先备份 `%APPDATA%\\尼沙皇版图浏览小工具\\` 三个 json。',
        '',
        '## 档案索引',
        '',
        '| 版本 | 归档日期 | 免安装 exe | 源码文件数 | 说明 |',
        '| --- | --- | --- | --- | --- |',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  const current = fs.readFileSync(ARCHIVE_README, 'utf8');
  // 插到索引表的表头分隔行下面，而不是文件末尾（后面还有「备注」段落）
  const lines = current.split('\n');
  const tableStart = lines.findIndex((line) => /^\|\s*-{3,}/.test(line.trim()) || /^\|\s*---/.test(line.trim()));
  if (tableStart >= 0) {
    lines.splice(tableStart + 1, 0, row);
    fs.writeFileSync(ARCHIVE_README, lines.join('\n'), 'utf8');
    return;
  }
  const separator = current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(ARCHIVE_README, `${separator}${row}\n`, 'utf8');
}

fs.mkdirSync(sourceDir, { recursive: true });

const files = collectSourceFiles(ROOT).sort();
copyIntoSource(files);

const exePath = findPortableExe();
let exeInfo = null;
if (exePath && fs.existsSync(exePath)) {
  const movedTo = moveExe(exePath);
  exeInfo = {
    name: path.basename(movedTo),
    size: fs.statSync(movedTo).size,
    sha256: sha256(movedTo),
    movedFrom: path.relative(ROOT, exePath).replace(/\\/g, '/'),
  };
}

const fileEntries = files.map((rel) => {
  const full = path.join(sourceDir, rel);
  return { path: rel.replace(/\\/g, '/'), size: fs.statSync(full).size, sha256: sha256(full) };
});

const manifest = {
  version,
  productName,
  archivedAt: new Date().toISOString(),
  sourceDir: 'source',
  fileCount: fileEntries.length,
  sourceBytes: fileEntries.reduce((sum, item) => sum + item.size, 0),
  exe: exeInfo,
  files: fileEntries,
};
fs.writeFileSync(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const exeCell = exeInfo ? `${exeInfo.name}（${exeInfo.sha256.slice(0, 12)}…）` : '无 exe 产物';
appendArchiveReadme(
  `| v${version} | ${manifest.archivedAt.slice(0, 10)} | ${exeCell} | ${fileEntries.length} | 完整源码快照 |`,
);

console.log(`已归档 v${version} → ${path.relative(ROOT, targetDir)}`);
console.log(`源码快照：${fileEntries.length} 个文件，${formatBytes(manifest.sourceBytes)}`);
if (exeInfo) console.log(`免安装 exe：${exeInfo.name}（${formatBytes(exeInfo.size)}），SHA256 ${exeInfo.sha256}`);
else console.log('dist/ 下没有找到对应版本的 portable exe，只归档了源码快照。');
console.log(`清单：${path.relative(ROOT, path.join(targetDir, 'manifest.json'))}`);
