// Creates the benchmark database if it is missing (the benchmark's global setup then rebuilds its schema).
const { Client } = require('pg');
const url = new URL(process.env.TEST_DATABASE_URL);
const name = url.pathname.slice(1);
url.pathname = '/postgres';
const c = new Client({ connectionString: url.toString() });
c.connect()
  .then(() => c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]))
  .then((r) => (r.rowCount ? null : c.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`)))
  .then(() => c.end())
  .catch((e) => { console.error(e.message); process.exit(1); });
