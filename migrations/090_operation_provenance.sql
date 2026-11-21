-- Runtime provenance of a chat operation's arguments (P1-C, ADR 0010): for each declared sink field, whether its value
-- came from the owner's own words, an untrusted observation (record refs only) or nowhere; and the decision taken
-- (allow / confirm = no auto-execution / deny is never stored: nothing is proposed). Values are never copied here.
ALTER TABLE chat_operations ADD COLUMN provenance JSONB;
