# scripts/dev/ —— 临时诊断工具（不参与 CI，无回归契约）

## 为什么单独放一个目录

`scripts/` 根目录下的脚本分两类，**职责完全不同**：

| 目录 | 脚本性质 | 契约 |
|---|---|---|
| `scripts/` | `verify-*` / `eval-*` / `chaos-test` —— **回归验证器** | 有断言、有退出码、CI 会跑；坏了必须报警 |
| `scripts/dev/` | `debug-*` / `inspect-*` / `check-*` / `diagnose-*` —— **一次性排查工具** | 无断言、只看输出；用完即弃 |

把两类混在一起的问题是：看到 `scripts/` 有 42 个文件，新人分不清"哪些是测试、哪些是垃圾"。
（2026-11 的一次真实教训：排查 eval 全军覆没时，临时写了 16 个诊断脚本，
全留在根目录，污染了仓库结构。）

## 脚本清单

### 排查 HITL / 流程卡死
| 脚本 | 用途 |
|---|---|
| `diagnose-hitl.mjs` | 起一场真实占卜，逐个 HITL 闸门应答，**打印每次应答的 HTTP 状态** —— 定位"应答被 409 丢弃"类问题 |
| `diagnose-stuck.mjs` | 从 SQLite 反查最近会话的事件序列 + 阶段耗时 —— 定位"卡在哪一步" |
| `inspect-flow.mjs` | 打印最近会话的仪式事件（承约/呼召/选牌/翻牌/讲牌）覆盖情况 |
| `inspect-detail.mjs` | 打印**单个**会话的逐条事件详情（seq / type / label / 摘要） |
| `inspect-latest.mjs` | 最近 N 个会话的状态 + 事件类型序列 + 错误分布 |
| `inspect-zombies.mjs` | 列出 running 状态的会话及其快照 lastActive —— 排查"僵尸会话占资源" |

### 排查 LLM / 配额
| 脚本 | 用途 |
|---|---|
| `check-llm-fails.mjs` | 按 agent 统计 LLM 调用成功率与失败明细 —— 定位"reviewer 失败率 75%"这类问题 |
| `check-running.mjs` | 统计 running 会话数与年龄 |
| `check-progress.mjs` | 批量跑评估时的进度速览（近 5 分钟新增会话） |
| `check-errors.mjs` | 近期 error_reason 分类统计 |

### 原始流调试
| 脚本 | 用途 |
|---|---|
| `debug-sse.mjs` | 打印原始 SSE 帧（含 `id:` 字段）与到达间隔 —— 验证 SSE 协议 |
| `debug-quick.mjs` | 快速起一场占卜，打印前几个事件后停止（诊断用） |
| `debug-ask.mjs` / `debug-ask.cjs` | 只看 ask_user 交互（问什么、应答什么） |
| `debug-ritual.mjs` | 逐条打印仪式流程事件 |

### 一次性修复工具
| 脚本 | 用途 |
|---|---|
| `fix-sse-parsing.mjs` | 批量把验证脚本的 SSE 单行解析改成多行帧解析（P1-③D 加 `id:` 字段后的一次性迁移） |

## 使用约定

1. **用完即弃**：诊断完如果结论已写进代码注释，脚本可以删
2. **不写死数据路径**：统一用相对路径 `data/tarot.db`，别硬编码绝对路径
3. **不做断言**：这些脚本只输出信息，退出码恒为 0 —— 需要断言请写 `verify-*`
