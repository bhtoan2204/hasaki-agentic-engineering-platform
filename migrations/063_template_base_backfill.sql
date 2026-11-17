-- Built-in definitions seeded before 062 take their merge base from the latest shipped template version.
UPDATE workflow_definitions d SET template_base = (
  SELECT v.spec FROM workflow_definition_versions v
   WHERE v.definition_id = d.id AND v.change_note LIKE 'built-in template%'
   ORDER BY v.version DESC LIMIT 1)
 WHERE d.is_template AND d.template_base IS NULL;
