/**
 * Server Action の送信結果の共通形。
 *
 * 画面をまたいで使い回すコンポーネント（`MenuBoard` はセルフ注文と代理注文の
 * 両方から使われる）へ Action を渡すには、双方の戻り値が**同じ型**である必要がある。
 * 画面ごとに `status` の語を変える（`placed` / `saved` / `sent`）と、
 * 共通コンポーネントが受け取れなくなる。
 *
 * ⚠️ **`message` に内部の識別子や DB のエラー文をそのまま入れない**（CLAUDE.md §3.2）。
 * ここへ入れてよいのは、利用者がそのまま読んで行動できる文言だけである。
 *
 * 既存の `LoginState` / `MinutesFormState` を作り直していないのは、
 * それらが共通コンポーネントを介さず1画面で閉じているためである。
 * 新しく共有する画面からはこちらを使う。
 */
export type SubmitState = { status: "idle" | "done" | "error"; message?: string };

export const SUBMIT_IDLE: SubmitState = { status: "idle" };
