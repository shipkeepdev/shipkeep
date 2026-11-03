// Runs before every unit test file (vitest `setupFiles`). The configuration module validates the
// environment when app.module.ts is imported, so test defaults must exist before any import.
// Values are obviously fake; unit tests never open a database connection.
process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] ??= 'error';
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/shipkeep_test';
process.env['SHIPKEEP_KEK_FILE'] ??= '/dev/null';
process.env['OPENAPI_UI'] ??= 'true';
