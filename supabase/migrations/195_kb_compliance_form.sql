-- KB article: attach an internal compliance public form.
-- When set, the form URL is included when an agent inserts the article in chat.
-- NULL = no form attached. The value is the compliance_request_types.key (e.g. 'closure').
ALTER TABLE ai_knowledge_documents
  ADD COLUMN compliance_form_type_key TEXT;
