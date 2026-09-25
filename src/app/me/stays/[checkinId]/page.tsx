import Link from "next/link";
import { notFound } from "next/navigation";

import { Money } from "@/components/ui/Money";
import { requireSignedIn } from "@/lib/auth/guard";
import { cancellationNoticeOf } from "@/lib/lodging/calendar";
import { fetchAccommodationTypes, fetchMyStay } from "@/lib/lodging/fetch-lodging";
import { fetchMyOrdersOfCheckIn } from "@/lib/orders/fetch-orders";
import { fetchMyApplications, type MyApplication } from "@/lib/quests/fetch-my-applications";
import { toServingStatusDisplayLabel } from "@/lib/serving-status";

/**
 * 滞在の詳細（画面ID A12 の遷移先 ／ WBS 3-8）。
 *
 * 根拠: v13 §5.2.5②「日付タップで当該滞在の詳細（部屋・同伴人数・注文・クエスト）へ遷移」／
 *       `画面設計.md` §4 A12「遷移」。
 *
 * ## 他人の滞在は「無い」ものとして返す
 *
 * `fetchMyStay()` が `member_id` で絞り、取れなければ 404 にする。
 * 「権限がありません」と出すと、**その滞在IDが存在すること自体**を教えてしまう
 * （v13 §8 ／ CLAUDE.md §7.1）。
 *
 * ## 注文は滞在IDで結び、クエストだけ日付で結ぶ
 *
 * 伝票（`orders`）は `checkin_id uuid NOT NULL REFERENCES check_ins`（`0019`）を持つため、
 * **滞在IDで厳密に結ぶ**。日付の重なりで拾うと、連泊をまたぐ予約で隣の滞在の伝票が混ざる。
 *
 * 受注申請（`quest_applications` ／ `0017`）のほうは滞在IDを持たないので、
 * こちらだけ**滞在期間に重なる日付**で拾う。関係テーブルを新設して結ぶのは
 * 仕様（v13 §5.3）に無い構造を足すことになるため採らない。
 */
/**
 * 受注1件が「いつの仕事か」を表す日付（`YYYY-MM-DD`）を集める。
 *
 * 申請日（`applied_at`）は入れない。申請は滞在のずっと前に出せるため、
 * それで拾うと滞在と関係のないクエストが詳細に並ぶ。
 */
function questDatesOf(application: MyApplication): string[] {
  const workedDates = application.workLogs.map((log) => log.workedAt.slice(0, 10));
  return application.scheduledStartAt === null
    ? workedDates
    : [application.scheduledStartAt.slice(0, 10), ...workedDates];
}

export default async function MyStayDetailPage({
  params,
}: {
  params: Promise<{ checkinId: string }>;
}) {
  const viewer = await requireSignedIn();
  const { checkinId } = await params;

  const stay = await fetchMyStay({ memberId: viewer.memberId, checkinId });
  if (stay === null) {
    notFound();
  }

  const [types, ordersOfStay, applications] = await Promise.all([
    fetchAccommodationTypes(),
    fetchMyOrdersOfCheckIn({ memberId: viewer.memberId, checkinId }),
    fetchMyApplications(viewer.memberId),
  ]);
  const roomTypeLabel =
    types.find((type) => type.roomType === stay.roomType)?.displayName ?? stay.roomType;
  // キャンセル済みでも 404 にしない。古いブックマークから開いた本人に、
  // 取り消された事実・日時・理由を読ませる（v13 §5.2.2「本人への表示」）。
  const cancellationNotice = cancellationNoticeOf(stay);

  const isDuringStay = (date: string) => stay.checkInDate <= date && date <= stay.checkOutDate;

  // クエストは日付窓で拾う（v13 §5.2.5②「部屋・同伴人数・注文・クエスト」）。
  // 作業日（`work_logs.worked_at`）と実行指示の予定日（`scheduled_start_at`）の
  // **どちらかが滞在期間に重なれば**その滞在の仕事として並べる。報告前の受注が
  // 落ちないよう予定日も見る（指示だけ出て報告がまだ、が滞在中の通常の状態である）。
  const applicationsDuringStay = applications.filter((application) =>
    questDatesOf(application).some(isDuringStay),
  );

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <Link className="text-sm underline" href={`/me?stayMonth=${stay.checkInDate.slice(0, 7)}`}>
          ← 宿泊予定・履歴へ戻る
        </Link>
        <h1 className="text-2xl font-bold">
          {stay.checkInDate} 〜 {stay.checkOutDate} の滞在
        </h1>
      </div>

      {cancellationNotice !== null && (
        <p className="rounded border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700">
          {cancellationNotice}
          <br />
          お心当たりがない場合は運営へお伝えください。
        </p>
      )}

      <section className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-4">
        <h2 className="text-lg font-bold">滞在の内容</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-600">宿泊形態</dt>
          <dd>{roomTypeLabel}</dd>

          <dt className="text-neutral-600">お部屋</dt>
          {/*
            未割当は「未割当」と出す。当日までに決まることがあるため空欄にしない。
            ただしキャンセル済みの予約に「当日ご案内します」と出すのは誤った案内になる。
          */}
          <dd>
            {stay.assignedRoomName ??
              (cancellationNotice === null ? "未割当（当日ご案内します）" : "未割当")}
          </dd>

          <dt className="text-neutral-600">人数</dt>
          <dd>
            大人 {stay.adultsCount}名・子供 {stay.childrenCount}名
          </dd>

          <dt className="text-neutral-600">状態</dt>
          <dd>{stay.status}</dd>

          {(stay.note ?? "") !== "" && (
            <>
              <dt className="text-neutral-600">備考</dt>
              <dd>{stay.note}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">この滞在中の注文</h2>
        {ordersOfStay.length === 0 ? (
          <p className="text-sm text-neutral-600">この期間の注文はありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ordersOfStay.map((order) => (
              <li
                key={order.orderId}
                className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-neutral-600">
                    {new Date(order.createdAt).toLocaleString("ja-JP")}
                  </span>
                  <span className="flex gap-1 text-xs">
                    <span className="rounded bg-neutral-100 px-2 py-0.5">{order.status}</span>
                    <span className="rounded bg-neutral-100 px-2 py-0.5">
                      {toServingStatusDisplayLabel(order.servingStatus)}
                    </span>
                  </span>
                </div>
                <ul className="text-sm">
                  {order.lines.map((line, index) => (
                    <li key={`${order.orderId}-${index}`}>
                      {line.productName} × {line.quantity}
                    </li>
                  ))}
                </ul>
                <span className="text-sm font-medium">
                  <Money priceYen={order.totalAmountYen} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">この滞在中のクエスト</h2>
        {applicationsDuringStay.length === 0 ? (
          <p className="text-sm text-neutral-600">この期間のクエストはありません。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {applicationsDuringStay.map((application) => (
              <li
                key={application.applicationId}
                className="flex flex-col gap-1 rounded border border-neutral-200 bg-white p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{application.questTitle}</span>
                  <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                    {application.status}
                  </span>
                </div>
                {application.instructionPlace !== null && (
                  <span className="text-sm text-neutral-600">
                    場所: {application.instructionPlace}
                  </span>
                )}
                {/* 報告の中身（写真・差戻し理由）は作業報告（A4）の関心。ここは日付だけに留める */}
                {application.workLogs.length > 0 && (
                  <span className="text-sm text-neutral-600">
                    報告日: {application.workLogs.map((log) => log.workedAt.slice(0, 10)).join("・")}
                  </span>
                )}
                <Link className="text-sm underline" href="/reports">
                  作業報告へ
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
