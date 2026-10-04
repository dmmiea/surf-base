// SURF BASE - Service Worker for Web Push & PWA
const CACHE_NAME = 'surf-base-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// プッシュ通知受信ハンドラ（iOS 16.4+ / Android / PC 対応）
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'SURF BASE 波情報', body: event.data.text() };
    }
  }

  const title = data.title || 'SURF BASE 波情報';
  const options = {
    body: data.body || '新しいサーフィン波情報が届きました！',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || './index.html',
      spotKey: data.spotKey || null
    },
    tag: data.tag || 'surf-base-alert',
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// 通知タップ時の挙動ハンドラ
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data && event.notification.data.url 
    ? event.notification.data.url 
    : './index.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 既にアプリ画面が開いている場合はフォーカス
      for (const client of clientList) {
        if (client.url.includes('surf-base') && 'focus' in client) {
          if (event.notification.data && event.notification.data.spotKey) {
            client.postMessage({ action: 'SELECT_SPOT', spotKey: event.notification.data.spotKey });
          }
          return client.focus();
        }
      }
      // 開いていない場合は新規ウィンドウで開く
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
