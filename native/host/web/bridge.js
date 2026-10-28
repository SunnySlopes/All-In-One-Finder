// All-In-One Finder 鈥?WebView2 host bridge.
//
// Injected before any page script. Provides:
//   window.aio            鈥?the same 11 members Electron's preload exposed
//   window.__AIO_RPC__    鈥?op transport used by src/native.ts
//   window.__AIO_B64__    鈥?base64 decoder for binary payloads
//
// Host protocol (JSON over window.chrome.webview):
//   page -> host : {channel:"op", id, op, args}        engine call (forwarded to allinone.dll)
//                  {channel:"aio", id, method, ...B64}  shell call (dialogs/session/title)
//   host -> page : {id, ok, result?}  {id, ok, bin}  {id, ok, b64}  {id, ok:false, error}
//                  {event:"session-export"|"session-import"|"show-about", textB64?}
(function () {
  var webview = window.chrome && window.chrome.webview;
  if (!webview) return;

  var boot = window.__AIO_BOOT__ || {};
  var nextId = 1;
  var pending = new Map();
  var handlers = { 'session-export': [], 'session-import': [], 'show-about': [] };

  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function bytesToB64(bytes) {
    var out = '';
    var i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    if (i + 1 === bytes.length) {
      var a = bytes[i] << 16;
      out += ALPHABET[(a >> 18) & 63] + ALPHABET[(a >> 12) & 63] + '==';
    } else if (i + 2 === bytes.length) {
      var b = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += ALPHABET[(b >> 18) & 63] + ALPHABET[(b >> 12) & 63] + ALPHABET[(b >> 6) & 63] + '=';
    }
    return out;
  }

  function b64ToBytes(text) {
    var clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '');
    var len = clean.length;
    while (len % 4 !== 0) len++;
    var out = new Uint8Array((len / 4) * 3);
    var o = 0;
    for (var i = 0; i < clean.length; i += 4) {
      var c0 = ALPHABET.indexOf(clean[i]);
      var c1 = ALPHABET.indexOf(clean[i + 1]);
      var c2 = ALPHABET.indexOf(clean[i + 2]);
      var c3 = ALPHABET.indexOf(clean[i + 3]);
      var n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3);
      if (o < out.length) out[o++] = (n >> 16) & 255;
      if (i + 2 < clean.length && clean[i + 2] !== '=' && o < out.length) out[o++] = (n >> 8) & 255;
      if (i + 3 < clean.length && clean[i + 3] !== '=' && o < out.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  }

  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  function utf8ToB64(text) { return bytesToB64(encoder.encode(String(text))); }
  function b64ToUtf8(text) { return decoder.decode(b64ToBytes(text)); }

  function send(message) {
    // Post the object itself: WebView2 delivers it as a JSON object. A JSON string
    // would arrive as an escaped string literal and the host could not read fields.
    try { webview.postMessage(message); } catch (error) { /* host gone */ }
  }

  function request(method, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      var message = { channel: 'aio', id: id, method: method };
      if (payload) for (var key in payload) message[key] = payload[key];
      send(message);
    });
  }

  webview.addEventListener('message', function (event) {
    var message = event.data;
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch (error) { return; }
    }
    if (!message || typeof message !== 'object') return;

    if (message.event) {
      var list = handlers[message.event] || [];
      var text = typeof message.textB64 === 'string' ? b64ToUtf8(message.textB64) : undefined;
      for (var i = 0; i < list.length; i++) {
        try { list[i](text); } catch (error) { /* keep other handlers alive */ }
      }
      return;
    }

    var entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (!message.ok) {
      entry.reject(new Error(message.error || 'host-error'));
      return;
    }
    if (typeof message.bin === 'string') entry.resolve(b64ToBytes(message.bin));
    else if (typeof message.b64 === 'string') entry.resolve(b64ToUtf8(message.b64));
    else entry.resolve(message.result === undefined ? null : message.result);
  });

  function sessionText(data) {
    var features = Array.isArray(data && data.features) ? data.features.join(',') : '';
    return [
      'kind=aio-session',
      'version=1',
      'seed=' + (data.seed == null ? '' : data.seed),
      'mcVersion=' + (data.mcVersion == null ? '' : data.mcVersion),
      'dim=' + (data.dim == null ? 0 : data.dim),
      'y=' + (data.y == null ? 256 : data.y),
      'largeBiomes=' + (data.largeBiomes ? 'true' : 'false'),
      'grid=' + (data.grid ? 'true' : 'false'),
      'features=' + features,
      ''
    ].join('\n');
  }

  // Surface page errors in the host log; without this a broken renderer just shows
  // a blank panel with no clue.
  function report(level, message, where) {
    var text = String(message || 'error') + (where ? ' @ ' + where : '');
    send({ channel: 'log', level: level, messageB64: utf8ToB64(text) });
  }
  window.addEventListener('error', function (event) {
    report('error', event.message, (event.filename || '') + ':' + (event.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    report('reject', (reason && (reason.stack || reason.message)) || String(reason), '');
  });

  window.aio = {
    initialLocale: boot.locale === 'zh' || boot.locale === 'en' ? boot.locale : undefined,
    hasSession: !!boot.hasSession,
    setTitle: function (title) {
      send({ channel: 'aio', id: 0, method: 'set-title', titleB64: utf8ToB64(title == null ? '' : title) });
    },
    openFile: function () { return request('open-file'); },
    saveFile: function (name, text) {
      return request('save-file', { nameB64: utf8ToB64(name), textB64: utf8ToB64(text) });
    },
    readSession: function (name) {
      return request('read-session', { nameB64: utf8ToB64(name) });
    },
    writeSession: function (name, text) {
      return request('write-session', { nameB64: utf8ToB64(name), textB64: utf8ToB64(text) });
    },
    exportSession: function (data) {
      return request('export-session', {
        jsonB64: utf8ToB64(JSON.stringify(data, null, 2)),
        txtB64: utf8ToB64(sessionText(data))
      });
    },
    onSessionExport: function (handler) { handlers['session-export'].push(handler); },
    onSessionImport: function (handler) { handlers['session-import'].push(handler); },
    onShowAbout: function (handler) { handlers['show-about'].push(handler); }
  };

  // Transport for src/native.ts: one promise per op, resolved by the engine envelope.
  window.__AIO_RPC__ = function (op, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      var message = { channel: 'op', id: id, op: op };
      if (args !== undefined) message.args = args;
      send(message);
    });
  };
  window.__AIO_B64__ = { decode: b64ToBytes };
})();


