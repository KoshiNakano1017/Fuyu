import nextJest from "next/jest.js";

// next/jest プリセットを使う。CI/pre-commit が --passWithNoTests や
// --findRelatedTests という Jest ネイティブのフラグ前提で組まれているため（CLAUDE.md §6.1/§6.2）
const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  // e2e/ は Playwright の実行対象であり Jest では走らせない。除外は testPathIgnorePatterns
  // の正規表現ではなく roots の限定で行う。正規表現/glob は Windows のバックスラッシュ
  // 区切りパスに一致せず、e2e の素通りや「No tests found」を招くため
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  // `@/` の別名は、静的 import であれば SWC が tsconfig の paths を見て解決する。
  // ただし `require("@/...")` のような**実行時**の解決は SWC を通らず、Jest のリゾルバへ落ちる。
  // next/jest は tsconfig の paths から moduleNameMapper を作らないため、ここで補う
  // （補わないと「未設定でも import 自体は落ちない」ことを require で確かめるテストが
  //   モジュール解決の失敗で落ち、実装の当否と無関係な理由で赤くなる）
  moduleNameMapper: { "^@/(.*)$": "<rootDir>/src/$1" },
};

export default createJestConfig(config);
