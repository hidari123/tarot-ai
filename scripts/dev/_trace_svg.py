"""
⚠️ 描摹 v4 —— 用连通域标记（scipy-free，手写 BFS）
 * 每个前景连通域 → 只描它自己的外轮廓 + 洞
 * 不再全局追踪（避免重复）
"""

import sys
import numpy as np
from PIL import Image
from collections import deque

SRC, OUT = sys.argv[1], sys.argv[2]
SCALE = 600
EPS = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
MIN_AREA = int(sys.argv[4]) if len(sys.argv) > 4 else 250

img = Image.open(SRC).convert("L").resize((SCALE, SCALE), Image.LANCZOS)
a = np.asarray(img).astype(np.float32)

# Otsu
hist, _ = np.histogram(a, bins=256, range=(0, 256))
total = a.size
sum_all = np.dot(np.arange(256), hist)
sum_b, w_b, best_var, thr = 0.0, 0, -1, 128
for t in range(256):
    w_b += hist[t]
    if w_b == 0:
        continue
    w_f = total - w_b
    if w_f == 0:
        break
    sum_b += t * hist[t]
    m_b, m_f = sum_b / w_b, (sum_all - sum_b) / w_f
    var = w_b * w_f * (m_b - m_f) ** 2
    if var > best_var:
        best_var, thr = var, t
mask = a > thr
H, W = mask.shape
print(f"Otsu={thr} fg={mask.mean()*100:.1f}%")

NB = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]


def trace_one(m, sy, sx):
    """从 (sy,sx) 追踪一条轮廓（Jacob's stopping criterion）"""
    h, w = m.shape
    c = []
    cur = (sy, sx)
    start = cur
    bdir = 0
    guard = 0
    while guard < 400000:
        guard += 1
        c.append(cur)
        found = False
        for k in range(8):
            d = (bdir + 5 + k) % 8
            ny, nx = cur[0] + NB[d][0], cur[1] + NB[d][1]
            if 0 <= ny < h and 0 <= nx < w and m[ny, nx]:
                # Jacob's criterion：新点是否等于上上点 → 停
                if len(c) >= 3 and (ny, nx) == c[-3]:
                    return c
                cur, bdir, found = (ny, nx), d, True
                break
        if not found:
            break
        if cur == start and len(c) > 3:
            break
    return c


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


# ── 连通域标记（8 邻域）
labels = np.zeros((H, W), dtype=np.int32)
cid = 0
for y in range(H):
    for x in range(W):
        if mask[y, x] and labels[y, x] == 0:
            cid += 1
            labels[y, x] = cid
            q = deque([(y, x)])
            while q:
                cy, cx = q.popleft()
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cid
                            q.append((ny, nx))

comps = []
for i in range(1, cid + 1):
    ys, xs = np.where(labels == i)
    if len(ys) < MIN_AREA:
        continue
    comps.append((len(ys), i, ys, xs))
comps.sort(reverse=True)
print(f"components >= {MIN_AREA}px : {len(comps)}  sizes = {[c[0] for c in comps[:8]]}")

paths = []
for size, lab_id, ys, xs in comps[:8]:
    comp_mask = labels == lab_id
    # 外轮廓起点：该连通域最上方一行、最左的像素
    top = ys.min()
    row = xs[ys == top]
    sx = row.min()
    outer = trace_one(comp_mask, top, sx)
    if len(outer) < 12:
        continue

    # 洞：连通域内部、且不与画面外部连通的白
    comp_inv = ~comp_mask
    # 找与该连通域外部连通的空白（用全局 mask 的外部背景近似）
    # 简化：只取被前景包围的空白块
    vis = np.zeros((H, W), dtype=bool)
    holes_found = []
    for hy, hx in zip(ys, xs):
        pass
    # 扫描所有内部空白块的边界（找洞的起点：上方是前景、下方也是前景）
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            if comp_inv[y, x] and not vis[y, x]:
                # BFS 这一块
                comp = []
                q = deque([(y, x)])
                vis[y, x] = True
                while q:
                    cy, cx = q.popleft()
                    comp.append((cy, cx))
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < H and 0 <= nx < W and comp_inv[ny, nx] and not vis[ny, nx]:
                            vis[ny, nx] = True
                            q.append((ny, nx))
                # 是否被前景包围（不接触画面边界）
                if len(comp) >= 30 and all(
                    0 < cy < H - 1 and 0 < cx < W - 1 for cy, cx in comp
                ):
                    ys2, xs2 = zip(*comp)
                    ty = min(ys2)
                    r2 = [x2 for y2, x2 in comp if y2 == ty]
                    hole = trace_one(comp_inv, ty, min(r2))
                    if len(hole) >= 10:
                        holes_found.append(hole)

    for c in [outer] + holes_found:
        s = dp(c, EPS)
        if len(s) >= 3:
            paths.append(s)

paths.sort(key=len, reverse=True)
print(f"paths = {len(paths)}  pts = {[len(p) for p in paths[:8]]}")


def to_path(c):
    return " ".join(
        [f"M{c[0][1]:.1f},{c[0][0]:.1f}"]
        + [f"L{p[1]:.1f},{p[0]:.1f}" for p in c[1:]]
        + ["Z"]
    )


path_d = " ".join(to_path(c) for c in paths)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SCALE} {SCALE}" width="{SCALE}" height="{SCALE}" fill="none">
  <title>MOIRA</title>
  <defs>
    <linearGradient id="moiraGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F7E3A1"/>
      <stop offset="42%" stop-color="#D4AF37"/>
      <stop offset="100%" stop-color="#9C7317"/>
    </linearGradient>
  </defs>
  <path d="{path_d}" fill="url(#moiraGold)" fill-rule="evenodd"/>
</svg>
'''
with open(OUT, "w", encoding="utf-8") as f:
    f.write(svg)
print(f"wrote {OUT} ({len(svg)} bytes)")
