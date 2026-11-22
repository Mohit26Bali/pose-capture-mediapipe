/**
 * Headers for every response. The CSP covers the bundled web UI: its own scripts and styles,
 * images from itself and from blob:/data: (thumbnails fetched with the API key, canvas output), and
 * nothing else, so a stored filename can never become running script.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  next();
}

module.exports = securityHeaders;
