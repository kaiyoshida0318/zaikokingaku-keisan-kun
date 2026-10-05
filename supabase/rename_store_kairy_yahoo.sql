-- =====================================================================
-- 店舗名「KAIRY」→「KAIRY(Yahoo)」に変更（1回だけ実行）
-- ルールと、これまでの日ごとの記録（店舗別の内訳・商品別CSVの店舗）をまとめて置き換えます。
-- もう一度実行しても、「KAIRY」が残っていなければ何も変わりません。
-- =====================================================================

-- タグ → 店舗のルール
update public.cost_store_rules
   set store = 'KAIRY(Yahoo)', updated_at = now()
 where store = 'KAIRY';

-- 日ごとの記録：店舗別の内訳
update public.cost_inventory_snapshots
   set by_store = (by_store - 'KAIRY')
                  || jsonb_build_object('KAIRY(Yahoo)', by_store -> 'KAIRY')
 where by_store ? 'KAIRY';

-- 日ごとの記録：商品ごとの店舗
update public.cost_inventory_snapshots s
   set items = (
     select jsonb_agg(
              case when e ->> 's' = 'KAIRY' then jsonb_set(e, '{s}', '"KAIRY(Yahoo)"') else e end
              order by ord)
       from jsonb_array_elements(s.items) with ordinality as t(e, ord)
   )
 where s.items @> '[{"s": "KAIRY"}]';
