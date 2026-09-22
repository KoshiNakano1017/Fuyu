/**
 * アプリの公開 URL を1箇所で決める。
 *
 * **招待メールに載せるログイン画面の URL がここから来る**（v13 §5.2.6 経路B 手順2）。
 * 誤った URL を載せると、招待された会員はログイン画面へ到達できない。
 * 送達手段からリンクを外した（決定ログ §22-1）あとに残った**唯一の URL** であり、
 * ここだけは正しさが要る。
 *
 * ## 優先順
 *
 * 1. `NEXT_PUBLIC_APP_URL` — 明示的な設定。独自ドメインを当てたらここへ入れる
 * 2. `VERCEL_PROJECT_PRODUCTION_URL` — Vercel が本番ドメインを自動で入れる変数。
 *    公開ドメインは Vercel 既定（`*.vercel.app`）で確定しているため（決定ログ §20-2）、
 *    通常はこれで足りる。**`VERCEL_URL` は使わない**（デプロイ毎に変わる一意URLであり、
 *    Preview のURLが招待メールへ載ると会員が古い環境へ誘導される）
 * 3. ローカル開発の既定値
 */
const LOCAL_DEVELOPMENT_URL = "http://localhost:3000";

export function readAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured !== undefined && configured !== "") {
    return configured.replace(/\/$/, "");
  }

  const vercelProductionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProductionHost !== undefined && vercelProductionHost !== "") {
    return `https://${vercelProductionHost}`;
  }

  return LOCAL_DEVELOPMENT_URL;
}

/** ログイン画面の URL。招待メールの案内に載せる。 */
export function readLoginUrl(): string {
  return `${readAppUrl()}/login`;
}
