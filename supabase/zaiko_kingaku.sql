-- =====================================================================
-- 在庫金額計算くん 用の追加テーブル・関数
-- 先に入庫一括の supabase/cost_lots.sql を実行してから、このファイルを実行してください。
-- 何度実行しても大丈夫です。
-- =====================================================================

-- 商品コード（小文字）で絞り込めるように生成列を追加
alter table public.cost_lots
  add column if not exists product_code_lc text generated always as (lower(product_code)) stored;
create index if not exists cost_lots_product_code_lc_idx
  on public.cost_lots (product_code_lc, received_at, id);

-- 日次スナップショット（月末の棚卸金額の控え）
create table if not exists public.cost_inventory_snapshots (
  snapshot_date       date primary key,               -- JSTの日付。同じ日は上書き
  taken_at            timestamptz not null default now(),
  source              text not null default 'manual', -- manual / cron
  total_value_jpy     numeric not null default 0,
  total_qty           bigint not null default 0,
  product_count       integer not null default 0,
  needs_review_count  integer not null default 0,
  items               jsonb not null default '[]'::jsonb  -- [{"c":"code","q":10,"v":1234}]
);

alter table public.cost_inventory_snapshots enable row level security;
drop policy if exists cost_inventory_snapshots_authenticated_all on public.cost_inventory_snapshots;
create policy cost_inventory_snapshots_authenticated_all
  on public.cost_inventory_snapshots for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.cost_inventory_snapshots to authenticated, service_role;

-- 便ごとの残り
create or replace view public.cost_inventory_by_shipment
with (security_invoker = true) as
select
  l.shipment_id,
  min(l.received_at)                                         as received_at,
  count(*)::integer                                          as product_count,
  sum(l.qty_in)::integer                                     as qty_in,
  sum(l.qty_remaining)::integer                              as qty_remaining,
  round(sum(l.qty_in * coalesce(l.unit_cost, 0)), 0)         as value_in_jpy,
  round(sum(l.qty_remaining * coalesce(l.unit_cost, 0)), 0)  as value_remaining_jpy,
  bool_or(l.needs_review)                                    as needs_review
from public.cost_lots l
where l.lot_type = 'shipment'
group by l.shipment_id;

grant select on public.cost_inventory_by_shipment to authenticated, service_role;

-- 便が1つでもある商品コード（照合の対象）
create or replace function public.cost_lot_product_codes()
returns setof text
language sql
stable
as $$
  select max(product_code) from public.cost_lots group by lower(product_code) order by 1;
$$;

grant execute on function public.cost_lot_product_codes() to authenticated, service_role;

-- 今日（JST）のスナップショットを保存する関数 cost_take_snapshot は、店舗別の内訳と一緒にこのファイルの最後で定義しています。

-- =====================================================================
-- 店舗（ゆかい屋 / KAIRY(Yahoo) など）
--   NEの商品分類タグ（goods_tag）を照合のたびに cost_product_tags に保存し、
--   cost_store_rules の「タグ → 店舗」で商品ごとの店舗を決める。
--   ルールは Supabase の Table Editor で cost_store_rules を編集すれば変えられる（次の画面更新から反映）。
-- =====================================================================

-- タグ → 店舗のルール（タグ名が商品分類タグに含まれていれば、その店舗）
create table if not exists public.cost_store_rules (
  tag         text primary key,
  store       text not null,
  sort_order  integer not null default 0,   -- 画面の並び順（小さいほど先）
  updated_at  timestamptz not null default now()
);

insert into public.cost_store_rules (tag, store, sort_order) values
  ('自社出荷商品',       'ゆかい屋', 1),
  ('STOCKCREW連携対象', 'KAIRY(Yahoo)', 2),
  ('SCハード資材発送',   'KAIRY(Yahoo)', 2)
on conflict (tag) do nothing;

-- 商品ごとのNE商品分類タグ（照合のたびに上書き）
create table if not exists public.cost_product_tags (
  product_code_lc  text primary key,
  product_code     text not null,
  goods_tag        text,
  updated_at       timestamptz not null default now()
);

alter table public.cost_store_rules  enable row level security;
alter table public.cost_product_tags enable row level security;
drop policy if exists cost_store_rules_authenticated_all on public.cost_store_rules;
create policy cost_store_rules_authenticated_all
  on public.cost_store_rules for all to authenticated using (true) with check (true);
drop policy if exists cost_product_tags_authenticated_all on public.cost_product_tags;
create policy cost_product_tags_authenticated_all
  on public.cost_product_tags for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.cost_store_rules, public.cost_product_tags to authenticated, service_role;

-- 照合から呼ぶ：商品分類タグをまとめて保存
-- p = { "tags": [{"product_code": "abc", "goods_tag": "自社出荷商品,..."}] }
create or replace function public.cost_upsert_product_tags(p jsonb)
returns integer
language sql
as $$
  with src as (
    select distinct on (lower(x->>'product_code'))
           lower(x->>'product_code') as lc,
           x->>'product_code'        as code,
           nullif(x->>'goods_tag', '') as tag
      from jsonb_array_elements(coalesce(p->'tags', '[]'::jsonb)) x
     where coalesce(x->>'product_code', '') <> ''
  ), up as (
    insert into public.cost_product_tags as t (product_code_lc, product_code, goods_tag, updated_at)
    select lc, code, tag, now() from src
    on conflict (product_code_lc) do update set
      product_code = excluded.product_code,
      goods_tag = excluded.goods_tag,
      updated_at = now()
    returning 1
  )
  select count(*)::integer from up;
$$;

grant execute on function public.cost_upsert_product_tags(jsonb) to authenticated, service_role;

-- 便のある商品ごとの店舗。ルールに当たらなければ null（未設定）、違う店舗に2つ以上当たれば「複数」
create or replace view public.cost_product_store
with (security_invoker = true) as
select
  c.product_code_lc,
  t.goods_tag,
  case count(distinct r.store)
    when 0 then null
    when 1 then max(r.store)
    else '複数'
  end                                                   as store,
  string_agg(distinct r.store, ' / ')                   as matched_stores
from (select distinct lower(product_code) as product_code_lc from public.cost_lots) c
left join public.cost_product_tags t on t.product_code_lc = c.product_code_lc
left join public.cost_store_rules r on t.goods_tag is not null and position(r.tag in t.goods_tag) > 0
group by c.product_code_lc, t.goods_tag;

grant select on public.cost_product_store to authenticated, service_role;

-- スナップショットにも店舗別の内訳を残す
-- by_store = {"ゆかい屋": {"v": 金額, "q": 個数, "n": 商品数}, "KAIRY(Yahoo)": {...}, "未設定": {...}}
alter table public.cost_inventory_snapshots
  add column if not exists by_store jsonb not null default '{}'::jsonb;

create or replace function public.cost_take_snapshot(p_source text default 'manual')
returns jsonb
language plpgsql
as $$
declare
  v_date  date := (now() at time zone 'Asia/Tokyo')::date;
  v_row   public.cost_inventory_snapshots;
begin
  with inv as (
    select i.product_code, i.qty, i.value_jpy, i.needs_review,
           coalesce(s.store, '未設定') as store
      from public.cost_inventory_by_product i
      left join public.cost_product_store s on s.product_code_lc = i.product_code_lc
  ), per_store as (
    select coalesce(
             jsonb_object_agg(store, jsonb_build_object('v', v, 'q', q, 'n', n)),
             '{}'::jsonb) as by_store
      from (
        select store, sum(value_jpy) as v, sum(qty) as q, count(*) as n
          from inv where qty > 0 group by store
      ) g
  )
  insert into public.cost_inventory_snapshots as s (
    snapshot_date, taken_at, source, total_value_jpy, total_qty,
    product_count, needs_review_count, items, by_store)
  select
    v_date, now(), coalesce(p_source, 'manual'),
    coalesce(sum(value_jpy), 0),
    coalesce(sum(qty), 0),
    count(*) filter (where qty > 0),
    count(*) filter (where qty > 0 and needs_review),
    coalesce(
      jsonb_agg(jsonb_build_object('c', product_code, 'q', qty, 'v', value_jpy, 's', store)
                order by value_jpy desc) filter (where qty > 0),
      '[]'::jsonb),
    (select by_store from per_store)
  from inv
  on conflict (snapshot_date) do update set
    taken_at = excluded.taken_at,
    source = excluded.source,
    total_value_jpy = excluded.total_value_jpy,
    total_qty = excluded.total_qty,
    product_count = excluded.product_count,
    needs_review_count = excluded.needs_review_count,
    items = excluded.items,
    by_store = excluded.by_store
  returning * into v_row;

  return jsonb_build_object(
    'snapshot_date', v_row.snapshot_date,
    'total_value_jpy', v_row.total_value_jpy,
    'total_qty', v_row.total_qty,
    'product_count', v_row.product_count,
    'needs_review_count', v_row.needs_review_count,
    'by_store', v_row.by_store
  );
end;
$$;

grant execute on function public.cost_take_snapshot(text) to authenticated, service_role;
