import Link from "next/link";

import { readViewer } from "@/lib/auth/session";
import { visibleAreasFor } from "@/lib/auth/navigation";
import { canRegister } from "@/lib/shopping/status";

import { ShoppingRegisterForm } from "./shopping/ShoppingRegisterForm";

/**
 * ホーム（画面ID A2 ／ WBS 2-6 管理系メニューの到達性（ナビ情報設計））。
 *
 * ## 未ログインでも「次に何をすればよいか」が分かること
 *
 * `RoleNav` は未ログインだと `null` を返す（権限外の項目を DOM ごと描画しない
 * ／ v13 §5.9.2）。そのためトップが仮置きの文言だけだと、**ログインしていない人には
 * 画面に何も無く、ログイン経路も見つからない**状態になっていた。
 * 2026-09-21 に「この文言の画面しか出てこない」として報告された実際の詰まりである。
 *
 * 権限外の項目を隠すことと、入口そのものを隠すことは別である。
 * ログインリンクは誰に見せても権限を漏らさない。
 *
 * ## ログイン後はナビと同じ表を根拠に並べる
 *
 * 並べる領域は `visibleAreasFor()`（`src/lib/auth/navigation.ts`）から取る。
 * ここに独自の一覧を書くと、ナビ・サーバサイド認可に続く**3つ目の真実**ができる
 * （WBS 2-6 が「ナビ定義と §5.9.1 表を同一ロール定義から生成」と定めている理由）。
 *
 * ⚠️ **この一覧は防壁ではない。** 各画面側の `requireStaff()` / `requireAdmin()` が
 * 実際の関門である（v13 §5.9.3）。
 *
 * ## クイックアクション「🛒 ほしいものを登録」
 *
 * v13 §5.12.1「入口」が **A2 ホームと C1 統合ダッシュボードに置く**と名指しで定めている
 * （同 note：タブを増やさず、登録はダッシュボードのクイックアクションから行う）。
 * 領域リンクの並びとは別物なので、`visibleAreasFor()` の一覧には混ぜない。
 * **ここは「買い物リストを開く」リンクではなく、モーダル1枚で登録が完結する入口である。**
 *
 * 出し分けは一覧画面と同じ `canRegister()` で行う。ゲストは登録不可・閲覧のみであり
 * （§5.12.1「登録できるロール」／§9 #65②）、DOM ごと描画しない（§5.9.2）。
 * 画面から消すことは認可ではないため、Server Action 側でも同じ判定で拒否する（§5.9.3）。
 */
export default async function HomePage() {
  const viewer = await readViewer();

  if (!viewer.signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
        <h1 className="text-2xl font-bold">浮遊街アプリ</h1>
        <p className="text-sm text-neutral-600">
          クエスト・カフェ注文・宿泊予約をまとめて扱うアプリです。
          ご利用には登録されているメールアドレスでのログインが必要です。
        </p>
        <Link
          href="/login"
          className="self-start rounded bg-neutral-900 px-4 py-2 text-white"
        >
          ログイン
        </Link>
      </main>
    );
  }

  // `home` 自身はこの画面なので一覧から外す。自分へのリンクを並べても行き先が無い。
  const areas = visibleAreasFor(viewer.role).filter((area) => area.key !== "home");

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">浮遊街アプリ</h1>

      {canRegister(viewer.role) && (
        <section className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-medium text-neutral-700">クイックアクション</h2>
          <ShoppingRegisterForm />
        </section>
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {areas.map((area) => (
          <li key={area.key}>
            <Link
              href={area.path}
              className="block rounded border border-neutral-200 bg-white p-4 hover:border-neutral-400"
            >
              <span className="font-medium">{area.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
