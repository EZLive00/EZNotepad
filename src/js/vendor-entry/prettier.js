// ============================================================
// prettier.js —— 格式化的打包入口（构建期文件）
//
// 产物 src/vendor/format.js，由 src/js/format.js 动态 import（首次
// 格式化时才加载，不进启动路径）。运行时不直接加载本文件。
//
// 只装真正会用的 parser 插件：少一个插件少几百 KB。
//   babel      → js / jsx / json / jsonc / json5 / babel-ts
//   typescript → ts / tsx
//   estree     → babel 与 ts 的打印器依赖（缺了会报 "Couldn't find plugin"）
//   postcss    → css / less / scss
//   html       → html / vue
//   markdown   → md
//   yaml       → yaml
//
// ⚠️ key 必须是插件 `parsers` 表里真实存在的名字，不能写插件自己的名字：
// `postcss` 不是 parser（`Couldn't resolve parser "postcss"` 会让 CSS 格式化
// 一直弹「无法格式化」），它提供的是 css / less / scss 三个。宽松回退链
// 用到的 jsonc / json5 / babel-ts 也在这里一并登记。
// ============================================================
import * as prettier from 'prettier/standalone';
import * as babel from 'prettier/plugins/babel';
import * as estree from 'prettier/plugins/estree';
import * as typescript from 'prettier/plugins/typescript';
import * as postcss from 'prettier/plugins/postcss';
import * as html from 'prettier/plugins/html';
import * as markdown from 'prettier/plugins/markdown';
import * as yaml from 'prettier/plugins/yaml';

/** parser 名 → 需要加载的插件。key 与 prettier 的 parser 一一对得上 */
const PLUGIN_SETS = {
  babel: [babel, estree],
  'babel-ts': [babel, estree],
  json: [babel, estree],
  jsonc: [babel, estree],
  json5: [babel, estree],
  'json-stringify': [babel, estree],
  typescript: [typescript, estree],
  css: [postcss],
  less: [postcss],
  scss: [postcss],
  html: [html],
  markdown: [markdown],
  yaml: [yaml],
};

/**
 * 用 prettier 格式化文本。
 * 这里只做「挑插件 + 调 API」，格式化规则全归 prettier（不自己写缩进/换行逻辑）。
 *
 * @param {string} text
 * @param {string} parser prettier 的 parser 名（`babel` / `typescript` / `json` …）
 * @param {object} options 透传给 prettier（printWidth、proseWrap、tabWidth …）
 * @returns {Promise<string>}
 */
export function formatText(text, parser, options = {}) {
  const plugins = PLUGIN_SETS[parser];
  if (!plugins) return Promise.reject(new Error(`no prettier parser: ${parser}`));
  return prettier.format(text, { ...options, parser, plugins });
}

/** 哪些 parser 可用（format.js 的 supports 判据用它，免得两处各记一份） */
export const PARSERS = Object.keys(PLUGIN_SETS);
