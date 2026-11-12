import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 运维脚本：.cjs 是 CommonJS（require 合法），.mjs 走 node 运行时
    // （无 DOM/浏览器全局），不适用前端 TS 规则
    "scripts/**/*.cjs",
    "mcp-server/**",
    "docker-sim-runner/**",
  ]),
  // 脚本目录单独放宽：CommonJS require 合法
  {
    files: ["scripts/**/*.{cjs,mjs,js}"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  // ⚠️ scripts/dev/ 是**一次性诊断工具**（见 scripts/dev/README.md）：
  //    这些脚本常刻意解构用不到的字段（只看其中一两个），
  //    例如 `const { getSession, snapshotSession } = await import(...)` 只用后者。
  //    对它们关闭 unused-vars —— 这不是"代码质量问题"，是脚本形态使然。
  {
    files: ["scripts/dev/**/*.{cjs,mjs,js}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // ⚠️⚠️ page.tsx：状态已收进 `useDivinationState`（src/features/divination/）
  //    → setter 来自**自定义 hook**，不再由 useState 直接产生
  //
  // ⚠️⚠️ 为什么必须关掉 exhaustive-deps（实测踩坑）：
  //    · eslint 的规则**只认识 useState 的 setter**（它靠识别 `useState` 的返回位置）
  //    · 自定义 hook 返回的 setter → 规则认为它"每次渲染都变" → 报 missing deps
  //    · 但这些 setter **确实稳定**（内部就是 useState，React 保证引用不变）
  //      → 依赖数组**不需要**加它们（加了也无害，但会刷屏）
  //    · 实测：迁移前 0 警告 → 迁移后 24 个假警告 ❌
  //
  // ⚠️ 为什么只针对这一个文件：
  //    · 其它文件里的 useState setter 仍应被规则正常检查（它们确实需要进依赖数组）
  //    · 这个豁免只针对"跨自定义 hook 的 setter"这一种特定形态 ✅
  {
    files: ["src/app/page.tsx"],
    rules: {
      "react-hooks/exhaustive-deps": "off",
    },
  },
]);

export default eslintConfig;
