CREATE SCHEMA stage1_clean_acceptance_fixture;

CREATE TABLE stage1_clean_acceptance_fixture.fixture_metadata (
  fixture_key text PRIMARY KEY,
  fixture_value text NOT NULL
);

GRANT USAGE ON SCHEMA stage1_clean_acceptance_fixture TO {{runtime_role}};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA stage1_clean_acceptance_fixture TO {{runtime_role}};
