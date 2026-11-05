// ============================================================
// syntax.js —— 语法着色的打包入口（构建期文件）
//
// 只被 scripts/build-syntax.mjs 读，esbuild 打成一个单文件 ESM：
// src/vendor/syntax.js。运行时不直接加载本文件。
//
// 这里注册的语言 = 「预览 / 导出 HTML / 代码块」能用到的全部。
// 加一门语言只要两处：本文件加一行 import+register，src/js/langs.js
// 的注册表加一条（扩展名 → 规范名）。**不要**再手写分词规则。
//
// 体积控制：esbuild 按 import 裁剪，没 import 的语言不进产物。
// 少一门语言就少几 KB，所以这里按需列举，不用 `highlight.js/lib/all`。
// ============================================================
import hljs from 'highlight.js/lib/core';

/* ---- 基础语言先注册：typescript 依赖 javascript，scss 依赖 css ---- */
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('plaintext', plaintext);

/* ---- 其余：按字母序，方便查重 ---- */
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import fortran from 'highlight.js/lib/languages/fortran';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import http from 'highlight.js/lib/languages/http';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import json from 'highlight.js/lib/languages/json';
import julia from 'highlight.js/lib/languages/julia';
import kotlin from 'highlight.js/lib/languages/kotlin';
import latex from 'highlight.js/lib/languages/latex';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import objectivec from 'highlight.js/lib/languages/objectivec';
import pascal from 'highlight.js/lib/languages/delphi';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import vbnet from 'highlight.js/lib/languages/vbnet';
import verilog from 'highlight.js/lib/languages/verilog';
import vhdl from 'highlight.js/lib/languages/vhdl';
import yaml from 'highlight.js/lib/languages/yaml';

const MORE = {
  bash, c, clojure, cmake, cpp, csharp, dart, diff, dockerfile, dos, elixir, erlang,
  fortran, go, graphql, groovy, haskell, http, ini, java, json, julia, kotlin, latex,
  less, lua, makefile, markdown, nginx, objectivec, pascal, perl, php, powershell,
  properties, protobuf, python, r, ruby, rust, scala, scss, shell, sql, swift,
  typescript, vbnet, verilog, vhdl, yaml,
};
for (const [name, def] of Object.entries(MORE)) hljs.registerLanguage(name, def);

/* 老名字：hljs 里是 `xml`，用户键中文档里写 `html` 的情况走别名表，
   不在 hljs 里重复注册（两套注册会让 highlightAuto 自相残杀）。 */
hljs.registerAliases(['html'], { languageName: 'xml' });

export default hljs;
