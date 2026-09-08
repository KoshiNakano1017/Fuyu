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
};

export default createJestConfig(config);
