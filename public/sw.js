/* LectureScribe service worker: keeps a copy of the app so it opens offline. */
var CACHE = 'lecturescribe-v1';

function timeout(ms) {
  return new Promise(function (resolve, reject) {
    setTimeout(reject, ms);
  });
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k !== CACHE;
            })
            .map(function (k) {
              return caches.delete(k);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/* The page sends the list of files it already loaded so they are saved too. */
self.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'cache' || !d.urls) {
    return;
  }
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(
        d.urls.map(function (u) {
          var same = u.indexOf(self.location.origin) === 0;
          var req = same ? u : new Request(u, { mode: 'no-cors' });
          return fetch(req)
            .then(function (res) {
              if (res && (res.ok || res.type === 'opaque')) {
                return cache.put(u, res);
              }
            })
            .catch(function () {});
        })
      );
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') {
    return;
  }
  var url = new URL(req.url);
  if (url.protocol.indexOf('http') !== 0) {
    return;
  }
  var same = url.origin === self.location.origin;
  var font =
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';
  if (!same && !font) {
    return;
  }
  if (same && url.pathname.indexOf('/api/') === 0) {
    return;
  }

  if (req.mode === 'navigate') {
    /* Network first, but fall back to the saved copy quickly on a weak
       connection so the app still opens. */
    e.respondWith(
      caches.match('/').then(function (cached) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) {
              c.put('/', copy);
            });
          }
          return res;
        });
        if (!cached) {
          return net;
        }
        return Promise.race([net, timeout(4000)]).catch(function () {
          return cached;
        });
      })
    );
    return;
  }

  /* Files: use the saved copy, refresh it in the background. */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req)
        .then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) {
              c.put(req, copy);
            });
          }
          return res;
        })
        .catch(function () {
          return hit || Response.error();
        });
      return hit || net;
    })
  );
});
