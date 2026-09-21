import { AccessDenied } from "@/components/auth/AccessDenied";
import { MenuMasterForm } from "@/components/orders/MenuMasterForm";
import { Money } from "@/components/ui/Money";
import { AccessDeniedError, requireAdmin } from "@/lib/auth/guard";
import { fetchMenuItems } from "@/lib/orders/fetch-orders";
import { groupMenuItemsByCategory } from "@/lib/orders/menu";

import { createMenuItemAction } from "./actions";

/**
 * マスタ管理（画面ID C13 ／ WBS 6-4）。
 *
 * ## Phase 1 の範囲はカフェメニューだけ
 *
 * 画面設計.md §4 C13 は「カフェメニュー／宿泊料金」の2つを挙げているが、
 * 宿泊料金マスタ（WBS 3-9）は DDL が未作成であり、ここに欄だけ置くと
 * 保存できないフォームになる。**入れられるようになってから足す。**
 *
 * ## 未公開・期間外も出す
 *
 * `/orders` の品書きと違い、マスタは**全件**を出す。未公開のものが一覧から
 * 消えると、「登録したはずのものが無い」と見え、二重登録を招く。
 */
export default async function AdminMasterPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return (
        <AccessDenied
          currentRole={error.denial.currentRole}
          requiredRoleLabel={error.denial.requiredRoleLabel}
        />
      );
    }
    throw error;
  }

  const menuItems = await fetchMenuItems();
  const categories = [...new Set(menuItems.map((item) => item.category))];

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-bold">マスタ管理</h1>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">カフェメニューを追加</h2>
        <MenuMasterForm action={createMenuItemAction} categories={categories} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">
          登録済みメニュー
          <span className="ml-2 text-sm font-normal text-neutral-600">{menuItems.length}件</span>
        </h2>
        {groupMenuItemsByCategory(menuItems).map((group) => (
          <div key={group.category} className="flex flex-col gap-1">
            <h3 className="text-sm font-bold text-neutral-700">{group.category}</h3>
            <ul className="flex flex-col gap-1">
              {group.items.map((item) => (
                <li
                  key={item.menuItemId}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-neutral-200 bg-white px-3 py-2 text-sm"
                >
                  <span>{item.name}</span>
                  <span className="flex items-center gap-2">
                    <Money priceYen={item.unitPriceYen} />
                    {!item.isPublished && (
                      <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs">未公開</span>
                    )}
                    {item.isSoldOut && (
                      <span className="rounded bg-neutral-700 px-2 py-0.5 text-xs text-white">
                        SOLDOUT
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-bold">宿泊料金</h2>
        <p className="text-sm text-neutral-600">
          宿泊料金マスタ（WBS 3-9 宿泊料金マスタ）はテーブルが未作成のため、まだ編集できません。
        </p>
      </section>
    </main>
  );
}
