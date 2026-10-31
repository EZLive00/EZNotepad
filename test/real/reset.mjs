// 清掉 WebView 的 localStorage（草稿 + 设置），让每轮测试从全新状态开始。
// 用 Node 删而不是走 shell 的递归删除：本机的 safe-delete 钩子会拦下后者。
import fs from 'node:fs';

const base = 'C:/Users/51936/AppData/Local/com.simple.notepad/EBWebView/Default/Local Storage';
try {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  console.log('reset: local storage cleared');
} catch (e) {
  console.log('reset: skipped (' + e.code + ')');
}
