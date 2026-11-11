// ============================================================
// langs.js —— 语言注册表（整个项目只有这一份）
//
// 「一个扩展名是什么语言」这件事以前散在四个地方各写一遍：
// highlight.js 的归一表、plain-editor 的 LANGS、format.js 的 detectKind、
// app.js 的 newTypes。四处各漏一点，结果就是「.jsonl 没有高亮、.kt 也没
// 有」。现在一律查本表：
//
//   id      规范名（项目内部唯一叫法，如 'js' / 'py'）
//   label   显示名（中文源串，取用时过 tt()）
//   exts    扩展名（不含点）
//   files   没有扩展名、只能按文件名认的（Dockerfile / Makefile）
//   hljs    highlight.js 的语言名（预览、导出 HTML、代码块着色用）
//   cm      CodeMirror 语言工厂名（纯文本编辑区的着色用；null = 该引擎没有）
//   fmt     prettier 的 parser 名（null = 不支持格式化，只做保守清理）
//   kind    文档大类：md / json / code / txt / data（决定模式与预览方式）
//   desc    新建文档对话框里的小字
//
// 加一门语言：本表加一条；若 hljs / cm 那侧没有现成语法，先确认能不能
// 用现成 parser 顶（别自己写分词）。对应方向的入口文件里补一行 import。
// ============================================================

/**
 * 规范名 → 定义。顺序即「新建文档」网格里的顺序（前 12 个占第一屏）。
 * 注意：hljs / cm 为 null 的语言，编辑区或预览会是纯文本，但不会报错。
 */
export const LANGS = {
  md: { label: 'Markdown', exts: ['md', 'markdown', 'mdown', 'mkd'], files: [], hljs: 'markdown', cm: 'markdown', fmt: 'markdown', kind: 'md', desc: '所见即所得写作' },
  txt: { label: '纯文本', exts: ['txt', 'text', 'log', 'nfo', 'dat', 'srt', 'ass'], files: [], hljs: 'plaintext', cm: null, fmt: null, kind: 'txt', desc: '记事 / 日志' },

  json: { label: 'JSON', exts: ['json'], files: [], hljs: 'json', cm: 'json', fmt: 'json-stringify', kind: 'json', desc: '校验 + 高亮' },
  jsonl: { label: 'JSON Lines', exts: ['jsonl', 'ndjson'], files: [], hljs: 'json', cm: 'json', fmt: null, kind: 'code', desc: '' },
  yaml: { label: 'YAML', exts: ['yaml', 'yml'], files: [], hljs: 'yaml', cm: 'yaml', fmt: 'yaml', kind: 'code', desc: '' },
  toml: { label: 'TOML', exts: ['toml'], files: [], hljs: 'ini', cm: 'toml', fmt: null, kind: 'code', desc: '' },
  ini: { label: 'INI', exts: ['ini', 'conf', 'cfg', 'properties', 'props', 'env'], files: [], hljs: 'ini', cm: 'ini', fmt: null, kind: 'code', desc: '' },
  csv: { label: 'CSV', exts: ['csv', 'tsv'], files: [], hljs: null, cm: null, fmt: null, kind: 'data', desc: '表格文本' },

  html: { label: 'HTML', exts: ['html', 'htm'], files: [], hljs: 'xml', cm: 'html', fmt: 'html', kind: 'code', desc: '' },
  xml: { label: 'XML', exts: ['xml', 'xsd', 'xsl', 'svg', 'plist', 'rss'], files: [], hljs: 'xml', cm: 'xml', fmt: null, kind: 'code', desc: '' },
  vue: { label: 'Vue', exts: ['vue'], files: [], hljs: 'xml', cm: 'vue', fmt: 'html', kind: 'code', desc: '' },
  css: { label: 'CSS', exts: ['css'], files: [], hljs: 'css', cm: 'css', fmt: 'css', kind: 'code', desc: '' },
  scss: { label: 'SCSS', exts: ['scss'], files: [], hljs: 'scss', cm: 'scss', fmt: 'scss', kind: 'code', desc: '' },
  less: { label: 'Less', exts: ['less'], files: [], hljs: 'less', cm: 'less', fmt: 'less', kind: 'code', desc: '' },

  js: { label: 'JavaScript', exts: ['js', 'mjs', 'cjs'], files: [], hljs: 'javascript', cm: 'js', fmt: 'babel', kind: 'code', desc: '代码高亮' },
  jsx: { label: 'JSX', exts: ['jsx'], files: [], hljs: 'javascript', cm: 'jsx', fmt: 'babel', kind: 'code', desc: '' },
  ts: { label: 'TypeScript', exts: ['ts', 'mts', 'cts'], files: [], hljs: 'typescript', cm: 'ts', fmt: 'typescript', kind: 'code', desc: '' },
  tsx: { label: 'TSX', exts: ['tsx'], files: [], hljs: 'typescript', cm: 'tsx', fmt: 'typescript', kind: 'code', desc: '' },
  py: { label: 'Python', exts: ['py', 'pyw', 'pyi'], files: [], hljs: 'python', cm: 'py', fmt: null, kind: 'code', desc: '' },
  go: { label: 'Go', exts: ['go'], files: [], hljs: 'go', cm: 'go', fmt: null, kind: 'code', desc: '' },
  rs: { label: 'Rust', exts: ['rs'], files: [], hljs: 'rust', cm: 'rust', fmt: null, kind: 'code', desc: '' },
  java: { label: 'Java', exts: ['java'], files: [], hljs: 'java', cm: 'java', fmt: null, kind: 'code', desc: '' },
  kt: { label: 'Kotlin', exts: ['kt', 'kts'], files: [], hljs: 'kotlin', cm: 'kotlin', fmt: null, kind: 'code', desc: '' },
  cs: { label: 'C#', exts: ['cs'], files: [], hljs: 'csharp', cm: 'csharp', fmt: null, kind: 'code', desc: '' },
  c: { label: 'C', exts: ['c', 'h'], files: [], hljs: 'c', cm: 'c', fmt: null, kind: 'code', desc: '' },
  cpp: { label: 'C++', exts: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'], files: [], hljs: 'cpp', cm: 'cpp', fmt: null, kind: 'code', desc: '' },
  objc: { label: 'Objective-C', exts: ['m', 'mm'], files: [], hljs: 'objectivec', cm: 'objc', fmt: null, kind: 'code', desc: '' },
  swift: { label: 'Swift', exts: ['swift'], files: [], hljs: 'swift', cm: 'swift', fmt: null, kind: 'code', desc: '' },
  php: { label: 'PHP', exts: ['php', 'phtml'], files: [], hljs: 'php', cm: 'php', fmt: null, kind: 'code', desc: '' },
  rb: { label: 'Ruby', exts: ['rb', 'rake', 'gemspec'], files: [], hljs: 'ruby', cm: 'ruby', fmt: null, kind: 'code', desc: '' },
  lua: { label: 'Lua', exts: ['lua'], files: [], hljs: 'lua', cm: 'lua', fmt: null, kind: 'code', desc: '' },
  dart: { label: 'Dart', exts: ['dart'], files: [], hljs: 'dart', cm: 'dart', fmt: null, kind: 'code', desc: '' },
  scala: { label: 'Scala', exts: ['scala', 'sc'], files: [], hljs: 'scala', cm: 'scala', fmt: null, kind: 'code', desc: '' },
  groovy: { label: 'Groovy', exts: ['groovy', 'gradle'], files: [], hljs: 'groovy', cm: 'groovy', fmt: null, kind: 'code', desc: '' },
  ex: { label: 'Elixir', exts: ['ex', 'exs'], files: [], hljs: 'elixir', cm: null, fmt: null, kind: 'code', desc: '' },
  hs: { label: 'Haskell', exts: ['hs'], files: [], hljs: 'haskell', cm: 'hs', fmt: null, kind: 'code', desc: '' },
  clj: { label: 'Clojure', exts: ['clj', 'cljs', 'edn'], files: [], hljs: 'clojure', cm: 'clj', fmt: null, kind: 'code', desc: '' },
  erl: { label: 'Erlang', exts: ['erl', 'hrl'], files: [], hljs: 'erlang', cm: 'erl', fmt: null, kind: 'code', desc: '' },
  jl: { label: 'Julia', exts: ['jl'], files: [], hljs: 'julia', cm: 'jl', fmt: null, kind: 'code', desc: '' },
  r: { label: 'R', exts: ['r'], files: [], hljs: 'r', cm: 'r', fmt: null, kind: 'code', desc: '' },
  f90: { label: 'Fortran', exts: ['f90', 'f95', 'f03'], files: [], hljs: 'fortran', cm: 'fortran', fmt: null, kind: 'code', desc: '' },
  pas: { label: 'Pascal', exts: ['pas', 'pp'], files: [], hljs: 'pascal', cm: 'pascal', fmt: null, kind: 'code', desc: '' },
  vb: { label: 'Visual Basic', exts: ['vb', 'vbs'], files: [], hljs: 'vbnet', cm: 'vb', fmt: null, kind: 'code', desc: '' },

  sh: { label: 'Shell', exts: ['sh', 'bash', 'zsh', 'ksh', 'fish'], files: ['.bashrc', '.zshrc', '.profile'], hljs: 'bash', cm: 'sh', fmt: null, kind: 'code', desc: '' },
  ps1: { label: 'PowerShell', exts: ['ps1', 'psm1'], files: [], hljs: 'powershell', cm: 'ps1', fmt: null, kind: 'code', desc: '' },
  bat: { label: '批处理', exts: ['bat', 'cmd'], files: [], hljs: 'dos', cm: null, fmt: null, kind: 'code', desc: '' },
  sql: { label: 'SQL', exts: ['sql'], files: [], hljs: 'sql', cm: 'sql', fmt: null, kind: 'code', desc: '' },
  proto: { label: 'Protocol Buffers', exts: ['proto'], files: [], hljs: 'protobuf', cm: 'proto', fmt: null, kind: 'code', desc: '' },
  graphql: { label: 'GraphQL', exts: ['graphql', 'gql'], files: [], hljs: 'graphql', cm: null, fmt: null, kind: 'code', desc: '' },
  http: { label: 'HTTP', exts: ['http', 'rest'], files: [], hljs: 'http', cm: 'http', fmt: null, kind: 'code', desc: '' },
  cmake: { label: 'CMake', exts: ['cmake'], files: ['CMakeLists.txt'], hljs: 'cmake', cm: 'cmake', fmt: null, kind: 'code', desc: '' },
  docker: { label: 'Dockerfile', exts: ['dockerfile'], files: ['Dockerfile', '.dockerignore'], hljs: 'dockerfile', cm: 'dockerfile', fmt: null, kind: 'code', desc: '' },
  make: { label: 'Makefile', exts: ['mk', 'make'], files: ['Makefile', 'makefile', 'GNUmakefile'], hljs: 'makefile', cm: null, fmt: null, kind: 'code', desc: '' },
  nginx: { label: 'Nginx', exts: ['nginx'], files: ['nginx.conf'], hljs: 'nginx', cm: 'nginx', fmt: null, kind: 'code', desc: '' },
  diff: { label: 'Diff', exts: ['diff', 'patch'], files: [], hljs: 'diff', cm: 'diff', fmt: null, kind: 'txt', desc: '' },
  tex: { label: 'LaTeX', exts: ['tex', 'sty', 'cls'], files: [], hljs: 'latex', cm: 'tex', fmt: null, kind: 'code', desc: '' },
  v: { label: 'Verilog', exts: ['v', 'sv'], files: [], hljs: 'verilog', cm: 'verilog', fmt: null, kind: 'code', desc: '' },
  vhdl: { label: 'VHDL', exts: ['vhdl', 'vhd'], files: [], hljs: 'vhdl', cm: 'vhdl', fmt: null, kind: 'code', desc: '' },
};

/** 别名（用户写 ```jsx、hljs 叫 javascript、老代码叫 py）→ 规范名 */
const ALIAS = {
  /* 各引擎的语言名 */
  javascript: 'js', node: 'js', typescript: 'ts', tsx: 'tsx',
  python: 'py', py3: 'py', golang: 'go', rust: 'rs',
  bash: 'sh', shell: 'sh', zsh: 'sh', csh: 'sh', console: 'sh',
  pwsh: 'ps1', dos: 'bat', cmd: 'bat',
  csharp: 'cs', 'c#': 'cs', kotlin: 'kt', objectivec: 'objc', 'objective-c': 'objc',
  'c++': 'cpp', cxx: 'cpp', hxx: 'cpp',
  golang2: 'go',
  latex: 'tex', tex: 'tex',
  vbnet: 'vb', 'visual basic': 'vb',
  php: 'php', ruby: 'rb', python2: 'py',
  protobuf: 'proto', proto3: 'proto',
  plaintext: 'txt', text: 'txt', plain: 'txt', none: 'txt',
  xml: 'xml', svg: 'xml', html: 'html', htm: 'html',
  md: 'md', markdown: 'md', gfm: 'md',
  json5: 'jsonc', jsonc: 'jsonc', jsonl: 'jsonl', ndjson: 'jsonl',
  yml: 'yaml', toml: 'toml', pod: 'txt', rst: 'txt',
  makefile: 'make', dockerfile: 'docker', nginxconf: 'nginx',
  hcl: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', props: 'ini', env: 'ini',
  m: 'objc', mm: 'objc',
  r: 'r', julia: 'jl',
  c: 'c', h: 'c', cpp: 'cpp',
  cs: 'cs', scala: 'scala', groovy: 'groovy', gradle: 'groovy',
  elixir: 'ex', haskell: 'hs', clojure: 'clj', erlang: 'erl',
  fortran: 'f90', delphi: 'pas', pascal: 'pas',
  vb: 'vb', vbs: 'vb',
  verilog: 'v', systemverilog: 'v', sv: 'v', vhd: 'vhdl',
  cmake: 'cmake', diff: 'diff', patch: 'diff',
  graphql: 'graphql', gql: 'graphql', http: 'http', rest: 'http',
  tex: 'tex', sty: 'tex',
};

/** 规范化：接受扩展名、别名、hljs 名、CM 名，返回注册表里的规范名；认不出返回 '' */
export function normalizeLang(x) {
  const s = String(x || '').trim().toLowerCase().replace(/^\./, '');
  if (!s) return '';
  if (LANGS[s]) return s;
  /* hljs 的 `plaintext` 这类带短横/点的名字再过一遍别名表 */
  const a = ALIAS[s];
  return a && LANGS[a] ? a : '';
}

/** 规范名 → 定义对象（认不出返回 null） */
export function langInfo(id) {
  const k = normalizeLang(id);
  return k ? LANGS[k] : null;
}

/** 从文件名认语言：先看「无扩展名」的整名（Dockerfile），再看扩展名 */
export function langForFile(name = '') {
  const base = String(name).replace(/\\/g, '/').split('/').pop() || '';
  for (const [id, def] of Object.entries(LANGS)) {
    if (def.files && def.files.some((f) => f.toLowerCase() === base.toLowerCase())) return id;
  }
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return normalizeLang(base.slice(dot + 1));
}

/** 语言是否支持 prettier 格式化 */
export function canFormat(id) {
  const def = langInfo(id);
  return !!(def && def.fmt);
}

/** 新建文档对话框里列出的类型（顺序 = 本表顺序，desc 为小字） */
export function newDocTypes() {
  const order = ['md', 'txt', 'json', 'jsonl', 'yaml', 'csv', 'js', 'ts', 'py', 'html', 'css', 'sh',
    'go', 'rs', 'java', 'kt', 'cs', 'c', 'cpp', 'php', 'rb', 'lua', 'sql', 'xml', 'toml', 'ini', 'vue', 'diff'];
  return order.filter((id) => LANGS[id]).map((id) => ({
    id,
    ext: LANGS[id].exts[0],
    label: LANGS[id].label,
    desc: LANGS[id].desc || '',
  }));
}
