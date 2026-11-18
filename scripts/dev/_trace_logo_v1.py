"""
⚠️ 把 logo-v1 描成 SVG（带底版）—— 重写轮廓追踪
 *
 * ⚠️⚠️ 之前的 trace_one（Moore 邻域 + Jacob's criterion）在胖图形上会提前终止
 *   → 改用 **Radial sweep + 边界跟随**：
 *     1. 从连通域最上方像素的左邻居作为起点
 *     2. 沿边界顺时针走，每步优先「右转 > 直行 > 左转」
 *     3. 回到起点即闭合
 *   → 对胖/圆滑图形稳定 ✅
"""

import sys
import numpy as np
from PIL import Image
from collections import deque

SRC = sys.argv[1] if len(sys.argv) > 1 else "shots/logo-v1.png"
OUT = sys.argv[2] if len(sys.argv) > 2 else "public/images/brand/moira-mark.svg"
SCALE = 600

img = Image.open(SRC).convert("RGB").resize((SCALE, SCALE), Image.LANCZOS)
rgb = np.asarray(img).astype(np.int16)
r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]

gold = (r > 150) & (g > 110) & (b < 170) & ((r - b) > 45)
# ⚠️ 紫色阈值收紧：阴影的 (b-r) 差值小 → 排除
purple = (b - r > 34) & (b > 90) & (r < 190)


def _open(m, r=1):
    """形态学开运算 → 去毛刺（先腐蚀再膨胀）"""
    H, W = m.shape
    e = m.copy()
    for _ in range(r):
        nxt = e.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nxt &= np.roll(np.roll(e, dy, 0), dx, 1)
        e = nxt
    for _ in range(r):
        nxt = e.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nxt |= np.roll(np.roll(e, dy, 0), dx, 1)
        e = nxt
    return e


def _close(m, r=1):
    """形态学闭运算 → 补小孔"""
    H, W = m.shape
    d = m.copy()
    for _ in range(r):
        nxt = d.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nxt |= np.roll(np.roll(d, dy, 0), dx, 1)
        d = nxt
    for _ in range(r):
        nxt = d.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nxt &= np.roll(np.roll(d, dy, 0), dx, 1)
        d = nxt
    return d


gold = _close(gold, 1)
# ⚠️ 紫色底**不描摹** —— 它是圆角方块，用 <rect rx> 直接画更干净
#   （描摹会把阴影当成紫色 → 毛边；而且 AI 图的圆角不是标准圆角）
purple = None
print(f"gold {gold.mean()*100:.1f}%")

# 8 邻域，逆时针顺序（用于「右转优先」）
NB = [(0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1)]
NB_NAME = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"]


def components(mask, min_area):
    H, W = mask.shape
    lab = np.zeros((H, W), dtype=np.int32)
    cid = 0
    for y in range(H):
        for x in range(W):
            if mask[y, x] and lab[y, x] == 0:
                cid += 1
                lab[y, x] = cid
                q = deque([(y, x)])
                while q:
                    cy, cx = q.popleft()
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = cy + dy, cx + dx
                            if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and lab[ny, nx] == 0:
                                lab[ny, nx] = cid
                                q.append((ny, nx))
    areas = np.bincount(lab.ravel())
    order = np.argsort(areas)[::-1]
    out = []
    for i in order:
        if i == 0:
            continue
        if areas[i] < min_area:
            break
        ys, xs = np.where(lab == i)
        out.append((int(areas[i]), lab == i, ys, xs))
    return out


def trace_boundary(m, start, start_dir=4):
    """
    ⚠️ 边界跟随（Moore-neighbor tracing，方向优先）
    start: (y,x) —— 必须在**前景**上
    start_dir: 进入起点时的来向（4=W 左, 6=N 上）
    """
    H, W = m.shape
    sy, sx = start
    cur = (sy, sx)
    bdir = start_dir
    contour = []
    guard = 0
    while guard < 500000:
        guard += 1
        contour.append(cur)
        found = False
        # 右转优先：d+2, d+1, d, d-1, d-2, ...
        for delta in (2, 1, 0, 7, 6, 5, 4, 3):
            nd = (bdir + delta) % 8
            ny = cur[0] + NB[nd][0]
            nx = cur[1] + NB[nd][1]
            if 0 <= ny < H and 0 <= nx < W and m[ny, nx]:
                cur = (ny, nx)
                bdir = nd
                found = True
                break
        if not found:
            break
        if cur == contour[0] and len(contour) > 3:
            break
    return contour


def shoelace(c):
    p = np.asarray(c, dtype=np.float64)
    x, y = p[:, 1], p[:, 0]
    return 0.5 * (np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def dp(points, eps):
    if len(points) < 3:
        return points
    pts = np.asarray(points, dtype=np.float64)
    a0, b0 = pts[0], pts[-1]
    ab = b0 - a0
    n = float(np.hypot(ab[0], ab[1]))
    if n == 0:
        d = np.hypot(pts[:, 0] - a0[0], pts[:, 1] - a0[1])
    else:
        d = np.abs((ab[0] * (pts[:, 1] - a0[1]) - ab[1] * (pts[:, 0] - a0[0])) / n)
    i = int(np.argmax(d))
    if d[i] > eps:
        return dp(points[: i + 1], eps)[:-1] + dp(points[i:], eps)
    return [points[0], points[-1]]


def find_holes(cm):
    """找连通域内部的洞（不与画面边缘连通的空白）"""
    H, W = cm.shape
    inv = ~cm
    # 全局外部背景（画面边缘可达）
    bg = np.zeros_like(inv)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if inv[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for y in range(H):
        for x in (0, W - 1):
            if inv[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    while q:
        cy, cx = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < H and 0 <= nx < W and inv[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True
                q.append((ny, nx))
    holes_mask = inv & ~bg
    out = []
    for size, hm, ys, xs in components(holes_mask, 30)[:6]:
        top = int(ys.min())
        sx = int(xs[ys == top].min())
        out.append(hm)
    return out


def paths_from(mask, eps, min_area, want_holes=True):
    comps = components(mask, min_area)
    segs = []
    for size, cm, ys, xs in comps[:4]:
        # ⚠️⚠️ 起点必须是**边界上的**像素，且它的「后继」方向要有背景
        #   从最上像素开始可能全在内部 → 走不出去 → segs=0
        # → 改用：最左像素（它的左边一定是背景）→ 起始方向朝左(W)
        leftmost = int(xs.min())
        cand = ys[xs == leftmost]
        sy = int(cand.min())
        sx = leftmost
        outer = trace_boundary(cm, (sy, sx), start_dir=4)
        if len(outer) < 16:
            # 兜底：从上边界再来一次
            top = int(ys.min())
            sx2 = int(xs[ys == top].min())
            outer = trace_boundary(cm, (top, sx2), start_dir=6)
        if len(outer) < 16:
            continue
        segs.append((outer, True))
        if want_holes:
            for hm in find_holes(cm):
                hy = int(np.where(hm)[0].min())
                hxs = np.where(hm)[1]
                hx = int(hxs[np.where(hm)[0] == hy].min())
                hole = trace_boundary(hm, (hy, hx), start_dir=6)
                if len(hole) >= 12:
                    segs.append((hole, False))
    out = []
    for c, _ in segs:
        s = dp(c, eps)
        if len(s) >= 3:
            out.append(
                " ".join(
                    [f"M{s[0][1]:.1f},{s[0][0]:.1f}"]
                    + [f"L{p[1]:.1f},{p[0]:.1f}" for p in s[1:]]
                    + ["Z"]
                )
            )
    return " ".join(out), len(segs)


gold_path, gn = paths_from(gold, 1.1, 200)
print(f"gold segs={gn} len={len(gold_path)}")

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SCALE} {SCALE}" width="{SCALE}" height="{SCALE}" fill="none">
  <title>MOIRA</title>
  <defs>
    <linearGradient id="moiraBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7C3AED"/>
      <stop offset="55%" stop-color="#5B21B6"/>
      <stop offset="100%" stop-color="#3B1D78"/>
    </linearGradient>
    <linearGradient id="moiraGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFE9A3"/>
      <stop offset="50%" stop-color="#FFC93C"/>
      <stop offset="100%" stop-color="#F0A500"/>
    </linearGradient>
  </defs>
  <!-- ⚠️ 圆角紫底：几何绘制（不描摹 AI 图的阴影 → 无毛边） -->
  <rect x="0" y="0" width="{SCALE}" height="{SCALE}" rx="150" ry="150" fill="url(#moiraBg)"/>
  <path d="{gold_path}" fill="url(#moiraGold)" fill-rule="evenodd"/>
</svg>
'''
with open(OUT, "w", encoding="utf-8") as f:
    f.write(svg)
print(f"wrote {OUT} ({len(svg)} bytes)")
