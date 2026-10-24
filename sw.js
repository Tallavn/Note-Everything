/* Service worker: luôn lấy bản mới từ mạng trước, chỉ dùng cache khi mất mạng */
var V="noteeverything-20261024d";
self.addEventListener("install",function(){self.skipWaiting()});
self.addEventListener("activate",function(e){
  e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==V}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener("fetch",function(e){
  var r=e.request;if(r.method!=="GET"||r.url.indexOf(self.location.origin)!==0)return;
  e.respondWith(fetch(r,{cache:"no-cache"}).then(function(res){
    if(res&&res.ok){var c=res.clone();caches.open(V).then(function(ca){ca.put(r,c)})}
    return res}).catch(function(){
    return caches.match(r).then(function(m){return m||caches.match("index.html")||caches.match("./")})}))});
