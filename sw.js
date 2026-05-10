self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('push', event => {
  const d = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification(d.title || '100PT', {
    body: d.body || '', icon: '/Drink-Battle/icon.png',
    badge: '/Drink-Battle/icon.png', tag: d.tag || 'default', renotify: true
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs => {
    const c = cs.find(c => 'focus' in c);
    return c ? c.focus() : clients.openWindow('/Drink-Battle/');
  }));
});
