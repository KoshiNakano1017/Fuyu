// Tailwind CSS v4 は PostCSS プラグインを専用パッケージへ分離している。
// v3 の `tailwindcss` を直接指定すると起動時にエラーになる。
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
