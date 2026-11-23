BEGIN;
ALTER TABLE catalog.products ADD COLUMN stock_level integer;
ALTER TABLE accounting.orderitem ADD COLUMN warehouse_code text;
SELECT pg_sleep(1500);
ROLLBACK;
