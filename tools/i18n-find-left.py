#!/usr/bin/env python3
"""找出 JS 里「还没被 tt() 包住」的中文字面量（改完 i18n 收尾用）。

用途：i18n 包装做了一半时，列出剩下哪些可见文案还写死。
只做静态扫描，不改文件。输出 `文件:行: 片段`。

判定：字符串 / 模板字面量里含汉字，且紧邻的前面不是 `tt(`。
注释整段跳过。
"""
import re
import sys
import pathlib

CJK = re.compile(r'[\u4e00-\u9fff]')


def scan_js(text):
    """返回 [(line_no, snippet, wrapped)]，只含带汉字的单/双引号与模板字面量。"""
    out = []
    i, n = 0, len(text)
    line = 1
    while i < n:
        c = text[i]
        if c == '\n':
            line += 1
            i += 1
            continue
        # 行注释
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        # 块注释
        if c == '/' and i + 1 < n and text[i + 1] == '*':
            j = text.find('*/', i + 2)
            seg = text[i:(n if j < 0 else j + 2)]
            line += seg.count('\n')
            i = n if j < 0 else j + 2
            continue
        if c in '\'"`':
            q = c
            j = i + 1
            buf = []
            while j < n:
                if text[j] == '\\':
                    buf.append(text[j:j + 2])
                    j += 2
                    continue
                if text[j] == q:
                    break
                if text[j] == '\n':
                    if q != '`':
                        break
                    line += 1
                buf.append(text[j])
                j += 1
            body = ''.join(buf)
            if CJK.search(body):
                # 往前跳过空白，看是不是 tt(
                k = i - 1
                while k >= 0 and text[k] in ' \t\r\n':
                    k -= 1
                wrapped = (k >= 2 and text[k] == '(' and text[k - 2:k] == 'tt')
                out.append((line, body.replace('\n', '\\n')[:90], wrapped))
            i = j + 1
            continue
        i += 1
    return out


def main():
    roots = sys.argv[1:] or ['src/js', 'src']
    files = []
    for r in roots:
        p = pathlib.Path(r)
        if p.is_file():
            files.append(p)
        else:
            files += sorted(p.glob('*.js'))
    total = 0
    for f in files:
        if f.name.startswith('i18n'):
            continue
        text = f.read_text(encoding='utf-8')
        if f.suffix == '.js':
            rows = [(ln, s) for ln, s, w in scan_js(text) if not w]
        else:
            rows = []
        if rows:
            total += len(rows)
            print(f'\n== {f}  ({len(rows)})')
            for ln, s in rows:
                print(f'  {ln}: {s}')
    print(f'\n未包住的中文字面量合计：{total}')


if __name__ == '__main__':
    main()
