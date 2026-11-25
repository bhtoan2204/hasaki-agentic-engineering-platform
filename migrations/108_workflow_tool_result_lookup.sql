-- Per-run metrics pair tool events by tool-use ID and attempt. The hash index
-- supports equality lookups and keeps the index key fixed-size for provider IDs.
CREATE INDEX workflow_events_tool_result_use_id
    ON workflow_events USING hash ((data->>'tool_use_id'))
    WHERE kind = 'tool_result';
