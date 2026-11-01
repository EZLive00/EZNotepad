#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把源码里的中文字面量包成 tt('...')，并报告「有插值的模板字面量」留给人工处理。

为什么不能直接跑正则：模板字面量里常写着 <button title="关闭">，
按行匹配会把 HTML 属性也包成 tt(...)，直接炸掉 DOM。所以这里走一遍
极简状态机，只处理「普通代码区」里的单/双引号字面量。
"""
import re, sys, os, json

CJK = re.compile(r'[\u4e00-\u9fff]')
CJK_PUNCT = re.compile(r'[\u3000-\u303f\uff00-\uffef]')

def has_cjk(s):
    return bool(CJK.search(s))

def scan(src):
    """返回 (需要包的区间列表 [(start, end)], 含中文的模板字面量 [(start,end)])"""
    n = len(src)
    i = 0
    wraps = []
    templates = []
    state = 'code'  # code | sq | dq | tpl | line | block
    stmt_start = 0
    while i < n:
        c = src[i]
        if state == 'code':
            if c == '/' and i + 1 < n and src[i+1] == '/':
                state = 'line'; i += 2; continue
            if c == '/' and i + 1 < n and src[i+1] == '*':
                state = 'block'; i += 2; continue
            if c == "'" or c == '"':
                q = c; j = i + 1
                while j < n:
                    if src[j] == '\\': j += 2; continue
                    if src[j] == q: break
                    if src[j] == '\n': break
                    j += 1
                body = src[i+1:j]
                state = 'code'
                if j < n and src[j] == q:
                    # 后面紧跟 : 说明是对象键 / case 标签，不动
                    k = j + 1
                    while k < n and src[k] in ' \t': k += 1
                    is_key = k < n and src[k] == ':'
                    before = src[max(0, i-3):i]
                    already = before.rstrip().endswith('tt(')
                    if has_cjk(body) and not is_key and not already:
                        wraps.append((i, j + 1))
                i = j + 1; continue
            if c == '`':
                j = i + 1
                while j < n:
                    if src[j] == '\\': j += 2; continue
                    if src[j] == '`': break
                    j += 1
                body = src[i+1:j]
                if has_cjk(body):
                    templates.append((i, min(j + 1, n)))
                i = j + 1; continue
            i += 1; continue
        if state == 'line':
            if c == '\n': state = 'code'
            i += 1; continue
        if state == 'block':
            if c == '*' and i + 1 < n and src[i+1] == '/':
                state = 'code'; i += 2; continue
            i += 1; continue
    return wraps, templates


def apply(path, dry=False):
    src = open(path, encoding='utf-8').read()
    wraps, templates = scan(src)
    if not wraps:
        return 0, len(templates), ''
    out = []
    last = 0
    for (a, b) in wraps:
        out.append(src[last:a])
        out.append('tt(' + src[a:b] + ')')
        last = b
    out.append(src[last:])
    newsrc = ''.join(out)
    if not dry:
        open(path, 'w', encoding='utf-8', newline='\n').write(newsrc)
    return len(wraps), len(templates), newsrc


if __name__ == '__main__':
    dry = '--dry' in sys.argv
    files = [a for a in sys.argv[1:] if not a.startswith('--')]
    report = {}
    for f in files:
        n, nt, _ = apply(f, dry)
        report[f] = {'wrapped': n, 'templates': nt}
        print(f'{f}: 包装 {n} 处, 待人工模板 {nt} 处')
    print('DRY RUN' if dry else '已写入')
    json.dump(report, open('D:/tmp/i18n-report.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
