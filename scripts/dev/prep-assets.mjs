#!/usr/bin/env node
/**
 * AI 素材后处理（2026-11-06 重写）
 *
 * ⚠️ 为什么需要这一步：
 *   MiniMax image-01 的输出有几个"不能直接用"的问题：
 *     ① 牌背图带**白边**（模型把牌画在白底上）→ 必须裁掉
 *     ② 主体图（水晶球/神谕之眼）带**黑底或深蓝底** → 必须变透明
 *     ③ JPEG 有块状伪影 + 体积大 → 转 WebP
 *     ④ 尺寸固定 1024² → 我们只需要 128~820px（省流量）
 *
 * ⚠️ 为什么用 sharp 而不是 PS：
 *   这些都是**确定性的批量处理**（裁切 / 缩放 / 转码），
 *   sharp 更快、可写进 CI、无需人工操作。
 *   PS 留给"需要人眼判断的调色"（用户手动做的事）。
 *
 * ⚠️ 两种抠底方式（各有用武之地，别混用）：
 *   · luminanceAlpha —— 按亮度映射 alpha。适合"深底 + 亮主体"。
 *     ⚠️ 必须**在缩放之前**做：缩放会插值淡化细线，亮度掉到阈值下就丢了。
 *   · cropToContent —— 按亮像素包围盒裁掉四周空白。
 *
 * 用法：node scripts/dev/prep-assets.mjs
 */

import sharp from "sharp";
import { mkdirSync, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const SRC = "shots/gen";
const OUT = "public/images/celestial";

if (!existsSync(SRC)) {
  console.error(`✗ 找不到素材目录 ${SRC}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

/**
 * 处理清单
 * ⚠️ 每项的参数都是**人工调过的**（看生成结果决定的），不是通用值。
 */
const TASKS = [
  /* ========== 背景 ========== */
  /**
   * 三张页面背景
   * ⚠️ 为什么 resize 到 1920 宽（比原图 1280 大）：
   *   CSS background-size:cover 会把 1280 拉伸到 1920+ → 轻微发虚。
   *   放大到 1920 让它有 1.5x 余量（retina 屏 @2x 才不虚）。
   */
  { src: "bg_home.jpg", out: "bg-home.webp", width: 1920, quality: 72 },
  { src: "bg_fortune.jpg", out: "bg-fortune.webp", width: 1920, quality: 72 },
  { src: "bg_oracle.jpg", out: "bg-oracle.webp", width: 1920, quality: 72 },
  /** 移动端小图（手机流量敏感，1920 纯属浪费） */
  { src: "bg_home.jpg", out: "bg-home-sm.webp", width: 640, quality: 66 },
  /** 每日之牌页背景（暖紫调） */
  { src: "bg_daily.jpg", out: "bg-daily.webp", width: 1920, quality: 72 },

  /* ========== 主体素材（需要抠底） ========== */

  /**
   * 水晶球（手捧式 · 2026-11-06）
   * ⚠️ 用户参考图：紫发神谕师手捧水晶球
   *   要求："手在下面拖着、不要太写实、透明底"。
   *
   * ⚠️ 为什么用**亮度转 alpha**（而不是径向遮罩）：
   *   这张图的主体（手 + 球）铺满画面，外围才是背景
   *   → 径向遮罩会把手的边缘切掉。
   *   → 亮度转 alpha：背景（深蓝，亮度 0~31）→ 透明；
   *     手（浅粉，亮度 160~220）与球（紫白）完整保留。
   * ⚠️ 实测亮度分布（1024² 采样）：
   *   0~31 占 72%（背景）、32~63 占 12%、128+ 占 24%（手与球）
   *   → 阈值 34：背景全透明，主体完整。
   *
   * ⚠️⚠️ 为什么**不能**用 cropToContent：
   *   这张图的手**超出画面底部**（包围盒一直顶到 y=1023）
   *   → 裁剪会把手截断，再正方形化 → 主体变形（截图实测：变成条纹矩形）。
   *   → 保持原始比例，只抠底色即可。
   */
  {
    src: "orb_hands.jpg",
    out: "orb-crystal.webp",
    width: 820,
    quality: 82,
    luminanceAlpha: { threshold: 34 },
  },

  /**
   * 神谕之眼（2026-11-06）
   * ⚠️ 用户要求："透明底 + 眨眼"。
   * ⚠️ 为什么用亮度转 alpha 而不是径向遮罩：
   *   这张图的金色光芒**延伸到画面边缘** → 径向遮罩会把光芒切断。
   *   → 背景（深蓝）→ 透明；金色光芒与虹膜（亮度 140+）→ 保留。
   * ⚠️ 为什么**不能**用 cropToContent：
   *   光芒顶到画面边缘 → 裁剪会切掉光芒尖端（正方形化还会变形）。
   *   → 保持原始比例。
   */
  {
    src: "oracle_eye2.jpg",
    out: "oracle-eye.webp",
    width: 620,
    quality: 82,
    luminanceAlpha: { threshold: 34 },
  },

  /**
   * 三个入口图标
   * ⚠️ 用户反馈（第二轮）："今日之牌的图标外面还有白色的底色 / 还是有四个边角"。
   * ⚠️ 根因（实测采样）：
   *   icon_daily 的**四角是米白色**（亮度 250+），
   *   而模型把图标画在**黑圆**里 → 图 = 黑圆 + 米白方块背景。
   *   → 亮度阈值分不开"米白底"和"金色线"（米白比金线还亮）。
   * ⚠️ 解法：**边缘连通抠底**（cornerFlood）
   *   从四个角出发，只把**与角连通的高亮区域**判为背景。
   *   → 米白底与四角连通 → 被抠掉
   *   → 金色线被黑圆包围，与角不连通 → 完整保留
   *   ⚠️ 为什么不用"亮度阈值"：
   *   米白(250) 比金线(200) 还亮 → 任何阈值都会把两者一起留下或一起删。
   *   → 必须用**连通性**而不是亮度来区分。
   */
  {
    src: "icon_daily.jpg",
    out: "icon-daily.webp",
    width: 128,
    quality: 92,
    /** 边缘连通抠底：高于此亮度的、与四角连通的像素 = 背景 */
    cornerFlood: { threshold: 90 },
    luminanceAlpha: { threshold: 52, boost: 0.35, tint: { from: [138, 106, 30], to: [246, 224, 160] } },
    cropToContent: { threshold: 80 },
  },
  {
    src: "icon_fortune.jpg",
    out: "icon-fortune.webp",
    width: 128,
    quality: 92,
    luminanceAlpha: { threshold: 52, boost: 0.35, tint: { from: [138, 106, 30], to: [246, 224, 160] } },
    cropToContent: { threshold: 80 },
  },
  {
    src: "icon_oracle.jpg",
    out: "icon-oracle.webp",
    width: 128,
    quality: 92,
    luminanceAlpha: { threshold: 52, boost: 0.35, tint: { from: [138, 106, 30], to: [246, 224, 160] } },
    cropToContent: { threshold: 80 },
  },

  /* ========== 装饰素材 ========== */

  /**
   * 魔法阵
   * ⚠️ 为什么用 **PNG8（量化调色板）** 而不是 PNG24 / WebP：
   *   · PNG24 + alpha = 283 KB（alpha 通道无损存储）
   *   · WebP + alpha = 250 KB（alpha 同样基本无损）
   *   · **PNG8 量化到 32 色调色板** → 约 140 KB
   *     金色线条的颜色数很少（本来就只有金→黑这一个色相），量化几乎无损。
   * ⚠️ 底色是**深蓝黑**（不是纯黑）→ 不能简单判黑，
   *   否则会留下一整块深蓝圆盘挡住星云。
   */
  {
    src: "magic_circle.jpg",
    out: "magic-circle.png",
    width: 760,
    png: true,
    luminanceAlpha: { threshold: 58 },
    colors: 32,
  },

  /**
   * 牌背
   * ⚠️ 为什么需要裁白边：模型把牌画在**白底**上（左右和上下都有白边）。
   */
  {
    src: "card_back.jpg",
    out: "card-back.webp",
    width: 480,
    quality: 82,
    trim: { threshold: 12 },
  },

  /**
   * 开始占卜按钮 —— 两张配套图（普通态 / hover 发光态）
   * ⚠️ 用户要求："开始占卜那个按钮还是要图片，不要 css 的边框了，
   *   图片可以设计成两个，一个普通的，一个 hover 上去发光"。
   *
   * ⚠️ 为什么文案**不烧进图片**：
   *   · 位图文字在高分屏/缩放下会糊
   *   · 无法被屏幕阅读器朗读（无障碍）
   *   · 字体与全站不统一（我们用马善政楷书）
   *   → 图片只提供**纹样**，文字用 HTML 叠在中间。
   *
   * ⚠️⚠️ 为什么必须用 **cornerFlood**（边缘连通抠底）：
   *   这两张图的**中心是深蓝底**（不是纯黑），亮度 30~60；
   *   而金色框线亮度 120~250。
   *   → 单纯亮度阈值分不开（阈值高了框线还在但底也还在）。
   *   → 但**中心深蓝底不与边缘连通**（被金框围住），
   *     而**外围纯黑**与边缘连通。
   *   → 先用 cornerFlood 抠掉外围黑，再用 luminanceAlpha 把中心深蓝也变透明。
   *
   * ⚠️ 为什么两张图都用 square:false（保持宽扁比例）：
   *   按钮约 3:1，正方形化会把框线拉成方的。
   *
   * ⚠️⚠️ 为什么**不裁剪**（cropToContent 省略）：
   *   AI 画的框线只有 2~3px 宽（1280px 原图上），
   *   裁到最小包围盒再缩到 720 → 框线只剩 1px → alpha 稀薄 → 看起来"很淡"
   *   （实测：实心像素只有 147 个）。
   *   → 保留完整画面（不裁）→ 缩放后框线虽细但**连续可见**，
   *     而且外围的黑会被 cornerFlood 抠掉。
   */
  {
    src: "btn_normal.jpg",
    out: "btn-normal.webp",
    width: 720,
    quality: 88,
    cornerFlood: { threshold: 95 },
    luminanceAlpha: {
      threshold: 38,
      boost: 0.5,
      tint: { from: [150, 116, 36], to: [250, 232, 176] },
    },
    /**
     * ⚠️ 必须裁掉上下空白：
     *   AI 出的图是 16:9，但框只占中间一条 → 按钮是 3:1，
     *   object-cover 裁掉左右但**上下大片留白** → 框缩在中间一小块（截图实测）。
     *   → 裁到框的包围盒 → 图片变成 3:1 的框 → 正好贴合按钮。
     * ⚠️ square:false：框是宽扁的，正方形化会拉变形。
     */
    cropToContent: { threshold: 62, square: false },
  },
  {
    src: "btn_hover.jpg",
    out: "btn-hover.webp",
    width: 720,
    quality: 88,
    cornerFlood: { threshold: 95 },
    luminanceAlpha: {
      threshold: 38,
      boost: 0.38,
      tint: { from: [176, 136, 44], to: [255, 246, 208] },
    },
    cropToContent: { threshold: 62, square: false },
  },

  /** 分享卡背景（竖版） */
  {
    src: "share_bg.jpg",
    out: "share-bg.webp",
    width: 720,
    quality: 80,
    trim: { threshold: 14 },
  },

  /** 空状态 / 加载态插画 */
  { src: "empty_state.jpg", out: "empty-state.webp", width: 480, quality: 82 },
  { src: "loading_state.jpg", out: "loading-state.webp", width: 480, quality: 82 },

  /* ========== 占卜师头像（圆形遮罩） ========== */
  { src: "p_moon.jpg", out: "persona-moon.webp", width: 256, quality: 84, circle: true },
  { src: "p_heart.jpg", out: "persona-heart.webp", width: 256, quality: 84, circle: true },
  { src: "p_quill.jpg", out: "persona-quill.webp", width: 256, quality: 84, circle: true },
  { src: "p_compass.jpg", out: "persona-compass.webp", width: 256, quality: 84, circle: true },
  { src: "p_druid.jpg", out: "persona-druid.webp", width: 256, quality: 84, circle: true },
];

for (const t of TASKS) {
  const srcPath = join(SRC, t.src);
  if (!existsSync(srcPath)) {
    console.warn(`⚠ 跳过（源文件不存在）: ${t.src}`);
    continue;
  }

  let img = sharp(srcPath);

  // ① 自动裁掉白边
  if (t.trim) {
    img = img.trim({ threshold: t.trim.threshold, background: "#ffffff" });
  }

  // ② 取原始像素（后续操作都在这份 raw 上做，全程不丢 alpha 通道）
  let rawData = null;
  let rawInfo = null;
  if (t.cropToContent || t.luminanceAlpha || t.cornerFlood) {
    const r = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    rawData = Buffer.from(r.data);
    rawInfo = r.info;
  }

  /**
   * ②.5 边缘连通抠底（cornerFlood）
   *
   * ⚠️⚠️ 为什么需要这个（用户反馈"今日之牌图标还有四个边角"）：
   *   icon_daily 的构图是「黑圆 + 米白方块背景」——
   *   模型的 prompt 里写了 "on pure black background"，但它同时画了个黑圆，
   *   圆外是**米白色**（亮度 250+，比金线还亮）。
   *   → 任何**亮度阈值**都分不开"米白底"和"金色线"。
   *
   * ⚠️ 解法：**连通性**而非亮度：
   *   从图像四个角出发做 flood fill，
   *   只把**与角连通且亮度 > 阈值**的像素标为"背景"。
   *   → 米白底与四角连通 → 被抠掉
   *   → 金色线被黑圆包住，与角不连通 → 完整保留
   *
   * ⚠️ 为什么是 4 邻域（不是 8 邻域）：
   *   8 邻域会沿对角线"漏"进黑圆里的缝隙 → 误伤图形。
   *   4 邻域更保守。
   */
  if (t.cornerFlood && rawData && rawInfo) {
    const th = t.cornerFlood.threshold ?? 90;
    const W = rawInfo.width;
    const H = rawInfo.height;
    const CH = rawInfo.channels;
    /** 背景标记（1 = 背景） */
    const isBg = new Uint8Array(W * H);
    /** 待处理队列（用数组模拟栈，避免大图内存爆） */
    const stack = [];
    const pushIf = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const p = y * W + x;
      if (isBg[p]) return;
      const i = p * CH;
      const lum = 0.299 * rawData[i] + 0.587 * rawData[i + 1] + 0.114 * rawData[i + 2];
      if (lum <= th) return; // 暗像素 → 不是背景（是黑圆或图形）
      isBg[p] = 1;
      stack.push(p);
    };
    // 四个角作为种子
    pushIf(0, 0);
    pushIf(W - 1, 0);
    pushIf(0, H - 1);
    pushIf(W - 1, H - 1);
    // 边缘也作为种子（米白底常常从边缘渗进来）
    for (let x = 0; x < W; x++) {
      pushIf(x, 0);
      pushIf(x, H - 1);
    }
    for (let y = 0; y < H; y++) {
      pushIf(0, y);
      pushIf(W - 1, y);
    }
    // BFS
    while (stack.length > 0) {
      const p = stack.pop();
      const x = p % W;
      const y = (p / W) | 0;
      pushIf(x + 1, y);
      pushIf(x - 1, y);
      pushIf(x, y + 1);
      pushIf(x, y - 1);
    }
    // 标记出来的背景像素 → 直接把 RGB 压到 0（后续 luminanceAlpha 会判为全透明）
    for (let p = 0; p < isBg.length; p++) {
      if (!isBg[p]) continue;
      const i = p * CH;
      rawData[i] = 0;
      rawData[i + 1] = 0;
      rawData[i + 2] = 0;
    }
  }

  // ③ 按亮像素包围盒裁掉四周空白（必须在缩放之前 —— 坐标系问题）
  if (t.cropToContent && rawData && rawInfo) {
    const th = t.cropToContent.threshold ?? 45;
    /**
     * ⚠️⚠️ 为什么必须**忽略边缘一圈**：
     *   AI 图的四角有 JPEG 噪点/渐变（亮度可能 > 阈值）
     *   → 包围盒从 (0,0) 开始 → 裁剪等于没裁
     *   → 整张 1024² 的图被压到 128px → 图案变成"横条"（截图实测）。
     *   → 只统计**中心 80% 区域**内的亮像素 → 包围盒才是真主体。
     */
    const edge = Math.floor(Math.min(rawInfo.width, rawInfo.height) * 0.1);
    let minX = rawInfo.width;
    let minY = rawInfo.height;
    let maxX = 0;
    let maxY = 0;
    for (let y = edge; y < rawInfo.height - edge; y++) {
      for (let x = edge; x < rawInfo.width - edge; x++) {
        const i = (y * rawInfo.width + x) * rawInfo.channels;
        const lum = 0.299 * rawData[i] + 0.587 * rawData[i + 1] + 0.114 * rawData[i + 2];
        if (lum > th) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX > minX && maxY > minY) {
      const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04);
      const left = Math.max(0, minX - pad);
      const top = Math.max(0, minY - pad);
      const w = Math.min(rawInfo.width - left, maxX - minX + pad * 2);
      const h = Math.min(rawInfo.height - top, maxY - minY + pad * 2);
      /**
       * ⚠️⚠️ 为什么用 **sharp.extract()** 而不是手工 Buffer.copy：
       *   手工拷贝 raw 像素时，**行跨度与缓冲区长度极易不同步**
       *   （裁剪后 rawInfo.width 变了，但后面 luminanceAlpha 又按新宽度步进）
       *   → 像素错位 → 输出变成"横条纹"（截图实测，三个图标全废）。
       *   → 改用 sharp 自己的 extract（它保证像素与尺寸一致）：
       *     1) 把 raw 重新包回 sharp
       *     2) extract 裁剪区域
       *     3) 若要正方形，用 extend 补透明边
       */
      let pipeline = sharp(rawData, {
        raw: { width: rawInfo.width, height: rawInfo.height, channels: rawInfo.channels },
      }).extract({ left, top, width: w, height: h });

      /**
       * 做成正方形（图标要放进圆形容器）
       * ⚠️ 为什么要有 square 这个开关：
       *   宽扁的图（3:1 的按钮框线）正方形化会把框线拉成方的。
       *   → 只有"放进圆形容器"的图标才需要正方形化。
       */
      if (t.cropToContent.square !== false) {
        const side = Math.max(w, h);
        const offX = Math.floor((side - w) / 2);
        const offY = Math.floor((side - h) / 2);
        /**
         * ⚠️⚠️⚠️ 关键：extend 后必须**显式指定 png 格式**再 toBuffer。
         *   ⚠️ 为什么：
         *   pipeline 的输入是 **raw**（无尺寸元数据）→ toBuffer() 默认输出 raw
         *   → 得到的 buffer 不含宽高信息
         *   → `sharp(buffer)` 无法推断尺寸 → 后续 resize/输出全是乱码
         *   → **输出变成横条纹**（截图实测，三个图标全废）。
         *   → 指定 `.png()` 后 buffer 自带尺寸 → 下游一切正常。
         */
        pipeline = sharp(
          await pipeline
            .extend({
              top: offY,
              bottom: side - h - offY,
              left: offX,
              right: side - w - offX,
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .png()
            .toBuffer()
        );
      }

      // 重新取 raw（尺寸已变）→ 后续 luminanceAlpha 用新尺寸
      const r2 = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      rawData = Buffer.from(r2.data);
      rawInfo = r2.info;
      /**
       * ⚠️⚠️⚠️ 关键：**必须把裁剪结果写回 img**。
       *   漏了这一步 → img 仍是**原始未裁剪**的实例
       *   → 后面 `img.resize(width)` 缩放的是整张 1024² 图
       *   → 主体（占中间一小块）被压成几像素 → **输出是横条纹**（截图实测）。
       */
      img = sharp(rawData, {
        raw: { width: rawInfo.width, height: rawInfo.height, channels: rawInfo.channels },
      });
    }
  }

  // ④ 按亮度转 alpha（必须在缩放之前 —— 缩放会插值淡化细线）
  if (t.luminanceAlpha && rawData && rawInfo) {
    const th = t.luminanceAlpha.threshold;
    /**
     * ⚠️⚠️ 为什么需要 boost（gamma）：
     *   线性映射下，亮度刚过阈值的像素 → alpha 只有 2~5% → 几乎看不见。
     *   实测：按钮底纹（阈值 60）出来后只剩"噪点"，
     *   因为金色框线有大量中间调（64~127）全被压成不可见。
     *   → boost < 1 = 提亮中间调（gamma 校正）。
     *   ⚠️ boost=1 是线性（图标用这个，保持细腻）；
     *      boost=0.45 用于按钮（框线要"实"）。
     */
    const boost = t.luminanceAlpha.boost ?? 1;
    /**
     * ⚠️⚠️ 为什么还要"金色通道"过滤（warmOnly）：
     *   实测：按钮底纹抠完变成"噪点" —— 因为 AI 图的**中间是深蓝底**
     *   （亮度 30~50，接近阈值 55），抠完残留成一片蓝灰杂点。
     *   → 光靠亮度分不开"深蓝底"和"暗金框线"。
     *   → 用**色相**分：金色满足 R > B（暖色），深蓝满足 B > R。
     *     只保留 R ≥ B 的像素 → 深蓝底全透明，暗金框线完整。
     * ⚠️ 为什么用 R≥B 而不是更严格的色相角：
     *   金框在暗部时色相不稳定（接近灰），
     *   严格的色相角会把暗金也误杀 → 用简单可解释的 R≥B 最稳。
     */
    const warmOnly = t.luminanceAlpha.warmOnly ?? false;
    /**
     * ⚠️⚠️ 为什么要有 **tint（金色统一）**：
     *   抠完底之后，像素虽然 alpha 正确了，但**颜色还是原图的暗金色**
     *   （JPEG 压缩过的、带蓝调的暗金）→ 叠在深紫底上显得**灰暗发脏**。
     *   实测：三个入口图标抠完后是"灰色的一团"，不是金色（用户反馈"图标不明显"）。
     *   → 用原像素的**明度**去驱动一个**统一的金色渐变**：
     *     暗部 = 深金 #8a6a1e → 亮部 = 亮金 #f6e0a0
     *   → 既有明暗层次，又是纯金色系。
     */
    const tint = t.luminanceAlpha.tint;
    for (let i = 0; i < rawData.length; i += rawInfo.channels) {
      const r = rawData[i];
      const b = rawData[i + 2];
      const lum = 0.299 * r + 0.587 * rawData[i + 1] + 0.114 * b;
      let norm = lum <= th ? 0 : (lum - th) / (255 - th);
      if (norm > 0 && boost !== 1) norm = Math.pow(norm, boost);
      // 冷色像素（R < B）直接判为背景
      if (warmOnly && r < b) norm = 0;
      if (tint) {
        /**
         * ⚠️⚠️ 为什么用 **归一化亮度**而不是原始 lum：
         *   用 lum/255 → 原图亮度 100~180 的框线只映射到 39%~70% 的暗金
         *   → 抠出来的框线**太淡**（截图实测：几乎看不见）。
         *   → 改成扣除阈值后的归一化值 → 框线两端都能到亮金。
         */
        const lum01 = Math.min(1, Math.max(0, (lum - th) / (255 - th)));
        const [r0, g0, b0] = tint.from;
        const [r1, g1, b1] = tint.to;
        rawData[i] = Math.round(r0 + (r1 - r0) * lum01);
        rawData[i + 1] = Math.round(g0 + (g1 - g0) * lum01);
        rawData[i + 2] = Math.round(b0 + (b1 - b0) * lum01);
      }
      rawData[i + rawInfo.channels - 1] = Math.round(norm * 255);
    }
    img = sharp(rawData, {
      raw: { width: rawInfo.width, height: rawInfo.height, channels: rawInfo.channels },
    });
  }

  // ⑤ 缩放到目标尺寸
  img = img.resize({ width: t.width, withoutEnlargement: false, fit: "inside" });

  // ⑥ 圆形遮罩（头像）
  if (t.circle) {
    const size = t.width;
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`
    );
    img = sharp(
      await img.resize(size, size, { fit: "cover", position: "top" }).toBuffer()
    ).composite([{ input: mask, blend: "dest-in" }]);
  }

  // ⑦ 输出
  const outPath = join(OUT, t.out);
  if (t.png) {
    await img
      .png({
        compressionLevel: 9,
        palette: true,
        ...(t.colors ? { colors: t.colors } : {}),
      })
      .toFile(outPath);
  } else {
    await img.webp({ quality: t.quality ?? 80, effort: 6 }).toFile(outPath);
  }

  const { size: bytes } = await stat(outPath);
  console.log(`✓ ${outPath}  (${Math.round(bytes / 1024)} KB)`);
}
