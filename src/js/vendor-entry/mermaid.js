// ============================================================
// vendor-entry/mermaid.js —— mermaid 的打包入口
//
// 只做一件事：把整包 mermaid 打成一个 ESM 文件（src/vendor/mermaid.js）。
// 业务代码不认识这个入口，桌面端只在**文档里真的出现 ```mermaid 块**时
// 才动态 import 生成出来的那个文件 —— 没有图的文档一分钱内存都不花。
// ============================================================
import mermaid from 'mermaid';

export default mermaid;
