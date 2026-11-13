-- Installs seeded before reuse-first-development carried a conflict_key: give the shared seed row the key the Ponytail
-- pilot consolidates on, once, without touching a key an admin already set.
UPDATE knowledge_items SET conflict_key = 'engineering.reuse'
 WHERE key = 'reuse-first-development' AND owner_id IS NULL AND conflict_key IS NULL;
