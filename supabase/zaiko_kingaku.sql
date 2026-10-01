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

-- 今日（JST）のスナップショットを保存して合計を返す
create or replace function public.cost_take_snapshot(p_source text default 'manual')
returns jsonb
language plpgsql
as $$
declare
  v_date  date := (now() at time zone 'Asia/Tokyo')::date;
  v_row   public.cost_inventory_snapshots;
begin
  insert into public.cost_inventory_snapshots as s (
    snapshot_date, taken_at, source, total_value_jpy, total_qty,
    product_count, needs_review_count, items)
  select
    v_date, now(), coalesce(p_source, 'manual'),
    coalesce(sum(value_jpy), 0),
    coalesce(sum(qty), 0),
    count(*) filter (where qty > 0),
    count(*) filter (where qty > 0 and needs_review),
    coalesce(
      jsonb_agg(jsonb_build_object('c', product_code, 'q', qty, 'v', value_jpy)
                order by value_jpy desc) filter (where qty > 0),
      '[]'::jsonb)
  from public.cost_inventory_by_product
  on conflict (snapshot_date) do update set
    taken_at = excluded.taken_at,
    source = excluded.source,
    total_value_jpy = excluded.total_value_jpy,
    total_qty = excluded.total_qty,
    product_count = excluded.product_count,
    needs_review_count = excluded.needs_review_count,
    items = excluded.items
  returning * into v_row;

  return jsonb_build_object(
    'snapshot_date', v_row.snapshot_date,
    'total_value_jpy', v_row.total_value_jpy,
    'total_qty', v_row.total_qty,
    'product_count', v_row.product_count,
    'needs_review_count', v_row.needs_review_count
  );
end;
$$;

grant execute on function public.cost_take_snapshot(text) to authenticated, service_role;
