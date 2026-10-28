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
]);

export default eslintConfig;
