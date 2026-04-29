const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

function rewriteUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);

  function proxify(url) {
    if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('mailto:')) {
      return url;
    }
    try {
      const absolute = new URL(url, base).href;
      return `/proxy?url=${encodeURIComponent(absolute)}`;
    } catch {
      return url;
    }
  }

  $('a[href]').each((_, el) => $(el).attr('href', proxify($(el).attr('href'))));
  $('img[src]').each((_, el) => $(el).attr('src', proxify($(el).attr('src'))));
  $('img[srcset]').each((_, el) => {
    const rewritten = $(el).attr('srcset').split(',').map(part => {
      const [u, size] = part.trim().split(/\s+/);
      return `${proxify(u)}${size ? ' ' + size : ''}`;
    }).join(', ');
    $(el).attr('srcset', rewritten);
  });
  $('script[src]').each((_, el) => $(el).attr('src', proxify($(el).attr('src'))));
  $('link[href]').each((_, el) => $(el).attr('href', proxify($(el).attr('href'))));
  $('form[action]').each((_, el) => $(el).attr('action', proxify($(el).attr('action'))));
  $('source[src]').each((_, el) => $(el).attr('src', proxify($(el).attr('src'))));
  $('video[src]').each((_, el) => $(el).attr('src', proxify($(el).attr('src'))));
  $('audio[src]').each((_, el) => $(el).attr('src', proxify($(el).attr('src'))));
  $('iframe[src]').each((_, el) => $(el).attr('src', proxify($(el).attr('src'))));
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    $(el).attr('style', style.replace(/url\(['"]?(.+?)['"]?\)/g, (_, u) => `url(${proxify(u)})`));
  });

  $('head').prepend(`<base href="${baseUrl}">`);

  // Intercept dynamic fetch and XHR inside the proxied page
  $('head').append(`
    <script>
      (function() {
        const PROXY = '/proxy?url=';

        const _fetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
          if (typeof input === 'string' && /^https?:\\/\\//.test(input)) {
            input = PROXY + encodeURIComponent(input);
          } else if (input instanceof Request && /^https?:\\/\\//.test(input.url)) {
            input = new Request(PROXY + encodeURIComponent(input.url), input);
          }
          return _fetch(input, init);
        };

        const _open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (typeof url === 'string' && /^https?:\\/\\//.test(url)) {
            url = PROXY + encodeURIComponent(url);
          }
          return _open.call(this, method, url, ...rest);
        };

        // Rewrite dynamic DOM insertions
        const _createElement = document.createElement.bind(document);
        document.createElement = function(tag) {
          const el = _createElement(tag);
          if (tag.toLowerCase() === 'script') {
            const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            Object.defineProperty(el, 'src', {
              set(val) {
                if (/^https?:\\/\\//.test(val)) val = PROXY + encodeURIComponent(val);
                desc.set.call(this, val);
              },
              get() { return desc.get.call(this); }
            });
          }
          return el;
        };
      })();
    </script>
  `);

  return $.html();
}

function rewriteCss(css, baseUrl) {
  const base = new URL(baseUrl);
  return css.replace(/url\(['"]?(.+?)['"]?\)/g, (_, u) => {
    if (u.startsWith('data:')) return `url(${u})`;
    try {
      const abs = new URL(u, base).href;
      return `url(/proxy?url=${encodeURIComponent(abs)})`;
    } catch {
      return `url(${u})`;
    }
  });
}

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Missing ?url= parameter');
  }

  let target;
  try {
    target = decodeURIComponent(targetUrl);
    new URL(target); // validate
  } catch {
    return res.status(400).send('Invalid URL');
  }

  try {
    console.log(`[proxy] → ${target}`);

    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': new URL(target).origin,
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';

    // Strip headers that would block the iframe or CSP
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');

    if (contentType.includes('text/html')) {
      const html = await response.text();
      const rewritten = rewriteUrls(html, response.url || target);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(rewritten);
    }

    if (contentType.includes('text/css')) {
      const css = await response.text();
      const rewritten = rewriteCss(css, response.url || target);
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      return res.send(rewritten);
    }

    // Everything else: pipe through directly (images, fonts, JS, etc.)
    res.setHeader('Content-Type', contentType);
    response.body.pipe(res);

  } catch (err) {
    console.error('[proxy] Error:', err.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head><style>
        body { font-family: sans-serif; padding: 40px; background: #111; color: #eee; }
        code { background: #222; padding: 2px 6px; border-radius: 4px; }
      </style></head>
      <body>
        <h2>Proxy error</h2>
        <p><code>${err.message}</code></p>
        <p>Possible reasons: the site blocks proxies, the URL is unreachable, or a timeout occurred.</p>
      </body>
      </html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy running at http://localhost:${PORT}`);
});
