# 技育博2026 展示仕様・データ方針

- 対象：技育博 Vol.2（2026年9月19日）
- 決定日：2026年8月22日
- 状態：実装方針確定

## 1. 決定事項

| 項目 | 決定 |
| :--- | :--- |
| 公開基盤 | Cloudflareを第一候補とし、2日間の技術検証に失敗した場合はVercelへ切り替える |
| フロント配信 | Cloudflare Workers Static Assets |
| API | 静的配信と同じCloudflare Workerの`/api/*` |
| 画像保存 | 非公開Cloudflare R2 |
| DB | Cloudflare D1。画像を入れず、作品ID・期限・掲載状態・同意だけを保存する |
| 描画時間 | 上限を設けない。描画時間による自動完成は行わない |
| 放置状態 | 描画中の無操作だけを検知し、90秒後に15秒のリセット警告を出す。操作で解除できる |
| QR保存 | 「QRで受け取る」を押した場合だけアップロードする |
| QR期限 | 完成画像の準備完了から24時間 |
| ギャラリー | 掲載同意がある作品を、承認待ちなしで会場画面へ即時掲載する |
| 掲載同意 | QR受け取りとは別操作、既定OFF |
| 作者情報 | 匿名を既定とし、表示名・落款は任意。展示端末には永続保存しない |
| 緊急対応 | スタッフによる個別非表示・削除、ギャラリー全体停止を必須にする |
| 通信障害 | 共有シートとPNG保存を維持し、QR・ギャラリーの失敗で描画体験を失敗扱いにしない |

「描画時間の上限なし」と「放置された端末の復旧」は分けて扱います。来場者が操作を続けている限り時間制限はなく、無人の作品だけが警告後に初期化されます。

## 2. Cloudflare構成

```text
展示端末・来場者スマートフォン・会場ギャラリー
                         │
                         ▼
      Cloudflare Worker + Static Assets
      ├── Viteの静的ファイルを配信
      ├── /api/artworks/*  QR受取・削除
      ├── /api/gallery     会場ギャラリー
      ├── /api/staff/*     非表示・全体停止
      └── scheduled()      期限切れ削除
                 │                    │
                 ▼                    ▼
        D1（メタデータ）       private R2（PNG）
```

### 役割分担

**R2に保存するもの**

- QR受け取り用PNG
- ギャラリー掲載用PNG
- オブジェクトキー例：`ephemeral/2026-geekhaku/{randomId}/pickup.png`
- R2の`r2.dev`公開URLと公開カスタムドメインは使用しない

**D1に保存するもの**

- 推測困難な作品ID
- R2のオブジェクトキー
- 作成日時、QR期限、ギャラリー期限
- ギャラリー掲載同意と同意文バージョン
- `none / visible / hidden`の掲載状態
- 本人削除用トークンのハッシュ
- ファイルサイズ
- 二重送信を防ぐクライアントリクエストID

**D1に保存しないもの**

- PNG本体
- メールアドレス、電話番号、SNS ID
- 位置情報、端末ID
- 平文の削除トークン
- 表示名のテキスト。掲載する場合は本人が確認したPNGへ描画する

D1は一覧取得、掲載状態の変更、期限検索に向いています。PNGはD1の行サイズ上限を超える可能性があるため、必ずR2へ分離します。

## 3. 最小データモデル

実装開始時の最小構成は`events`と`artworks`の2テーブルとします。

```sql
CREATE TABLE events (
  id                 TEXT PRIMARY KEY,
  gallery_enabled    INTEGER NOT NULL DEFAULT 1,
  gallery_starts_at  INTEGER NOT NULL,
  gallery_ends_at    INTEGER NOT NULL,
  consent_version    TEXT NOT NULL
) STRICT;

CREATE TABLE artworks (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL,
  client_request_id     TEXT NOT NULL UNIQUE,
  pickup_object_key     TEXT NOT NULL UNIQUE,
  gallery_object_key    TEXT,
  created_at            INTEGER NOT NULL,
  receipt_expires_at    INTEGER NOT NULL,
  gallery_expires_at    INTEGER,
  gallery_status        TEXT NOT NULL CHECK (
    gallery_status IN ('none', 'visible', 'hidden')
  ),
  gallery_identity      TEXT NOT NULL CHECK (
    gallery_identity IN ('anonymous', 'signed')
  ),
  gallery_consented_at  INTEGER,
  consent_version       TEXT,
  delete_token_hash     TEXT NOT NULL,
  size_bytes            INTEGER NOT NULL,
  delete_pending        INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (event_id) REFERENCES events(id)
) STRICT;

CREATE INDEX idx_artworks_gallery
ON artworks(event_id, gallery_status, created_at DESC);

CREATE INDEX idx_artworks_receipt_expiry
ON artworks(receipt_expires_at);
```

データ量が小さい展示MVPでは、監査ログ、アップロードリース、複数DB、ORMは追加しません。必要性が確認できた時だけ拡張します。

## 4. 作品の保存と取得

### 保存

1. 来場者が「完成」を押し、端末内だけで作品カードを生成する
2. 「QRで受け取る」を押すと、展示端末から同一オリジンのWorkerへPNGを送る
3. Workerは展示端末の短期セッション、`image/png`、最大10MiB、PNGシグネチャ、1080×1350を検証する
4. Workerが非公開R2へ保存する
5. R2保存成功後にD1へレコードを作る
6. D1保存後に短い受取URLを返し、端末内でQRコードを生成する

Cloudflare Free/ProのHTTPリクエスト上限は100MBであるため、10MiB以下のPNGはWorker経由で扱えます。MVPではPresigned URL、S3認証情報、R2 CORSを追加しません。

### 取得

- QRにはR2 URLではなく`/works/{randomId}`を入れる
- 受取ページはWorker経由で画像を取得する
- WorkerはD1の`receipt_expires_at`を毎回確認する
- 期限内だけprivate R2から画像をストリームで返す
- 期限切れは`410 Gone`を返す
- 作品レスポンスは`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`とする
- ページとAPIを検索エンジンへ登録させない

R2を公開しないため、定期削除が遅れても期限後の作品へ直接アクセスできません。

## 5. 保持期限と削除

- QR受け取り：準備完了から24時間でアクセス停止
- ギャラリー：イベント終了時刻で一覧から除外
- 画像の物理削除：QR期限とギャラリー期限の遅い方を過ぎた後
- Cron Trigger：15分ごとに期限切れを最大50件ずつ処理
- 削除順：D1を`delete_pending=1`にして公開停止 → R2削除 → D1行削除
- R2 Lifecycle：`ephemeral/`を1日で期限切れにし、Cronが取りこぼした孤児画像を回収

R2 Lifecycleは期限時刻の直後に削除される保証がないため、24時間のアクセス停止はWorkerとD1で保証します。Cronが正常なら物理削除は期限から約15分以内、Cronが失敗した場合もLifecycleで通常48時間以内の削除を目標とします。

本人削除用トークンはQR URLのフラグメントへ含め、D1にはハッシュだけを保存します。本人が削除した場合はQRとギャラリーの両方を即時停止します。既にスマートフォンへ保存された画像や、会場で撮影された写真は削除できません。

## 6. 会場ギャラリー

- 「会場ギャラリーへ飾る」は既定OFF
- 操作時に「スタッフ承認なしで会場画面へ表示される」と明示する
- 同意後、画像保存とD1登録が両方成功した時点で`visible`にする
- 壊れた画像やアップロード途中の作品は一覧へ出さない
- 匿名掲載を既定とする
- 「表示名・落款も掲載」を別に選んだ場合だけ署名入り画像を使う
- ギャラリー一覧は会場表示用の短期セッションを持つ端末だけが取得できるようにする
- スタッフは個別作品を即時`hidden`にできる
- スタッフは`events.gallery_enabled=0`でギャラリー全体を即時停止できる
- 非表示はQR受け取りへ影響させない
- 完全削除はQRとギャラリーの両方を停止する

承認作業は設けません。ただし、承認なしの自動掲載では不適切な描画が即時表示され得るため、個別非表示と全体停止は省略しません。

## 7. 展示セッション

```text
idle → drawing → finishing → delivery → resetting → idle
```

- `idle`：5秒後から待機デモ。最初のタッチで白紙にし、そのタッチを一筆目として扱う
- `drawing`：時間上限なし。90秒無操作で15秒警告し、タッチすれば継続する
- `finishing`：描画を固定し、構図・表示名・落款・掲載同意を設定する
- `delivery`：QR、共有、PNG保存を表示する。90秒無操作で15秒警告する
- `resetting`：セッションIDを先に無効化し、端末内データを一括削除する

カード生成、アップロード、共有シート表示、ページ非表示中は無操作タイマーを止めます。通信処理は15秒で一度失敗扱いとし、再試行、共有、PNG保存を提示します。

展示モードでは作者名、落款、掲載同意を`localStorage`へ保存しません。通常モードの保存済み作者情報も読み込みません。

タッチ端末で幅が変わらない高さだけの変化は、ソフトウェアキーボードやブラウザUIによる表示領域の変化として扱い、物理格子とUndo/Redo履歴を変更しません。この間にCanvasが表示上だけ拡縮されても、Pointer座標を物理格子へ逆変換して指と墨の位置を一致させます。

端末回転など幅を含む実リサイズでは、CPU/GPUの流体状態と紙の物性場を、縦横比を保つ中央フィットで新しい格子へ移します。論理作品領域を状態とUndo履歴へ保持するため、縦横を往復しても前回の余白を重ねて縮小しません。旧格子に属するUndo/Redo履歴だけを破棄します。readback、カード生成、Undo/Redo、リサイズは直列化し、処理中の描画入力を一時停止します。readback中に新しいリサイズ要求が来た場合は、古い寸法への変更を格子更新前に中止します。

## 8. アクセス制御と乱用対策

- 展示端末は開始時にスタッフコードで解除し、Workerが短期のHttpOnly Cookieを発行する
- アップロードAPIは解除済み展示端末だけが利用できる
- Cookie、R2、D1に関する秘密を`VITE_`環境変数へ入れない
- アップロードは展示セッション単位で毎分10件までとする
- 同じ`client_request_id`の再送は同じ作品として扱う
- 一般公開する入力はPNGだけとし、SVG、HTML、任意URLを受け付けない
- ギャラリーは画像を`<img>`としてのみ表示し、テキストをHTMLとして挿入しない
- スタッフ画面は別の短期Cookieで保護する
- 外部分析SDK、広告SDK、追跡Cookieを導入しない

## 9. Cloudflare採用判定

Cloudflareの技術検証は2日で区切ります。既存公開環境は消さず、`workers.dev`上で並行検証します。

次をすべて満たしたらCloudflareを採用します。

- ViteビルドをWorkers Static Assetsから表示できる
- D1 migrationをローカルと本番へ適用できる
- 作品PNGをWorker経由でprivate R2へ保存できる
- QR URLを別のスマートフォンで開いて保存できる
- 掲載同意した作品がギャラリーへ即時反映される
- 個別非表示とギャラリー全体停止が動く
- 期限切れアクセスが`410 Gone`になる
- CronでR2とD1を削除できる
- 20作品を連続投稿してエラーや前セッションの混入がない

2日で通らない場合は、フロントとAPIをVercel、画像をVercel Blob、メタデータをUpstash Redisへ置き換えます。フロント側は`ArtworkService`インターフェース越しに呼び、保存先固有コードをUIへ混ぜないようにします。

## 10. 開発・料金方針

- 最初はCloudflare Freeで技術検証する
- 本番月は負荷試験の結果に応じてWorkers Paidを検討する
- R2はStandardだけを使用する
- PNGは1作品10MiBまで、ギャラリー取得は1回50件までとする
- ギャラリーはカーソルページングを使い、全件を高頻度で再取得しない
- R2 Lifecycleをデータ投入前に設定する
- 課金通知を設定する。通知は利用停止を行う上限ではない点に注意する

現行のVite 5ではCloudflare Vite pluginを直接利用できません。最初の技術検証は`wrangler`とWorkers Static Assetsで行い、ViteのアップグレードをCloudflare採否の必須条件にしません。統合開発環境が必要になった場合だけ、Vite 6以上への更新とCloudflare Vite plugin導入を別タスクとして検討します。

## 11. 表示文言

### QR受け取り

> 「QRで受け取る」を押すと、作品を受け取り用サーバーへ保存します。QRページは24時間利用でき、URLを知る人は作品を閲覧・保存できます。ギャラリーには自動掲載されません。

### ギャラリー掲載

> 会場ギャラリーに飾る（任意）
>
> 選択すると、スタッフの事前承認なしで技育博当日のBOKUGI会場画面へ表示されます。他の来場者が撮影する可能性があります。掲載は後から取り消せます。

## 12. 公式資料

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workersの制限](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
- [R2 Object Lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [D1 Workers Binding API](https://developers.cloudflare.com/d1/worker-api/)
- [D1の制限](https://developers.cloudflare.com/d1/platform/limits/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflareのストレージ選択](https://developers.cloudflare.com/workers/platform/storage-options/)
