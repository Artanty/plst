// `npm start` in ../back listens on 3218 by default (back/.env PORT=3218); PLST_API lets you
// point the dev server at another host/port (e.g. PLST_API=http://127.0.0.1:8123 npm start).
// YAUM_API is the pre-rename name and is still honoured so an old shell profile keeps working.
const target = process.env.PLST_API || process.env.YAUM_API || 'http://localhost:3218';

module.exports = {
  '/api': { target, secure: false, changeOrigin: true, logLevel: 'warn' },
};
