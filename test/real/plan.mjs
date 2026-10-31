// 计划生成器：中文用例在这里写，产出一份纯 ASCII 的执行计划给 case.ps1。
// 为什么绕这一圈：本机安全策略禁止从 Bash/Node 里拉起 PowerShell，
// 而 PowerShell 5.1 又会按 ANSI 解析 .ps1 里的中文，所以中文只能走 base64。
import fs from 'node:fs';

const TMP = 'D:/tmp/ez-real';
const WORK = TMP + '/work';
const FILE = WORK + '/w.md';

export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

export function plan(name, build) {
  fs.mkdirSync(WORK, { recursive: true });
  const A = [];
  const api = {
    line: (...xs) => A.push(...xs),
    // 启动后焦点不在正文上，直接发键盘会全部落空 —— 先点一下正文
    // 第一个点击是兜底：万一草稿弹窗还是冒出来（模态会吃掉所有键盘），
    // 按「丢弃」的位置点掉它；没有弹窗时这一点落在正文里，无害。
    launch: (f = FILE) => A.push('launch ' + f, 'sleep 1400',
      'relclick 716 428', 'sleep 300',
      'relclick 520 320', 'sleep 350'),
    // 干净初态：绕到编辑模式（纯文本）全选删除，再切回所见即所得。
    // 直接 Ctrl+A + Delete 有两个坑：块的类型（列表/引用/代码块）会残留，
    // 行内格式状态也会「粘」到下一条（删光粗体后接着打的字仍是粗的）。
    // 切模式后焦点会丢，所以两次都要重新点一下编辑区。
    clear: () => A.push(
      'combo ctrl+2', 'sleep 420',
      'relclick 520 320', 'sleep 220',
      'combo ctrl+a', 'key delete', 'sleep 220',
      'combo ctrl+1', 'sleep 560',
      'relclick 520 320', 'sleep 280'),
    type: (s) => A.push('type ' + b64(s)),
    key: (k) => A.push('key ' + k, 'sleep 90'),
    combo: (c) => A.push('combo ' + c, 'sleep 240'),
    sleep: (ms) => A.push('sleep ' + ms),
    shot: (n) => A.push('shot ' + TMP + '/' + n + '.png'),
    save: () => A.push('save', 'sleep 400'),
    dump: (l) => A.push('dump ' + l),
    check: (l, expected) => A.push('check ' + l + ' ' + b64(expected)),
    click: (x, y) => A.push('relclick ' + x + ' ' + y, 'sleep 220'),
    dclick: (x, y) => A.push('reldclick ' + x + ' ' + y, 'sleep 300'),
    drag: (x1, y1, x2, y2) => A.push('reldrag ' + x1 + ' ' + y1 + ' ' + x2 + ' ' + y2),
    raw: (s) => A.push(s),
    // 按无障碍树点名点控件：菜单项一律走这条，坐标点击在菜单条上会命中左邻项
    uia: (name) => A.push('uia ' + b64(name), 'sleep 500'),
    menu: (menuName, itemName) => A.push('menu ' + b64(menuName) + ' ' + b64(itemName), 'sleep 550'),
  };
  build(api);
  const src = A.join('\n');
  fs.writeFileSync(`${TMP}/${name}.b64`, Buffer.from(src, 'utf8').toString('base64'), 'utf8');
  fs.writeFileSync(`${TMP}/${name}.txt`, src, 'utf8');
  console.log(`plan ${name}: ${A.length} steps -> ${TMP}/${name}.b64`);
}

export { FILE, WORK, TMP };

export function initFile(content = 'init\n') {
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(FILE, content, 'utf8');
}
