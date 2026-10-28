-- Extra databases of the development Postgres (compose.yaml): `trail` is the
-- dev database itself, `trail_test` belongs to the API integration tests and
-- `trail_e2e` to the Playwright suite, so neither wipes the other.
CREATE DATABASE trail_test;
CREATE DATABASE trail_e2e;
