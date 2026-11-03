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
]);

export default eslintConfig;
