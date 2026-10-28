#!/usr/bin/env python
"""方向⑥：生成 PWA 图标（从 favicon 放大 + 紫色星尘背景）"""
from PIL import Image, ImageDraw, ImageFilter
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(OUT, exist_ok=True)

def make_icon(size, maskable=False, path=""):
    # 星尘紫背景（与站内 #0b0514 / #160b26 一致）
    if maskable:
        # maskable：内容收缩到安全区（外圈 20% 留白），防系统裁切
        bg = Image.new("RGBA", (size, size), (11, 5, 20, 255))
        pad = int(size * 0.18)
        content_size = size - pad * 2
    else:
        bg = Image.new("RGBA", (size, size), (11, 5, 20, 255))
        pad = int(size * 0.10)
        content_size = size - pad * 2

    d = ImageDraw.Draw(bg)

    # 圆角边框（呼应卡牌 glow-border）
    margin = int(size * 0.04) if not maskable else int(size * 0.08)
    radius = int(size * 0.18)
    d.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        outline=(139, 92, 246, 230),
        width=max(2, size // 48),
    )

    # 中心八角星（占卜 ✦ 符号意象）
    cx, cy = size // 2, size // 2
    r_outer = int(content_size * 0.34)
    r_inner = int(r_outer * 0.38)
    points = []
    import math
    for i in range(16):
        ang = math.pi * i / 8 - math.pi / 2
        r = r_outer if i % 2 == 0 else r_inner
        points.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    d.polygon(points, fill=(196, 165, 250, 255), outline=(139, 92, 246, 255))

    # 内核小圆
    d.ellipse(
        [cx - r_inner * 0.4, cy - r_inner * 0.4, cx + r_inner * 0.4, cy + r_inner * 0.4],
        fill=(255, 244, 220, 255),
    )

    # 星尘点缀（固定伪随机位置，避免每次生成不一致）
    import random
    random.seed(42)
    for _ in range(14):
        x = random.randint(margin + 4, size - margin - 4)
        y = random.randint(margin + 4, size - margin - 4)
        if (x - cx) ** 2 + (y - cy) ** 2 < (r_outer + size // 12) ** 2:
            continue
        s = random.randint(1, max(2, size // 128))
        a = random.randint(90, 200)
        d.ellipse([x - s, y - s, x + s, y + s], fill=(196, 165, 250, a))

    return bg

# 常规图标
make_icon(192).save(os.path.join(OUT, "icon-192.png"))
make_icon(512).save(os.path.join(OUT, "icon-512.png"))
# maskable（安全区版）
make_icon(512, maskable=True).save(os.path.join(OUT, "icon-maskable-512.png"))
# favicon 用 64
make_icon(64).save(os.path.join(OUT, "icon-64.png"))

print("icons generated:", os.listdir(OUT))
