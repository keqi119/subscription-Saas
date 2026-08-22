CREATE FUNCTION "contract_esign_task_source_tuple_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."source_type" IS DISTINCT FROM NEW."source_type"
    OR OLD."source_id" IS DISTINCT FROM NEW."source_id"
    OR OLD."source_key" IS DISTINCT FROM NEW."source_key"
  THEN
    RAISE EXCEPTION 'contract e-sign task source tuple is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'contract_esign_task_source_tuple_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "contract_esign_task_source_tuple_immutable_trg"
BEFORE UPDATE OF "source_type", "source_id", "source_key"
ON "contract_esign_task"
FOR EACH ROW
EXECUTE FUNCTION "contract_esign_task_source_tuple_immutable"();
