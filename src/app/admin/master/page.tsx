import { AccessDenied } from "@/components/auth/AccessDenied";
import { RateMasterForm } from "@/components/lodging/RateMasterForm";
import { MenuMasterForm } from "@/components/orders/MenuMasterForm";
import { Money } from "@/components/ui/Money";
import { AccessDeniedError, requireAdmin } from "@/lib/auth/guard";
import {
  fetchAccommodationRates,
  fetchAccommodationTypes,
} from "@/lib/lodging/fetch-lodging";
import { fetchMenuItems } from "@/lib/orders/fetch-orders";
import { groupMenuItemsByCategory } from "@/lib/orders/menu";

import { createAccommodationRateAction, createMenuItemAction } from "./actions";

/**
 * マスタ管理（画面ID C13 ／ WBS 6-4）。
 *
 * ## 扱うのはカフェメニューと宿泊料金の2つ
 *
 * 画面設計.md §4 C13 の指定どおり。宿泊料金は `0021_accommodation_rates.sql`
 * （WBS 3-9 ／ Issue #106）で表が入ったため 2026-09-21 に追加した。
 *
 * どちらも **Uii の入力欄を置かない**。v13 §5.5 が `floor(単価×0.8)` と定めており、
 * マスタは円単価だけを持つ。入力させると円と Uii が食い違ったマスタが作れる。
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

  const [menuItems, types, rates] = await Promise.all([
    fetchMenuItems(),
    fetchAccommodationTypes(),
    fetchAccommodationRates(),
  ]);
  const displayNameOf = new Map(types.map((type) => [type.roomType, type.displayName]));
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

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">宿泊料金を追加</h2>
        <p className="text-sm text-neutral-600">
          料金の改定は既存行を書き換えず、適用期間を区切って新しい行を足します。
          過去の予約を当時の料金で再計算できるようにするためです。
        </p>
        <RateMasterForm types={types} action={createAccommodationRateAction} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-bold">
          登録済みの宿泊料金
          <span className="ml-2 text-sm font-normal text-neutral-600">{rates.length}件</span>
        </h2>
        {rates.length === 0 ? (
          <p className="text-sm text-neutral-600">
            まだ登録がありません。料金は仕様書に実額が無いため、運営が入力するまで空のままです。
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rates.map((rate) => (
              <li
                key={rate.rateId}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-neutral-200 bg-white px-3 py-2 text-sm"
              >
                <span>
                  {displayNameOf.get(rate.roomType) ?? rate.roomType}
                  <span className="ml-2 rounded bg-neutral-100 px-2 py-0.5 text-xs">
                    {rate.memberCategory === "member" ? "会員" : "非会員"}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <Money priceYen={rate.pricePerNightYen} />
                  <span className="text-xs text-neutral-600">
                    {rate.effectiveFrom} 〜 {rate.effectiveUntil ?? "現行"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
