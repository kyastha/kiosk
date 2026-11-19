ALTER TABLE orders ADD COLUMN kiosk INTEGER NOT NULL DEFAULT 0 CHECK(kiosk IN (0,1));
ALTER TABLE orders ADD COLUMN cart_items TEXT CHECK(cart_items IS NULL OR json_valid(cart_items));
ALTER TABLE orders ADD COLUMN cart_owner_hash TEXT;

CREATE UNIQUE INDEX orders_cart_idempotency ON orders(cart_owner_hash, idempotency_key)
  WHERE cart_owner_hash IS NOT NULL AND idempotency_key IS NOT NULL;
CREATE INDEX orders_kiosk_latest ON orders(created_at DESC, id DESC) WHERE kiosk = 1;
