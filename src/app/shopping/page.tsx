import { requireSignedIn } from "@/lib/auth/guard";
import { isStaff } from "@/lib/auth/session";
import { fetchShoppingItems, type ShoppingItem } from "@/lib/shopping/fetch-items";
import { isOpenableShopUrl } from "@/lib/shopping/shop-url";
import { canRegister, decideEdit } from "@/lib/shopping/status";

import { ShoppingItemEditForm } from "./ShoppingItemEditForm";
import { ShoppingRegisterForm } from "./ShoppingRegisterForm";
import { changeShoppingItemStatusAction, convertToQuestAction, joinShoppingItemAction } from "./actions";

/**
 * 買い物リスト（v13 §5.12 ／ 画面設計 A13・C14 ／ WBS 5-8・5-9）。
 *
 * ## 1画面に寄せている理由
 *
 * 設計上は A13（登録・閲覧）と C14（運営の判断・クエスト化）に分かれているが、
 * 見る対象は同じ1本のリストであり、違うのは**操作の出る／出ない**だけである。
 * 画面を2枚に割ると、運営が「登録された品」を見るために画面を行き来することになる。
 * 権限による出し分けはこのページ内で行い、判定は Server Component で終わらせる
 * （権限外の操作が一瞬見えることがない／v13 §5.9.2）。
 *
 * ## ゲスト
 *
 * 閲覧のみ（2026-09-22 オーナー確定 ／ §9 #65②）。登録フォームと操作ボタンを
 * **DOM ごと描画しない**うえで、Server Action 側でも拒否する（§5.9.3 の二重防御）。
 */

const STATUS_STYLE: Record<ShoppingItem["status"], string> = {
  希望: "bg-neutral-100 text-neutral-700",
  買う: "bg-blue-100 text-blue-800",
  クエスト化済: "bg-violet-100 text-violet-800",
  購入済: "bg-green-100 text-green-800",
  見送り: "bg-neutral-200 text-neutral-500",
};

function amountLabel(item: ShoppingItem): string {
  if (item.quantity === null) {
    return "";
  }
  return `${item.quantity}${item.unit ?? ""}`;
}

export default async function ShoppingPage() {
  const viewer = await requireSignedIn();
  const staff = isStaff(viewer.role);
  const items = await fetchShoppingItems();

  // 運営の待ち行列。ここだけがクエスト化の母集団になる（v13 §5.12.2）。
  const approved = items.filter((item) => item.status === "買う" && item.withdrawnAt === null);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">買い物リスト</h1>
        <p className="text-sm text-neutral-600">
          街で買ってきてほしいものを登録します。運営が「買う」と判断したものが、買い出しクエストになります。
        </p>
      </header>

      {canRegister(viewer.role) ? (
        <ShoppingRegisterForm />
      ) : (
        <p className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-600">
          閲覧のみできます。登録は街人・コアメンバー・管理者が行えます。
        </p>
      )}

      {staff && approved.length > 0 && (
        <form action={convertToQuestAction} className="flex flex-col gap-3 rounded border border-violet-300 p-4">
          <h2 className="text-lg font-bold">買い出しクエストにする</h2>
          <p className="text-sm text-neutral-600">
            選んだ品目を<strong>まとめて1件</strong>のクエストにします。品目ごとにクエストは作りません。
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {approved.map((item) => (
              <li key={item.itemId}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="itemIds" value={item.itemId} defaultChecked />
                  {item.itemName}
                  {amountLabel(item) && <span className="text-neutral-500">（{amountLabel(item)}）</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              クエスト名（任意）
              <input type="text" name="title" placeholder="買い出し（◯件）" className="rounded border border-neutral-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              報酬（Uii・任意）
              <input type="number" name="rewardUii" min="0" step="1" className="rounded border border-neutral-300 px-3 py-2" />
            </label>
          </div>
          <button type="submit" className="rounded bg-violet-700 px-4 py-2 text-white">
            選んだ品目でクエストを起案する
          </button>
        </form>
      )}

      <ul className="flex flex-col gap-3">
        {items.map((item) => {
          const owner = item.registeredBy === viewer.memberId;
          const withdrawn = item.withdrawnAt !== null;
          // 編集フォームを描くかどうかも Server Action と同じ判定で決める（v13 §5.9.2）。
          // 画面側に別の条件を書くと、出ているのに通らないボタンが生まれる。
          const editable = decideEdit({
            actorRole: viewer.role,
            current: item.status,
            withdrawn,
            isOwner: owner,
            itemName: item.itemName,
          }).allowed;

          return (
            <li
              key={item.itemId}
              className={`flex flex-col gap-2 rounded border border-neutral-300 p-4 ${withdrawn ? "opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">
                  {item.itemName}
                  {amountLabel(item) && <span className="ml-1 text-sm text-neutral-500">{amountLabel(item)}</span>}
                </p>
                <span
                  // バッジの色だけでは何を表しているか読めない。読み上げにも「ステータス」を乗せる。
                  aria-label={`ステータス：${withdrawn ? "取り下げ" : item.status}`}
                  className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[item.status]}`}
                >
                  {withdrawn ? "取り下げ" : item.status}
                </span>
              </div>

              <p className="text-xs text-neutral-500">
                優先度 {item.priority}
                {item.wantedBy && ` ／ ${item.wantedBy} まで`}
                {item.referencePriceJpy !== null && ` ／ 目安 ${item.referencePriceJpy.toLocaleString("ja-JP")}円`}
                {item.requesters.length > 0 && ` ／ ほしい人 ${item.requesters.length + 1}人`}
                {owner && " ／ 自分の登録"}
              </p>

              {item.purpose && <p className="text-sm text-neutral-700">{item.purpose}</p>}
              {(item.shopName || item.shopUrl) && (
                <p className="text-xs text-neutral-500">
                  入手先：{item.shopName}
                  {/*
                    リンクにするのは開けるURLだけ（`shop-url.ts`）。
                    保存時にも弾いているが、**この検証を入れる前に保存された行**が残るため
                    描画側でも判定する。開けない値は文字として出す（黙って消さない）。
                  */}
                  {item.shopUrl &&
                    (isOpenableShopUrl(item.shopUrl) ? (
                      <a href={item.shopUrl} className="ml-1 underline" rel="noreferrer noopener" target="_blank">
                        商品ページ
                      </a>
                    ) : (
                      <span className="ml-1">{item.shopUrl}</span>
                    ))}
                </p>
              )}
              {item.status === "見送り" && item.skipReason && (
                <p className="text-xs text-neutral-600">見送り理由：{item.skipReason}</p>
              )}

              {!withdrawn && (
                <div className="flex flex-wrap gap-2">
                  {canRegister(viewer.role) && !owner && (item.status === "希望" || item.status === "買う") && (
                    <form action={joinShoppingItemAction}>
                      <input type="hidden" name="itemId" value={item.itemId} />
                      <button type="submit" className="rounded border border-neutral-400 px-3 py-1 text-sm">
                        自分も欲しい
                      </button>
                    </form>
                  )}

                  {staff && item.status === "希望" && (
                    <form action={changeShoppingItemStatusAction}>
                      <input type="hidden" name="itemId" value={item.itemId} />
                      <input type="hidden" name="action" value="decide_buy" />
                      <button type="submit" className="rounded bg-blue-700 px-3 py-1 text-sm text-white">
                        買う
                      </button>
                    </form>
                  )}

                  {staff && (item.status === "希望" || item.status === "買う") && (
                    // 見送りは理由が必須（v13 §5.12.2）。却下の履歴が無いと同じ品目がまた登録される。
                    <form action={changeShoppingItemStatusAction} className="flex items-center gap-1">
                      <input type="hidden" name="itemId" value={item.itemId} />
                      <input type="hidden" name="action" value="skip" />
                      <input
                        type="text"
                        name="reason"
                        required
                        placeholder="見送る理由"
                        className="rounded border border-neutral-300 px-2 py-1 text-sm"
                      />
                      <button type="submit" className="rounded border border-neutral-400 px-3 py-1 text-sm">
                        見送る
                      </button>
                    </form>
                  )}

                  {staff && (item.status === "買う" || item.status === "クエスト化済") && (
                    <form action={changeShoppingItemStatusAction}>
                      <input type="hidden" name="itemId" value={item.itemId} />
                      <input type="hidden" name="action" value="mark_purchased" />
                      <button type="submit" className="rounded bg-green-700 px-3 py-1 text-sm text-white">
                        購入済みにする
                      </button>
                    </form>
                  )}

                  {staff && item.status === "クエスト化済" && (
                    // 部分購入。買えなかった分を戻し、クエスト自体は完了させる（v13 §5.12.3）。
                    <form action={changeShoppingItemStatusAction}>
                      <input type="hidden" name="itemId" value={item.itemId} />
                      <input type="hidden" name="action" value="return_to_buy" />
                      <button type="submit" className="rounded border border-neutral-400 px-3 py-1 text-sm">
                        買えなかった
                      </button>
                    </form>
                  )}

                  {(owner || staff) && item.status !== "購入済" && (
                    <form action={changeShoppingItemStatusAction} className="flex items-center gap-1">
                      <input type="hidden" name="itemId" value={item.itemId} />
                      <input type="hidden" name="action" value="withdraw" />
                      <input
                        type="text"
                        name="reason"
                        required
                        placeholder="取り下げる理由"
                        className="rounded border border-neutral-300 px-2 py-1 text-sm"
                      />
                      <button type="submit" className="rounded border border-neutral-400 px-3 py-1 text-sm">
                        取り下げ
                      </button>
                    </form>
                  )}
                </div>
              )}

              {editable && <ShoppingItemEditForm item={item} />}
            </li>
          );
        })}
      </ul>

      {items.length === 0 && <p className="text-sm text-neutral-600">まだ登録がありません。</p>}
    </main>
  );
}
