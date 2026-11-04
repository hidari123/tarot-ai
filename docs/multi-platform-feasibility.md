# 多端适配可行性（2026-11-04）

> **结论先行**：
> **H5 是唯一"改少量代码就能上线"的端**；
> **桌面端 PWA 已经 80% 完成**；
> **App 端（Capacitor）是最划算的下一步**；
> **小程序端必须重写前端，建议只做"轻壳"**。
>
> **如果只能做一件事**：做 **P0（H5 修复 + 共享层抽取，6.5 人日）**。
> 它修的是**真 bug**（不是新功能），产出物是**四端共用的地基**，
> 且完全不依赖外部审核/备案/账号。

---

## 一、现状盘点

### 1.1 PWA 做到什么程度

**manifest.json**（`public/manifest.json`）：完整 —— `display: standalone`、`orientation: portrait-primary`、
`lang: zh-CN`、icons 192/512/maskable-512 齐全。

**Service Worker**（`public/sw.js`）—— 分层策略很扎实：
- install 预缓存 6 个 URL + `skipWaiting`
- activate 清旧缓存 + `clients.claim()`
- 导航 network-first，失败回退缓存 shell
- 静态资源 stale-while-revalidate
- **API 与 SSE 永不缓存** ← 正确性关键（避免"读到上一次的占卜结果"）

**缺失能力**：

| 缺失 | 影响 |
|---|---|
| 无离线 fallback 页面 | `sw.js` 回退到首页 HTML，但首页含 8 个内联 RSC script，离线时 hydration 脚本可能拿不到 → 白屏 |
| 无 IndexedDB / 本地历史 | 离线零历史（只有 localStorage 两个 key） |
| 无 push / 通知 | HITL 等待 5 分钟，期间切走就收不到提醒 |
| 无 install prompt UI | 用户无从安装（没监听 `beforeinstallprompt`） |
| manifest 缺 `id` / `scope` / `shortcuts` | Android 桌面启动器可能"安装两次=两个图标" |
| `orientation: portrait-primary` | **桌面安装后强制竖屏窗口** ← 桌面端体验 bug |

### 1.2 PWA 能否直接当"桌面端"

**能，三项核心能力都保得住**（有代码依据）：

| 能力 | PWA 后 | 依据 |
|---|---|---|
| **SSE 长连接** | ✅ 完全可用 | PWA 只是 standalone display mode，**仍是完整 Chromium 引擎**，`fetch` + `ReadableStream` 照常工作 |
| **剪贴板** | ✅ 可用 | `navigator.clipboard` 需安全上下文（HTTPS/localhost），PWA 来源是 HTTPS → 满足；已有 `execCommand` 降级 |
| **localStorage** | ✅ 可用且**更持久** | 同源共享 |

**真实限制**：
1. 无原生托盘/菜单/快捷键/窗口控制
2. 无自动更新机制
3. `orientation: portrait-primary` → 桌面安装后强制竖屏（**必须改**）
4. iOS Safari 上 PWA 不支持 SSE 挂起（见 §2.3）
5. 无法直连本地 SQLite —— 数据全在服务端

### 1.3 `output: "standalone"` 的含义

实测产物结构：`.next/standalone/` 里**只有** `.next/ data/ node_modules/ package.json server.js`
—— **`public/` 和 `.next/static` 都不在里面**（`Test-Path ".next/standalone/public"` = False）。

⚠️ **任何容器化/桌面壳都必须手动补这两行**（`Dockerfile:73-74` 已经补了）：
```dockerfile
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
```
否则 `manifest.json` / `sw.js` / `/icons/*` / 78 张牌面图**全部 404**。

---

## 二、H5（移动浏览器）

### 2.1 🔴 三个真 bug（不是"缺功能"，是坏了）

#### ① 触摸端的"犹豫时长"永远为 0 → 移动端用户画像失效

```tsx
// src/components/CardFan.tsx:91-95
onMouseEnter={() => { hoverStart.current[card.id] = Date.now(); }}
onMouseLeave={() => { ... setDwell(...) }}
```

触摸设备**不触发 `mouseenter`/`mouseleave`**（iOS 会模拟 `mouseover` 但点击后立刻 `mouseleave`，dwell ≈ 0；
Android Chrome 多数不模拟）。

⚠️ dwell 会提交给后端（`CardFan.tsx:42`）→ **移动端用户的"犹豫时长"画像全是 0** → 占卜师个性化质量下降。

**修法**：改用 **Pointer Events**（`onPointerDown` / `onPointerUp` / `onPointerCancel`）——
它统一鼠标与触摸。**约 0.5 人日**。

#### ② `overflow-hidden` + 软键盘 → 内容被裁且无法滚动

```tsx
// src/app/page.tsx:1300
<main className="relative min-h-screen overflow-hidden flex flex-col items-center ...">
```

iOS 软键盘弹出时 **visual viewport 缩小而 layout viewport 不变** →
`<main>` 高度仍按全屏算，可见区域只有上半部分 → **被 `overflow-hidden` 裁掉的部分无法滚动查看**。

影响最大的是正文卷轴 `max-h-[50vh] overflow-y-auto`（软键盘占掉 40% 后几乎不可见）。

**修法（约 1.5 人日）**：
```css
@supports (height: 100dvh) { .min-h-screen { min-height: 100dvh; } }
html { scroll-behavior: smooth; }
body { overscroll-behavior-y: contain; }
```
并给底部输入框加 `scroll-margin-bottom: 8rem` + 监听 `visualViewport.resize`。

#### ③ SSE 无空闲超时探测 → iOS 挂起时永远卡住

```tsx
// src/app/page.tsx:603-613
const reader = res.body.getReader();
while (true) { const { done, value } = await reader.read(); ... }
```

iOS Safari 的三个硬限制：

| 限制 | 严重度 |
|---|---|
| 每域 6 个并发 HTTP/1.1 连接 | 🟡 中（SSE 占 1 个，够用，但后台 tab 会被冻结） |
| **后台挂起**（~30s 后冻结 JS 定时器与网络） | 🔴 **高** |
| SSE over HTTP/1.1 逐包 TCP 阻塞 | 🟡 中 |

**好消息**：断点续传、`Last-Event-ID`、AbortController 清理**都已经有了**。
⚠️ **但恢复只在 catch 分支触发** —— iOS 挂起时 fetch **不报错**，流只是停住，
用户盯着"占卜师正在思考…"看到天荒地老。

**修法**：`reader.read()` 加空闲超时（如 20s 无数据 → 主动 abort + resume）。**约 1 人日**。

### 2.2 布局：桌面端是"放大的手机页"

全项目只用了 `sm:` / `md:` 两档断点（13 处），**没有任何 `lg:` / `xl:` / `2xl:`**。

→ **桌面端（≥1024px）看到的是和 768px 完全相同的布局**，`max-w-4xl`（896px）封顶。
**这是"桌面端"最大的产品级缺口**，不改代码做不出桌面体验。

### 2.3 触摸交互

**✅ 可用**：翻牌（`motion.button onClick`）、选牌、所有按钮、`whileTap`、
星尘光标自动在触摸端禁用（`matchMedia("(pointer: coarse)")` —— 做得对）。

**⚠️ hover-only**：大量 `hover:` 装饰样式（触摸端无反馈，但不影响可用性）；
`title=` tooltip 触摸端长按才显示、移动 Safari 支持差（建议加 `aria-label`）。

**⚠️ 无滑动手势**：全项目无 `onTouchMove` / `drag`。翻牌是**点击**不是滑动 ——
若想要"滑动翻牌"需从零实现。

---

## 三、App 端（原生壳）

### 3.1 Capacitor（WebView 壳）—— 推荐的 App 路线

**根本性障碍**：Capacitor 打包的是**静态前端资源，不含 Node 服务端**。本项目是全栈 SSR。

**方案 A（推荐）：Capacitor + 远程 API**
1. WebView 加载**远程** `https://your-domain/`
2. 需要改：
   - **API base URL 绝对化**：现在约 10 处硬编码相对路径
     （`page.tsx:538/1083/1204/1007/553/1175`、`ShareCard.tsx:226/303`）→ 抽 `apiBase()` 常量
   - **CORS**：`next.config.ts` 已支持 `CORS_ORIGINS` 白名单，但**没有 `OPTIONS` 预检处理**
     → Capacitor 的 `capacitor://localhost` origin 必须精确加进白名单
   - **CSP `connect-src 'self'`** → **必须按 origin 放宽**，否则 WebView 连不到远程 API
   - Service Worker：Capacitor WebView 里可能不可用 → `PwaRegister.tsx` 已有保护 ✅
3. **收益**：拿到原生相机/相册/推送/分享能力

**⚠️ 工作量**：约 **4 人日**（不含原生能力开发）+ 分享/相册 2.5 + 推送 3

### 3.2 Tauri / Electron —— **都不建议**

**Tauri 的致命问题**：sidecar 要求**单个可执行文件**，但
- `better-sqlite3` 是原生 `.node` 模块 → 每平台/架构都要重编译
- `@huggingface/transformers` 含 ONNX runtime 原生绑定
  → **无法用 `pkg`/`bun build --compile` 单文件编译**
→ 必须每平台构建独立的 Node + standalone 产物 → **CI 成本极高**

且 Tauri 的 macOS 端用 WKWebView（Safari）→ **iOS 的 SSE 挂起问题在 Tauri 上 100% 会发生**。

**Electron**：与 PWA 功能重叠 80%，且引入架构问题 ——
每个用户的 Electron 都 spawn 一个 `node server.js` → **每个用户一套独立 SQLite + 独立 LLM 配额** →
**绕过了单 worker 约束，也绕过了限流保护** → 上游 429 风暴。

> **建议桌面端也做成"壳 + 远程 API"**（与 App 端架构统一，且能复用平台抽象层）。

### 3.3 🔴 分享卡在移动端是坏的

```tsx
// src/components/ShareCard.tsx:258-266
const a = document.createElement("a");
a.href = previewUrlRef.current;   // blob: URL
a.download = `mystic-tarot-...png`;
a.click();
```

UI 文案甚至写着"保存位置：浏览器默认下载文件夹（如 `C:\Users\...\Downloads`）"。

| 环境 | 能否落盘 |
|---|---|
| 桌面 Chrome/Edge | ✅ |
| 桌面 Safari | ⚠️ 基本不能（blob URL + download 支持差） |
| **iOS Safari（H5/PWA）** | 🔴 **不能**（忽略 download 属性；blob URL 长按保存也常失败） |
| Android Chrome | ⚠️ 落到 /Download，要手动再存相册 |
| **Capacitor WebView** | 🔴 不能（需原生插件） |
| 微信小程序 | 🔴 不能（需 `wx.canvasToTempFilePath`） |

**⭐ 最优解：服务端出图** —— 项目**已经有**服务端渲染分享页 HTML 的能力
（`src/app/api/share/route.ts` 的 `renderShareCard`）。加一个 `?fmt=png` 分支，
用 `satori`+`resvg-js`（纯 JS，~10MB，**不需要 headless 浏览器**）渲成 PNG →
**一次改造，四端通吃**（小程序只需 `wx.downloadFile` + `wx.saveImageToPhotosAlbum`）。

---

## 四、小程序端

### 4.1 🔴 SSE 必须重写

小程序**没有** `fetch` / `ReadableStream` / `AbortController`。
标准做法是 `wx.request({ enableChunked: true })` + `onChunkReceived`。

**好消息**：SSE 协议本身是纯文本行协议，**与传输无关**。
→ 把 `page.tsx:603-628` 的解析逻辑抽成**纯函数** `parseSseChunk(buf)`，Web 与小程序共用（**0.5 人日**）。

⚠️ 两个坑：
- `onChunkReceived` 的分片**可能在 UTF-8 多字节字符中间断开**（中文高发）→ 必须用 `TextDecoder` 的 `{stream:true}` 语义
- 小程序切后台时 `onChunkReceived` 会被暂停 → **不可能做"后台占卜"** → 回前台用 `Last-Event-ID` 补发（**后端已支持** ✅）

### 4.2 framer-motion 没有对应物

framer-motion 14 依赖 `window`/`document`/`requestAnimationFrame`/`Element.animate` → **小程序完全不支持**。

**但视觉层可以 1:1 搬进 WXSS**：
- `globals.css` 已有的 8 个 keyframes（`rune-breathe` / `spin-slow` / `twinkle` / `shimmer-text` / `cursor-blink`）→ 直接搬
- 3D 翻牌（`rotateY: 180` + `perspective`）→ WXSS 支持 ✅（小程序 WebView 就是浏览器内核）
- `whileHover`/`whileTap` → `hover-class` / `:active` ✅
- 流式打字机 → `@keyframes` ✅

### 4.3 服务端几乎不用改

**✅ 100% 可复用（服务端，零改动）**：
`src/lib/agent/*` 全部（约 350KB：supervisor / llm / subagents / ritual-machine / fallback /
tools / helpers / session / hitl / event-log）+ `rag-engine` / `vector-engine` / `db` / `schema.ts`（协议单一事实源）

**🔴 必须重写（前端）**：
`page.tsx`(76.9KB/1687 行) + `DialogueFlow.tsx`(41.9KB) + `ShareCard.tsx` + 9 个组件
→ **约 205KB / 4000 行 TSX**

### 4.4 Taro / uni-app 能不能承载

**不能"承载"，只能"重写"。**

| 目标 | 语法成本 | 组件体系成本 | framer-motion | 合计 |
|---|---|---|---|---|
| Taro（React 模式） | 低（保留 JSX） | **高**（`div/span/img` 全要换 `<View>/<Text>/<Image>`） | ❌ 无 | 25~35 人日 |
| uni-app（Vue 3） | 高 | 高 | ❌ | 35~45 人日 |
| 原生小程序 | 最高 | 最高 | ❌ | 40~55 人日 |
| **原生小程序轻壳** | — | — | — | **1.5~2.5 人日** ✅ |

### 4.5 ⭐ 推荐：原生小程序轻壳（而非 web-view 壳）

**为什么不用 `<web-view>`**：
- **必须企业主体小程序**（个人主体无此权限）→ 代码层面无法绕过
- 占满整个页面、不能与其他组件共存
- iOS 上 `<web-view>` 内的页面**无法使用 `wx.*` API**
- ⚠️ **纯 web-view 壳涉嫌"平台滥用"，审核高风险**
- ⚠️ 而且 CSP 的 `frame-ancestors 'none'` + `X-Frame-Options: DENY`（**两处**）会**双重拦截** `<web-view>` 嵌入

**轻壳做 3 件事**（有实质功能 → 审核友好）：
1. **分享卡展示 + 保存相册**（走服务端 `/api/share?fmt=png`）—— 0.5 人日
2. **每日一张牌**（`/api/draw` + 牌意数据）—— 0.5 人日
3. **引导到 H5 完整占卜** —— 0.5 人日

**绕开了小程序最贵的两块**（Canvas 分享卡 3~4 人日、SSE 客户端 2~3 人日）。

### 4.6 ⚠️ 非技术风险（比技术更该先解决）

**微信小程序对"占卜/算命/风水"类内容有明确的审核限制**
（《小程序平台运营规范》禁止封建迷信内容）。

→ 这是**平台政策风险，不是技术风险**。
→ **必须先和微信确认类目能不能过审，别先写代码。**

---

## 五、四端对比表

| 维度 | 桌面端 | App 端 | H5 | 小程序端 |
|---|---|---|---|---|
| **技术路线** | PWA（已有） | Capacitor + 远程 API | 现有 Web | 原生轻壳 |
| **代码复用度** | 95% | 90% | 98% | 轻壳 40% / 完整 10~40% |
| **工作量** | **0.5**（能装）+ 4（桌面布局）| 9.5 | **3.5** | **2**（轻壳）/ 25~60（完整）|
| **服务端改动** | 0 | CORS + CSP `connect-src` | 0 | 域名备案 |
| **SSE** | ✅ | ✅ | ⚠️ iOS 挂起 | ❌ 需重写 |
| **分享卡存相册** | ✅ | 🔴 需原生插件 | 🔴 **iOS 基本坏** | 服务端出图 ✅ |
| **推送通知** | ❌ | 🔴 需 APNs/FCM | ❌ | 🔴 模板需审核 |
| **审核/备案** | 无 | iOS $99/年 | HTTPS 即可 | 🔴 **ICP 备案 + 微信审核 + 类目确认** |
| **最大技术风险** | 缺桌面布局 | iOS WebView SSE 挂起 | iOS SSE + 软键盘 | 4000 行重写 + framer-motion 无对应物 |
| **最大商业风险** | — | 应用商店占卜类资质 | iOS 留存低 | 🔴 **占卜类内容审核极严** |

---

## 六、跨端共用改造（最高杠杆）

| # | 改造项 | 现有散落位置 | 工作量 | 服务 | H5 | 桌面 | App | 小程序 |
|---|---|---|---|---|---|---|---|---|
| ① | **平台能力抽象层**（存储/剪贴板/分享/保存/API base）| 10+ 处硬编码 | **2 人日** | — | ✅ | ✅ | ✅ | ✅ |
| ② | **SSE 帧解析器抽纯函数** | `page.tsx:603-628` | **0.5 人日** | — | ✅ | ✅ | ✅ | ✅ |
| ③ | **协议 schema 抽独立包** | `schema.ts` | **0.5 人日** | — | ✅ | ✅ | ✅ | ✅ |
| ④ | **服务端出图 `/api/share?fmt=png`** ⭐ | 扩展 share 路由 | **2~3 人日** | ✅ | ✅ | ✅ | ✅ | ✅ |
| ⑤ | **分享/保存多端降级链**（Web Share → download → 长按引导）| `ShareCard.tsx:258-266` | **1.5 人日** | — | ✅ | ✅ | ✅ | ✅ |
| ⑥ | **触屏 dwell 计时修复**（Pointer Events）| `CardFan.tsx:91-95` | **0.5 人日** | — | ✅ | ✅ | ✅ | ✅ |
| ⑦ | **软键盘/100dvh/scroll-margin** | `page.tsx:1300,1657` | **1.5 人日** | — | ✅ | ✅ | ✅ | ✅ |
| ⑧ | **SSE 空闲超时探测 + 自动 resume** | `page.tsx:603-613` | **1 人日** | — | ✅ | ✅ | ✅ | ✅ |
| ⑨ | **桌面布局断点（`lg:`/`xl:`）** | 全项目无 | **2~3 人日** | — | — | ✅ | ✅ | — |
| ⑩ | **PWA 完善**（install prompt / orientation / id / 离线 fallback）| `manifest.json` | **1 人日** | — | — | ✅ | ✅ | — |
| ⑪ | **CORS + CSP `connect-src` 按 origin 配置化** | `next.config.ts` | **1 人日** | ✅ | ✅ | ✅ | ✅ | ✅ |
| ⑫ | **API base URL 绝对化** | 10 处 | **0.5 人日** | — | — | — | ✅ | ✅ |

**①②③ 共 3 人日 → 服务四端。** 加上 ⑥⑦⑧（H5 三 bug）共 **6.5 人日**。

---

## 七、建议实施顺序

| 优先级 | 阶段 | 内容 | 累计 | 理由 |
|---|---|---|---|---|
| **P0** | **H5 三 bug 修复** | ⑦软键盘 + ⑥dwell + ⑧SSE超时 | **3.5** | **零新端、零新依赖、纯 bug 修复**。且**是所有其他端的前置** |
| **P0** | **共享层抽取** | ①平台抽象 + ②SSE解析 + ③schema | **+3** | 一次性投入，四端受益。**在 P0 里做**（P0 的修复正好要动这些代码）|
| **P1** | **分享卡跨端落盘** | ④服务端出图 + ⑤降级链 | **+4.5** | **当前移动端最严重的破损功能**（iOS 存不了图）。服务端出图顺带让小程序省 3~4 人日 |
| **P1** | **桌面端（PWA）** | ⑨⑩ | **+4** | 增量最小，但**必须补桌面布局**（现在 ≥1024px 是放大的手机页）|
| **P2** | **App 端（Capacitor）** | ①⑪⑫ + 壳 + 原生插件 | **+9.5** | ⚠️ PWA 已能满足 80%。**建议先做 APK 直装验证需求**，再决定是否上架 |
| **P3** | **小程序轻壳** | 原生页 + 服务端出图 | **+2** | 成本极低。⚠️ **先确认微信类目能否过审，别先写代码** |

### 明确不做
- ❌ **Tauri**（Safari 兼容坑不减 + better-sqlite3/ONNX 无法单文件 sidecar）
- ❌ **Electron**（与 PWA 重叠 80% + 引入"每客户端一套服务端"绕过限流保护的架构问题）
- ❌ **小程序完整重写 / Taro / uni-app**（25~60 人日，增量价值不如把 P1/P2 做扎实）
- ❌ **纯 `<web-view>` 壳**（个人主体无权限 + 纯壳审核高风险）

---

## 八、两个容易被低估的多端风险

### 8.1 单 worker 约束

`src/lib/runtime.ts` 明确写着：`globalThis` **只能解决 HMR 热重载，不能解决多进程**。

| 端 | 是否受影响 |
|---|---|
| H5 / 桌面 / App / 小程序（都连同一个服务实例）| ✅ **不受影响**（部署问题，不是代码问题）|
| **Electron 桌面端** | 🔴 每客户端一套服务端 → 绕过限流保护 → 上游 429 风暴 |

→ **建议桌面端也做成"壳 + 远程 API"**，与 App 端架构统一。

### 8.2 userKey 在多端会分裂

`src/lib/api-auth.ts` 的 `deriveUserKey()` 用 **IP + UA + 盐** 派生画像主键。

- 桌面 PWA / App / 小程序的 **UA 不同** → **同一用户在 3 个端是 3 个不同画像** → "占卜师记得你"失效
- ⚠️ 小程序请求 **UA 不可控**（固定微信标识）+ **IP 可能是运营商 NAT 出口**
  → 同一小区所有小程序用户可能撞同一个 userKey → **画像串号**

**修法**：客户端生成的 `tarot:userKey` 应成为**主键**，服务端 `deriveUserKey` 降级为兜底。
**约 1 人日，跨端共用。**

---

## 附：方法论说明

本报告的所有结论都基于**实际代码探测**（读文件 + 实际构建 + `Test-Path` 验证产物结构），
而非"看框架文档猜"。涉及人日的估算是基于**改动点数量与复杂度**的工程判断，
不是精确承诺。
