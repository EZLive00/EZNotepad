#!/usr/bin/env python3
"""把 i18n-dict-src.js（7 种语言）编译成 i18n-dict.js（含繁体，8 种语言）。

    python tools/build-i18n-dict.py

为什么要这一步：繁体（zh-TW）不手写，用 OpenCC 的 s2twp 做「简体→台湾正体+短语」
转换（文件→檔案、设置→設定、保存→儲存）。手写五百条繁体不现实，也容易前后不一致。
所以源文件只维护 7 列，繁体由本脚本生成，产物是运行时真正加载的那份表。

列顺序（DICT 的值）：[繁, en, ja, ko, fr, de, es, pt]
简体中文不占位 —— 键本身就是简体，i18n.js 里 COL['zh-CN'] = -1。

依赖：pip install opencc-python-reimplemented
"""
import json
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / 'src/js/i18n-dict-src.js'
OUT = ROOT / 'src/js/i18n-dict.js'
LANGS = ['en', 'ja', 'ko', 'fr', 'de', 'es', 'pt']


def load_src():
    """用 node 把 SRC 求值成 JSON —— 比在 Python 里解析 JS 靠谱。"""
    code = (
        "import('file:///" + SRC.as_posix() + "').then(m=>"
        "process.stdout.write(JSON.stringify(m.SRC)))"
    )
    r = subprocess.run(['node', '-e', code], capture_output=True, text=True,
                       encoding='utf-8', cwd=str(ROOT))
    if r.returncode != 0:
        print(r.stderr, file=sys.stderr)
        raise SystemExit('读取词条源失败')
    return json.loads(r.stdout)


def js_str(s):
    """JS 单引号字符串字面量。只转义单引号、反斜杠和控制字符。"""
    out = (s.replace('\\', '\\\\').replace("'", "\\'")
            .replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t'))
    return "'" + out + "'"


def main():
    try:
        import opencc
    except ImportError:
        raise SystemExit('缺少依赖：python -m pip install opencc-python-reimplemented')
    cc = opencc.OpenCC('s2twp')

    src = load_src()
    lines = [
        '// 由 tools/build-i18n-dict.py 生成，请勿手改 —— 改 i18n-dict-src.js 后重新生成。',
        '// 值顺序：[繁體中文, English, 日本語, 한국어, Français, Deutsch, Español, Português]',
        '// 键是简体中文原文（gettext 风格），简体直接用键，所以这里不含简体列。',
        'export const DICT = {',
    ]
    bad = []
    for zh, row in src.items():
        if len(row) != len(LANGS):
            bad.append((zh, len(row)))
            continue
        tw = cc.convert(zh)
        vals = [js_str(tw)] + [js_str(v) for v in row]
        lines.append('  ' + js_str(zh) + ': [' + ', '.join(vals) + '],')
    lines.append('};')
    lines.append('')
    OUT.write_text('\n'.join(lines), encoding='utf-8', newline='\n')  # Windows 上默认会把 \n 翻成 CRLF，仓库要 LF

    print(f'词条：{len(src)}  输出：{OUT.relative_to(ROOT)}  '
          f'{OUT.stat().st_size / 1024:.0f} KB')
    if bad:
        print('列数不符（已跳过）：', bad[:10])


if __name__ == '__main__':
    main()
