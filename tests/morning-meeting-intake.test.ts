// WBS 4-1（Issue #23）朝会テキスト投入の受入テスト（投入経路の形）。
//
// 根拠: v13 §9 #63 L2537「投入方法は**アプリのUI画面へのコピー＆ペースト**で確定
//       （API連携・ファイルアップロードは行わない）」「アプリは音声を扱わない」、
//       v13 §5.9.3 L1631-1638（サーバサイド認可を必ず併置する）。
//
// ここは「無いこと」を固定する試験である。RLS（`tests/db/morning-meetings-rls.test.ts`）は
// **DB へ到達した操作**しか守れないため、そもそも投入経路がテキスト貼り付け1本に絞られているか、
// RLS を迂回する `service_role` 経由になっていないかは、実装の形として別に押さえる必要がある。
//
// ⚠️ 走査はファイル名ではなく「朝会議事録を扱っているか」で行う。ディレクトリ名を決め打ちすると、
//    実装が別の名前で置かれたときに**1件も拾えないまま緑になる**（空振り）。
//    最初の試験でヒット件数そのものを固定し、空振りを検出できるようにしている。
// ⚠️ 判定対象はコードだけ。コメント行は落とす（「音声は扱わない」等の注記で誤検知するため）。
// ⚠️ 実装より先に書いている（設計 §11.6 commit-first）。投入画面はまだ無いため、現時点では失敗する。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(__dirname, "..");
const SOURCE_ROOT = join(REPOSITORY_ROOT, "src");

/**
 * 朝会**議事録そのもの**を扱う実装の目印。
 *
 * 「朝会」という語だけ、あるいは `morning_meeting_auto`（`quests.origin_type` の値 ／ WBS 5-1）では拾わない。
 * 既存のクエスト画面が4ファイルで朝会に言及しており、それらを巻き込むと
 * ①空振り検出が効かなくなる ②5-1 側の変更でこの試験が誤って落ちる。
 */
const MORNING_MEETING_MARKERS = ["morning_meetings", "transcript", "Transcript", "朝会議事録"];

/** ファイルアップロード経路の目印（v13 §9 #63「ファイルアップロードは行わない」）。 */
const FILE_UPLOAD_MARKERS = [
  'type="file"',
  "type='file'",
  "instanceof File",
  "as File",
  "multipart/form-data",
  ".arrayBuffer(",
  "createSignedUploadUrl",
  "storage.from(",
];

/** 音声・外部API連携の目印（v13 §9 #63「アプリは音声を扱わない」「API連携は行わない」）。 */
const AUDIO_OR_EXTERNAL_API_MARKERS = [
  "audio_storage_path",
  "audioStoragePath",
  "@google/genai",
  "GoogleGenAI",
  "transcribe",
  "speechToText",
];

/** RLS を迂回する経路の目印（`service_role` はサーバでも RLS を無効化する）。 */
const SERVICE_ROLE_MARKERS = ["lib/supabase/admin", "service_role", "SERVICE_ROLE"];

type SourceFile = { path: string; code: string };

/**
 * コメントを落とす。行頭の `//` 行とブロックコメントだけを対象にし、
 * 行末コメントは残す（URL の `//` を壊さないため）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** `src/` 配下の `.ts` / `.tsx` を、ルートからの相対パスで列挙する。 */
function listSourceFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      return listSourceFiles(join(root, entry.name), relativePath);
    }
    return /\.tsx?$/.test(entry.name) ? [relativePath] : [];
  });
}

/** 朝会議事録そのものを扱っている実装ファイル。コメントだけの言及は拾わない。 */
function findMorningMeetingSources(): SourceFile[] {
  return listSourceFiles(SOURCE_ROOT)
    .map((path) => ({ path, code: stripComments(readFileSync(join(SOURCE_ROOT, path), "utf8")) }))
    .filter((file) => MORNING_MEETING_MARKERS.some((marker) => file.code.includes(marker)));
}

/** 指定の目印を含むファイルのパス。失敗時に「どのファイルか」が分かるようにパスで比較する。 */
function pathsContaining(files: SourceFile[], markers: string[]): string[] {
  return files.filter((file) => markers.some((marker) => file.code.includes(marker))).map((file) => file.path);
}

describe("完了条件1: 朝会テキストの投入画面（v13 §9 #63）", () => {
  test("朝会テキスト投入の実装が src/ に存在する", () => {
    // 0件なら以降の「〜が無いこと」の試験がすべて空振りで緑になる。ここで先に落とす。
    expect(findMorningMeetingSources().length).toBeGreaterThan(0);
  });

  test("投入先がテキスト入力欄（textarea）である", () => {
    const withTextarea = findMorningMeetingSources().filter((file) => file.code.includes("<textarea"));
    expect(withTextarea.length).toBeGreaterThan(0);
  });
});

describe("完了条件4: サーバサイドのガードを併置する（v13 §5.9.3・§8）", () => {
  test("朝会の実装がサーバ側ロールガード（requireStaff）を参照している", () => {
    const guarded = pathsContaining(findMorningMeetingSources(), ["requireStaff"]);
    expect(guarded.length).toBeGreaterThan(0);
  });

  test("朝会の実装が service_role クライアントを使っていない", () => {
    // `service_role` は RLS を無効化するため、これを使うと DB 側の拒否がすべて素通りする。
    expect(pathsContaining(findMorningMeetingSources(), SERVICE_ROLE_MARKERS)).toEqual([]);
  });
});

describe("完了条件6: API連携・ファイルアップロードの経路を提供しない（v13 §9 #63）", () => {
  test("朝会議事録に触れる Route Handler が1つも無い", () => {
    const handlers = findMorningMeetingSources()
      .map((file) => file.path)
      .filter((path) => /(^|\/)route\.tsx?$/.test(path));
    expect(handlers).toEqual([]);
  });

  test("朝会の実装がファイルアップロードの経路を1つも持たない", () => {
    expect(pathsContaining(findMorningMeetingSources(), FILE_UPLOAD_MARKERS)).toEqual([]);
  });

  test("朝会の実装が音声・外部文字起こしAPIを1つも参照していない", () => {
    expect(pathsContaining(findMorningMeetingSources(), AUDIO_OR_EXTERNAL_API_MARKERS)).toEqual([]);
  });
});
