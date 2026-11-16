// ============================================================
// tearoff.js —— 标签拖出 / 拖回的那点纯计算
//
// 三件事都只跟坐标和标签字段有关，抽出来是为了能在 headless 里断言：
//   · 指针什么时候算「离开了标签栏」（拖出成窗口）
//   · 什么时候算「落在主窗口标签栏上」（拖回合并）
//   · 一个标签要以什么形状交给另一扇窗口
//
// 为什么拖出/拖回不用 HTML5 拖放：两扇窗口是两个 WebView，中间那一段是 OS 级
// 拖放，Tauri 的原生 drop 只给文件路径，自定义 MIME 拿不到；`dragDropEnabled`
// 又不能关（主窗口还要接外部拖进来的文件）。所以拖出看 dragend 坐标、拖回看
// pointerup 的屏幕坐标，两边都只比矩形。
// ============================================================

/** 拆出去那扇窗口的 label（Rust 侧 open_tearoff_window 生成） */
export const isTearoffLabel = (label) => /^tearoff-\d+$/.test(String(label || ''));

/**
 * 指针是不是已经离开标签栏了。
 *
 * 只判「离开」，不判「拖了多远」：用户想把标签拖出来时，动作必然是往下离开
 * 标签条（标签是横向排列的，横向拖是在换位）。左右出窗也算，但那一路只有鼠标
 * 真的甩到窗外才成立，用来兜住「往副屏上拖」这种。
 *
 * tol 取 24：标签本身 29px 高，排序时指针上下晃 ±10px 很常见，给到 24 才不至于
 * 把「拖到相邻标签上」误判成拖出。
 */
export function leftTabbar(bar, point, tol = 24) {
  if (!bar || !point) return false;
  const { x, y } = point;
  return y > bar.bottom + tol || y < bar.top - tol * 2
    || x < bar.left - tol || x > bar.right + tol;
}

/** 屏幕坐标是否落在矩形里（pad 是给「差一点没对准」留的容差） */
export function hitsRect(rect, x, y, pad = 20) {
  if (!rect) return false;
  return x >= rect.x - pad && x <= rect.x + rect.w + pad
    && y >= rect.y - pad && y <= rect.y + rect.h + pad;
}

/**
 * 交给另一扇窗口的标签形状。
 *
 * 有路径且是干净的，只带路径：新窗口按路径重读，编码 / BOM / 行尾 / mtime 全都能
 * 重新拿准，比把正文搬过去再猜一遍可靠。脏的（含未命名）必须连正文带过去 ——
 * 磁盘上没有这份内容，丢了就是丢了。
 */
export function tabSeed(tab, dirty) {
  if (!tab) return null;
  return {
    name: tab.name,
    content: tab.content,
    path: tab.path || null,
    mode: tab.mode || null,
    dirty: !!dirty,
    ding: !!tab.ding,     // 钉住跟着走：换扇窗口看它不该把锁抖掉
  };
}
