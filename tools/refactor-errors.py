# -*- coding: utf-8 -*-
"""一次性重构：把 lib.rs 里「返回中文成品句子」的错误改成「错误码 + 参数 + 细节」。

用完即弃，但留在 tools/ 里方便 review 到底改了哪 66 处。
"""
import pathlib
import re

p = pathlib.Path("src-tauri/src/lib.rs")
t = p.read_text(encoding="utf-8")

# 1) 所有命令的 `Result<T, String>` → `Result<T, AppError>`
t, n_sig = re.subn(r"Result<((?:[^<>]|<[^<>]*>)*), String>", r"Result<\1, AppError>", t)

# 2) 挂上模块
old_head = "use serde::{Deserialize, Serialize};\nuse std::fs;"
new_head = "mod error;\n\nuse error::AppError;\nuse serde::{Deserialize, Serialize};\nuse std::fs;"
assert old_head in t
t = t.replace(old_head, new_head, 1)

R = [
    # ---- read_text_file ----
    ('fs::read(&p).map_err(|e| format!("无法读取文件：{e}"))?',
     'fs::read(&p).map_err(|e| AppError::detail("io.read", e))?'),
    ('return Err("这是二进制文件，无法以文本方式打开".into());',
     'return Err(AppError::new("file.binary"));'),
    # ---- save_text_file ----
    ('fs::create_dir_all(dir).map_err(|e| format!("无法创建目录：{e}"))?',
     'fs::create_dir_all(dir).map_err(|e| AppError::detail("io.mkdir", e))?'),
    ('return Err("文件过大".into());', 'return Err(AppError::new("file.too_large"));'),
    ('fs::write(&p, &out).map_err(|e| format!("保存失败：{e}"))?',
     'fs::write(&p, &out).map_err(|e| AppError::detail("io.save", e))?'),
    # ---- check_simple_name ----
    ('return Err("名字不能为空".into());', 'return Err(AppError::new("name.empty"));'),
    ('return Err("名字里不能带路径分隔符".into());',
     'return Err(AppError::new("name.path_sep"));'),
    (r'return Err("名字里有不允许的字符（< > : \" | ? *）".into());',
     'return Err(AppError::new("name.invalid_chars"));'),
    # ---- create_entry / rename_entry ----
    ('return Err("目标文件夹不存在".into());', 'return Err(AppError::new("dir.missing"));'),
    ('return Err(format!("「{name}」已经存在"));',
     'return Err(AppError::var("entry.exists", "name", &name));'),
    ('.map_err(|e| format!("创建失败：{e}"))?;',
     '.map_err(|e| AppError::detail("io.create", e))?;'),
    ('return Err("这个条目已经不存在了".into());',
     'return Err(AppError::new("entry.missing"));'),
    ('let parent = src.parent().ok_or("找不到所在文件夹")?;',
     'let parent = src.parent().ok_or_else(|| AppError::new("entry.no_parent"))?;'),
    ('fs::rename(&src, &dst).map_err(|e| format!("重命名失败：{e}"))?;',
     'fs::rename(&src, &dst).map_err(|e| AppError::detail("io.rename", e))?;'),
    # ---- delete ----
    ('return Err(format!("移入回收站失败（错误码 {rc}）"));',
     'return Err(AppError::var("recycle.failed", "rc", rc));'),
    ('return Err("操作已取消".into());', 'return Err(AppError::new("op.cancelled"));'),
    ('fs::remove_file(p).map_err(|e| format!("删除失败：{e}"))',
     'fs::remove_file(p).map_err(|e| AppError::detail("io.delete", e))'),
    ('return fs::remove_dir(&p).map_err(|e| format!("目录里还有东西，无法删除：{e}"));',
     'return fs::remove_dir(&p).map_err(|e| AppError::detail("dir.not_empty", e));'),
    # ---- 目录遍历 ----
    ('return Err("不是文件夹".into());', 'return Err(AppError::new("dir.not_folder"));'),
    ('let rd = fs::read_dir(&root).map_err(|e| format!("读取目录失败：{e}"))?;',
     'let rd = fs::read_dir(&root).map_err(|e| AppError::detail("dir.read", e))?;'),
    # ---- 搜索 / 替换 ----
    ('Some(regex::Regex::new(&query).map_err(|e| format!("正则写错了：{e}"))?)',
     'Some(regex::Regex::new(&query).map_err(|e| AppError::detail("regex.invalid", e))?)'),
    ('regex::Regex::new(&query).map_err(|e| format!("正则写错了：{e}"))?',
     'regex::Regex::new(&query).map_err(|e| AppError::detail("regex.invalid", e))?'),
    ('return Err("要找的内容是空的".into());', 'return Err(AppError::new("search.empty"));'),
    ('regex::Regex::new(&src).map_err(|e| format!("匹配式无效：{e}"))?',
     'regex::Regex::new(&src).map_err(|e| AppError::detail("regex.bad_pattern", e))?'),
    # ---- 二进制写入 / base64 读取 ----
    ('fs::write(&path, &bytes).map_err(|e| format!("写入失败：{e}"))?;',
     'fs::write(&path, &bytes).map_err(|e| AppError::detail("io.write", e))?;'),
    ('.map_err(|e| format!("读不到文件：{e}"))?',
     '.map_err(|e| AppError::detail("io.read", e))?'),
    ('return Err(format!("图片超过 {}MB，没有内嵌", limit / 1024 / 1024));',
     'return Err(AppError::var("image.too_large_embed", "mb", limit / 1024 / 1024));'),
    # ---- 图片 ----
    ('return Err("图片文件不存在".into());', 'return Err(AppError::new("image.missing"));'),
    ('.ok_or("文档路径无效")?', '.ok_or_else(|| AppError::new("path.invalid"))?'),
    ('.map_err(|e| format!("创建 assets 目录失败：{e}"))?;',
     '.map_err(|e| AppError::detail("dir.assets", e))?;'),
    ('.ok_or("图片文件名无效")?', '.ok_or_else(|| AppError::new("image.name_invalid"))?'),
    ('return Err("同名图片太多了，换个文件名吧".into());',
     'return Err(AppError::new("image.too_many"));'),
    ('fs::copy(&src, &target).map_err(|e| format!("复制图片失败：{e}"))?;',
     'fs::copy(&src, &target).map_err(|e| AppError::detail("io.copy", e))?;'),
    ('.ok_or("目标文件名无效")?', '.ok_or_else(|| AppError::new("image.target_invalid"))?'),
    ('Err(e) => Err(format!("读取文件信息失败：{e}")),',
     'Err(e) => Err(AppError::detail("file.stat", e)),'),
    ('return Err("图片内容为空".into());', 'return Err(AppError::new("image.empty"));'),
    ('return Err("图片超过 64 MB，挡住它比较好".into());',
     'return Err(AppError::new("image.too_large_clip"));'),
    ('fs::write(dir.join(&name), &bytes).map_err(|e| format!("写入图片失败：{e}"))?;',
     'fs::write(dir.join(&name), &bytes).map_err(|e| AppError::detail("io.write_image", e))?;'),
    # ---- 本地历史 ----
    ('.map_err(|e| format!("找不到应用数据目录：{e}"))?',
     '.map_err(|e| AppError::detail("appdata.missing", e))?'),
    ('fs::create_dir_all(&dir).map_err(|e| format!("建立历史目录失败：{e}"))?;',
     'fs::create_dir_all(&dir).map_err(|e| AppError::detail("dir.history", e))?;'),
    ('.map_err(|e| format!("读历史目录失败：{e}"))?',
     '.map_err(|e| AppError::detail("dir.history_read", e))?'),
    ('.map_err(|e| format!("写历史快照失败：{e}"))?;',
     '.map_err(|e| AppError::detail("io.history_write", e))?;'),
    ('let bytes = fs::read(&path).map_err(|e| format!("读快照失败：{e}"))?;',
     'let bytes = fs::read(&path).map_err(|e| AppError::detail("io.snapshot", e))?;'),
    ('fs::remove_dir_all(&dir).map_err(|e| format!("清除历史失败：{e}"))?;',
     'fs::remove_dir_all(&dir).map_err(|e| AppError::detail("io.history_clear", e))?;'),
    # ---- 监听 / 窗口 ----
    ('.map_err(|_| "监听状态锁定失败")?', '.map_err(|_| AppError::new("state.lock"))?'),
    ('.map_err(|e| format!("无法建立文件监听：{e}"))?;',
     '.map_err(|e| AppError::detail("watch.create", e))?;'),
    ('.map_err(|_| "对比请求锁定失败")?', '.map_err(|_| AppError::new("state.lock"))?'),
    ('let win = builder.build().map_err(|e| e.to_string())?;',
     'let win = builder.build().map_err(|e| AppError::detail("win.create", e))?;'),
    ('return Err("对比窗口不在".into());',
     'return Err(AppError::new("win.compare_missing"));'),
    ('w.maximize().map_err(|e| e.to_string())',
     'w.maximize().map_err(|e| AppError::detail("win.state", e))'),
    ('w.unmaximize().map_err(|e| e.to_string())',
     'w.unmaximize().map_err(|e| AppError::detail("win.state", e))'),
]

missed = []
for old, new in R:
    if old not in t:
        missed.append(old[:70])
        continue
    t = t.replace(old, new)

p.write_text(t, encoding="utf-8")
print("签名改了", n_sig, "处")
print("未命中", len(missed))
for m in missed:
    print("  !", m)
