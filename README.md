# 在庫金額計算くん（zaikokingaku-keisan-kun）

入庫一括が登録した「便ごとの原価」をもとに、先入先出で商品ごと・全体の在庫金額を表示するアプリです。

```
在庫金額 = 各便の残り × その便の1単位原価（単価＋オプション＋中国内運賃＋国際送料）
```

## できること

- **在庫金額の合計・在庫数・商品数・前月末との差**
- **NEと照合**：NEの在庫数と比べて、減った分を古い便から消費し、今日の在庫金額を記録（毎日 21:05 JST にも自動実行）
  - 初回だけ「便のない商品も導入前在庫として登録」にチェックすると、便のない商品をNEの在庫数・原価で「導入前在庫」（アプリ導入前からあった在庫）として登録します。導入前在庫の登録日は 2000-01-01 に固定され、便より古い扱いになります
- **商品別**：検索・絞り込み・並べ替え・CSV出力。行をクリックすると便ごとの残り・原価の内訳
- **入庫履歴**：配送依頼書ごとの合計原価・国際送料・残り
- **在庫推移(表)**：日次の在庫金額（日別／月別(月末時)の切り替え、表示期間はグラフと共通）。日付ごとに商品別CSVをダウンロードできるので、月末の棚卸金額の控えに使えます
- **在庫推移(グラフ)**：在庫金額の線グラフ（日別／月別(月末時)の切り替え、表示期間は表と共通）。点に触れると、前の点からの増減と入庫・出荷の金額が出ます
- **照合ログ**：いつ・どの商品で、古い便からいくつ消費したか

## しくみ

| 場所 | 役割 |
| --- | --- |
| 入庫一括 | NE更新のときに便ごとの原価を `cost_lots` に登録 |
| ne-sync-worker `POST /api/cost/reconcile` | NE在庫で照合（`cost_reconcile_stock`）→ 今日の記録（`cost_take_snapshot`）。Cron `5 12 * * *`（21:05 JST） で毎日実行 |
| Supabase | `cost_lots`・`cost_shipments`・`cost_inventory_snapshots`・`cost_stock_log` と集計ビュー |
| このアプリ | 表示と「NEと照合」ボタン |

## セットアップ

1. Supabase SQL Editor で、入庫一括の `supabase/cost_lots.sql` → このリポジトリの `supabase/zaiko_kingaku.sql` の順に実行
2. **キー用のユーザーを作る**：Supabase の Authentication → Users → Add user → Create new user
   - Email：専用のアドレス（例 `zaiko@kai-corp.jp`。実在しなくても可）
   - Password：**これが画面で入力するキー**（長めのものを）
   - 「Auto Confirm User」にチェック
   - ne-sync-worker の `SUPABASE_AUTH_ALLOWED_EMAILS` を設定している場合は、このメールアドレスを追加（「NEと照合」ボタンで使います）
3. ne-sync-worker を更新してデプロイ（`/api/cost/reconcile` と毎日の Cron）
4. GitHub の Repository secrets に以下を登録
   - `NEXT_PUBLIC_SUPABASE_URL`（入庫一括と同じ）
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`（入庫一括と同じ）
   - `NEXT_PUBLIC_NE_SYNC_WORKER_URL`（入庫一括と同じ）
   - `NEXT_PUBLIC_ZAIKO_LOGIN_EMAIL`（2で作ったメールアドレス）
5. Settings → Pages の Source を「GitHub Actions」にして push（`.github/workflows/deploy.yml` がビルド・公開します）

公開URLは `https://<ユーザー名>.github.io/zaikokingaku-keisan-kun/` です。ne-sync-worker の `ALLOWED_ORIGIN` は入庫一括と同じオリジン（`https://<ユーザー名>.github.io`）なので変更不要です。

### キーについて

アプリは誰でも開けますが、データは**右上の設定（歯車）でキーを入れるまで表示されません**。キーの中身は 2 で作ったユーザーのパスワード認証です。

- キーは GitHub Secrets には入れません（`NEXT_PUBLIC_` の値は公開されるJSに埋め込まれるため）。Supabase だけが知っています。データもSupabaseのRLSで、キー入力後にしか読めません
- 一度入れればそのブラウザでは保持されます。設定の「キーを外す」で解除
- キーを変えたいときは Supabase の Users でそのユーザーのパスワードを変更（それまでのブラウザも次回の更新時に外れます）

## ローカル起動

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

## バージョン

- 画面左上のロゴの横に「v1.0.0　2026/10/08 10:30」のように、バージョンとビルド日時が出ます。
- バージョンは `package.json` の `version`。更新のたびに上げ、内容は `CHANGELOG.md` に書きます。
- ビルドすると `out/version.json` に公開中のバージョンが書き出されます。開いている画面より新しいバージョンが公開されると、画面の上に「再読み込みして更新」が出ます。

## 在庫推移の表示期間

- 表とグラフで同じ期間を使います（タブを切り替えても期間はそのまま）。
- ボタン：先月〜今月／今月／今年／1年／全期間。日別は日付、月別は月の単位で決まります（例：日別の「1年」は1年前の翌日〜今日、月別の「1年」は今月を含めた12か月）。
- カレンダー：日別は yyyy/mm/dd〜yyyy/mm/dd、月別は yyyy/mm〜yyyy/mm を自由に選べます。

## 店舗別の在庫金額

照合のたびに、NEの商品分類タグ（`goods_tag`）を `cost_product_tags` に保存します。そのタグを `cost_store_rules`（タグ → 店舗）に当てて、商品ごとの店舗を決めます。

| 商品分類タグ | 店舗 |
|---|---|
| 自社出荷商品 | ゆかい屋 |
| STOCKCREW連携対象 | KAIRY(Yahoo) |
| SCハード資材発送 | KAIRY(Yahoo) |

- ルールを変えたいときは、Supabase の Table Editor で `cost_store_rules` を編集してください（行を足す・店舗名を変えるなど）。画面は次に更新したときから、日ごとの記録は次の照合から反映されます。
- タグ名が商品分類タグの中に含まれていれば当たりとみなします。違う店舗のタグが両方付いている商品は「複数」、どれにも当たらない商品とタグのない商品は「未設定」になります。
- 在庫推移(表)（`cost_inventory_snapshots.by_store`）にも店舗別の金額・個数・商品数を保存します。店舗に対応する前の記録には内訳がありません。
- 店舗名を「KAIRY」から「KAIRY(Yahoo)」に変えたときは `supabase/rename_store_kairy_yahoo.sql` を1回実行しました（ルールと過去の記録をまとめて置き換え）。
