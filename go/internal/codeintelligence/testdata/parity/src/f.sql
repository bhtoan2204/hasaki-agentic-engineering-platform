CREATE TABLE payments (id BIGSERIAL PRIMARY KEY, order_id BIGINT REFERENCES orders(id), note TEXT DEFAULT 'it''s');
CREATE VIEW paid AS SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.status = 'PAID';
CREATE INDEX payments_order ON payments(order_id);
CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
SELECT * FROM refunds r JOIN payments p ON p.id = r.payment_id;
