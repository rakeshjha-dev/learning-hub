// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json) and handled by server.js.
const { handle } = require('../server');

module.exports = (req, res) => {
  // The rewrite passes the original path as ?__path=…; put it back so the router sees the real URL.
  const url = new URL(req.url, 'http://localhost');
  const original = url.searchParams.get('__path');
  if (original) {
    url.searchParams.delete('__path');
    req.url = original + (url.searchParams.size ? `?${url.searchParams}` : '');
  }
  return handle(req, res);
};
