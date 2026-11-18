/* Family Game Night: lobby, shared state and board UI. Game rules live in games.js. */
(function () {
  'use strict';
  var WANT_MS = 2 * 3600e3;            // how long an "I'm in" stays fresh
  var BEAT_MS = 4 * 60e3;              // how often an open page says it is still here
  function hereMs() { return S.store && S.store.live ? 10 * 60e3 : 2 * 3600e3; }   // how long someone counts as in the lobby
  /* On the outside-hosted site a player is their name, so the same name on any device is the same player. */
  function idFor(name) {
    return 'n_' + Array.from(name.trim().toLowerCase()).map(function (ch) { return /[a-z0-9]/.test(ch) ? ch : '_' + ch.codePointAt(0).toString(36); }).join('');
  }
  var LEVELS = ['Easy', 'Medium', 'Hard'];
  var $ = function (s) { return document.querySelector(s); };

  var S = {
    me: { id: null, name: '' }, store: null, ready: false,
    lobby: {}, games: {}, myWant: {},
    view: 'lobby', gid: null, sel: -1, promo: null, pick: null, chosen: [], cnt: null, filter: lsGet('fgn-filter') || 'all', resignArmed: false,
    sheet: null, readOnly: false, note: '', dismissed: {}, pending: {}, aiKey: null, legal: null
  };

  /* ------------------------------------------------------------ small helpers */
  function h(tag, props) {
    var e = document.createElement(tag), k, i;
    for (k in (props || {})) {
      var v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (x) { add(e, x); }); return; }
    e.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage is optional */ } }
  function rid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  var toastTimer = 0;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }

  /* -------------------------------------------------------------------- stores */
  function localStore() {
    var lobby = {}, games = {}, onL, onG;
    return {
      shared: false,
      watch: function (l, g) { onL = l; onG = g; onL({}); onG({}); },
      setLobby: function (id, doc) { lobby[id] = doc; onL(Object.assign({}, lobby)); return Promise.resolve(); },
      saveGame: function (id, doc) { games[id] = doc; onG(Object.assign({}, games)); return Promise.resolve(); },
      leaveLobby: function (id) { delete lobby[id]; onL(Object.assign({}, lobby)); return Promise.resolve(); },
      patchGame: function (id, path, value, whole) { games[id] = whole; onG(Object.assign({}, games)); return Promise.resolve(); },
      deleteGame: function (id) { delete games[id]; onG(Object.assign({}, games)); return Promise.resolve(); }
    };
  }

  function dbStore(db) {
    var chains = {};
    function queue(key, fn) {           // one write at a time per document
      var p = (chains[key] || Promise.resolve()).catch(function () { }).then(fn);
      chains[key] = p;
      return p;
    }
    function listen(name, cb, onState) {
      var timer = setTimeout(function () { onState('slow'); }, 10000);
      db.collection(name).onSnapshot(function (snap) {
        var o = {};
        snap.docs.forEach(function (d) { o[d.id] = d.data(); });
        if (!snap.metadata || !snap.metadata.fromCache) { clearTimeout(timer); onState('ok'); }
        cb(o);
      }, function () { clearTimeout(timer); onState('lost'); });
    }
    return {
      shared: true,
      watch: function (l, g, onState) { listen('lobby', l, onState); listen('games', g, onState); },
      setLobby: function (id, doc) { return queue('l' + id, function () { return db.doc('lobby/' + id).set(doc); }); },
      saveGame: function (id, doc) { return queue('g' + id, function () { return db.doc('games/' + id).set(doc); }); },
      leaveLobby: function (id) { return queue('l' + id, function () { return db.doc('lobby/' + id).delete(); }); },
      patchGame: function (id, path, value, whole) { return queue('g' + id, function () { return db.doc('games/' + id).set(whole); }); },
      deleteGame: function (id) { return queue('g' + id, function () { return db.doc('games/' + id).delete(); }); }
    };
  }

  function writeFailed(e) {
    var code = e && e.code;
    if (code === 'invalid_argument' || code === 'not_granted' || code === 'revoked') {
      S.readOnly = true;
      S.note = 'You can watch, but this account cannot join games yet. Ask whoever shared this page to invite you as an Editor.';
    } else if (code === 'bad_code') {
      S.readOnly = true; lsSet('fgn-room', '');
      S.note = 'The family passcode has changed. Reload this page and enter the new one.';
    } else if (code === 'quota_exceeded') toast('The shared table is full. Finish or leave some old games first.');
    else toast('That did not save. Check your connection and try again.');
    render();
  }

  /* ---------------------------------------------------------------------- boot */
  function boot() {
    render();
    if (window.FGN_FIREBASE && window.FGN_FIREBASE.databaseURL) return bootOutside();
    var solo = new Promise(function (res) { $('#solo-btn').addEventListener('click', function () { res(null); }); });
    setTimeout(function () { if (!S.ready) $('#solo-btn').hidden = false; }, 3000);
    var caps = (window.claude && typeof window.claude.use === 'function')
      ? Promise.all([safeUse('db'), safeUse('user')])
      : Promise.resolve([null, null]);
    Promise.race([caps, solo]).then(function (r) {
      var db = r ? r[0] : null, user = r ? r[1] : null;
      var who = user ? Promise.all([user.me(), user.can('data.write')]) : Promise.resolve([null, null]);
      return who.then(function (w) {
        begin(db ? dbStore(db) : localStore(), db && w[0] && w[0].id, w[0] && w[0].name, w[1]);
      });
    });
  }
  function safeUse(name) {
    try { return Promise.resolve(window.claude.use(name)).catch(function () { return null; }); }
    catch (e) { return Promise.resolve(null); }
  }

  /* Outside hosting: the family passcode names the room in the database, and the database rules only open that room. */
  function roomBase(code) { return window.FGN_FIREBASE.databaseURL.replace(/\/+$/, '') + '/rooms/' + code; }
  function bootOutside() {
    var code = lsGet('fgn-room');
    if (code) tryRoom(code, true); else openCodeSheet('');
  }
  function openCodeSheet(err) {
    S.sheet = { kind: 'code', err: err }; render();
    setTimeout(function () { var i = $('#code-input'); if (i) i.focus(); }, 50);
  }
  function tryRoom(code, saved) {
    fetch(roomBase(code) + '/lobby.json?shallow=true').then(function (r) {
      if (r.ok) { lsSet('fgn-room', code); S.sheet = null; begin(fbStore(roomBase(code)), null, '', null); }
      else if (r.status === 401 || r.status === 403) openCodeSheet(saved ? 'The family passcode has changed. Enter the new one.' : 'That passcode did not work. Check it and try again.');
      else openCodeSheet('The game server did not answer. Try again in a moment.');
    }, function () { openCodeSheet('Could not reach the game server. Check your connection and try again.'); });
  }

  function fbStore(base) {
    var tree = { lobby: {}, games: {} }, onL, onG, onState, es = null, timer = 0, retry = 0;
    function emit(which) {
      if (which !== 'games') onL(Object.assign({}, tree.lobby));
      if (which !== 'lobby') onG(Object.assign({}, tree.games));
    }
    function setAt(path, data, merge) {
      var parts = path.split('/').filter(Boolean), k;
      if (!parts.length) {
        if (merge) { for (k in (data || {})) setAt('/' + k, data[k], false); }
        else tree = { lobby: (data && data.lobby) || {}, games: (data && data.games) || {} };
        return '';
      }
      var node = tree;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        else if (i > 0) node[parts[i]] = clone(node[parts[i]]);
        node = node[parts[i]];
      }
      k = parts[parts.length - 1];
      if (merge && data && typeof data === 'object') {
        var cur = (node[k] && typeof node[k] === 'object') ? clone(node[k]) : {};
        for (var c in data) { if (data[c] === null) delete cur[c]; else cur[c] = data[c]; }
        node[k] = cur;
      } else if (data === null || data === undefined) delete node[k];
      else node[k] = data;
      if (!tree.lobby) tree.lobby = {};
      if (!tree.games) tree.games = {};
      return parts[0];
    }
    function connect() {
      clearTimeout(retry);
      if (es) es.close();
      clearTimeout(timer);
      timer = setTimeout(function () { onState('slow'); }, 10000);
      es = new EventSource(base + '.json');
      var on = function (merge) {
        return function (e) {
          var d; try { d = JSON.parse(e.data); } catch (x) { return; }
          clearTimeout(timer); onState('ok');
          emit(setAt(d.path || '/', d.data, merge));
        };
      };
      es.addEventListener('put', on(false));
      es.addEventListener('patch', on(true));
      es.addEventListener('cancel', function () { es.close(); onState('lost'); });
      es.onerror = function () {
        if (es.readyState !== 2) return;            // the browser is already reconnecting by itself
        onState('retry'); retry = setTimeout(connect, 5000);
      };
    }
    function send(method, path, doc, keep) {
      return fetch(base + path + '.json', { method: method, keepalive: !!keep, body: doc === undefined ? undefined : JSON.stringify(doc) }).then(function (r) {
        if (!r.ok) throw { code: (r.status === 401 || r.status === 403) ? 'bad_code' : 'unavailable' };
      }, function () { throw { code: 'unavailable' }; });
    }
    var chains = {};
    function queue(key, fn) { var p = (chains[key] || Promise.resolve()).catch(function () { }).then(fn); chains[key] = p; return p; }
    return {
      shared: true, live: true,
      watch: function (l, g, st) {
        onL = l; onG = g; onState = st; connect();
        document.addEventListener('visibilitychange', function () { if (!document.hidden && es && es.readyState === 2) connect(); });
      },
      setLobby: function (id, doc) { setAt('/lobby/' + id, doc, false); return queue('l' + id, function () { return send('PUT', '/lobby/' + id, doc); }); },
      saveGame: function (id, doc) { setAt('/games/' + id, doc, false); return queue('g' + id, function () { return send('PUT', '/games/' + id, doc); }); },
      patchGame: function (id, path, value) {
        var p = '/games/' + id + '/' + path.join('/');
        setAt(p, value, false);
        return queue('p' + p, function () { return send('PUT', p, value); });
      },
      leaveLobby: function (id, closing) {
        setAt('/lobby/' + id, null, false);
        if (closing) return send('DELETE', '/lobby/' + id, undefined, true).catch(function () { });
        return queue('l' + id, function () { return send('DELETE', '/lobby/' + id); });
      },
      deleteGame: function (id) { setAt('/games/' + id, null, false); return queue('g' + id, function () { return send('DELETE', '/games/' + id); }); }
    };
  }

  function begin(store, uid, defName, can) {
    S.me.name = (lsGet('fgn-name') || defName || '').slice(0, 24);
    S.fixedId = uid || null;
    if (uid) S.me.id = uid;
    else if (store.live) S.me.id = S.me.name ? idFor(S.me.name) : '';
    else { S.me.id = lsGet('fgn-id') || rid('x'); lsSet('fgn-id', S.me.id); }
    try { JSON.parse(lsGet('fgn-dismissed') || '[]').forEach(function (id) { S.dismissed[id] = 1; }); } catch (e) { /* ignore */ }
    S.store = store;
    if (!store.shared) S.note = 'Solo table. This view is not connected to the shared lobby, so you can play the AI here but family will not see you.';
    else if (can === false) {
      S.readOnly = true;
      S.note = 'You can watch, but this account cannot join games yet. Ask whoever shared this page to invite you as an Editor.';
    }
    S.ready = true;
    S.store.watch(onLobby, onGames, function (state) {
      if (state === 'slow') S.note = 'Still reaching the shared lobby. What you see may be out of date.';
      else if (state === 'retry') S.note = 'Reconnecting to the shared lobby…';
      else if (state === 'lost') S.note = 'Lost the connection to the shared lobby. Close and reopen this page to rejoin.';
      else if (/shared lobby/.test(S.note) && S.store.shared) S.note = '';
      else return;
      render();
    });
    if (!S.me.name) openNameSheet(); else checkIn();
    if (store.live) {
      setTimeout(checkIn, 3000);              // a reload's goodbye can land after the first hello
      setInterval(function () { if (!document.hidden) checkIn(); }, BEAT_MS);
      window.addEventListener('pagehide', function () { if (S.me.id && S.me.name) S.store.leaveLobby(S.me.id, true); });
      window.addEventListener('pageshow', function (e) { if (e.persisted) checkIn(); });
    }
    document.addEventListener('visibilitychange', function () {
      var mine = S.lobby[S.me.id];
      if (!document.hidden && S.me.name && (!mine || Date.now() - mine.seen > 15 * 60e3)) checkIn();
    });
    render();
  }

  function checkIn() {
    if (S.readOnly || !S.me.name || !S.me.id) return;
    var doc = { name: S.me.name, seen: Date.now(), want: clone(S.myWant) };
    S.lobby = Object.assign({}, S.lobby); S.lobby[S.me.id] = doc;
    S.store.setLobby(S.me.id, doc).catch(writeFailed);
  }

  function onLobby(o) {
    S.lobby = o;
    var mine = o[S.me.id];
    if (mine && mine.want) S.myWant = clone(mine.want);
    render();
  }

  function onGames(o) {
    var cur = S.gid && S.games[S.gid];
    if (cur && S.pending[S.gid] && o[S.gid] && o[S.gid].n < cur.n) { o = Object.assign({}, o); o[S.gid] = cur; }
    S.games = o;
    pullIn();
    render();
    driveAI();
  }

  /* Bring this player into a game someone started with them in it. */
  function pullIn() {
    if (S.sheet && S.sheet.kind !== 'start') return;
    var cur = S.gid && S.games[S.gid];
    if (S.view === 'game' && cur && cur.status === 'active') return;
    var best = null, id;
    for (id in S.games) {
      var g = S.games[id];
      if (!g || g.status !== 'active' || S.dismissed[id] || !GAMES[g.type]) continue;
      if (!g.players.some(function (p) { return p.id === S.me.id; })) continue;
      if (!best || g.created > S.games[best].created) best = id;
    }
    if (!best) return;
    var b = S.games[best];
    if (b.host !== S.me.id) {
      var host = b.players.filter(function (p) { return p.id === b.host; })[0];
      toast((host ? host.name : 'Someone') + ' started ' + GAMES[b.type].name + '. You are in.');
    }
    S.sheet = null;
    openGame(best);
    if (S.myWant[b.type]) setWant(b.type, false);
  }

  /* --------------------------------------------------------------------- lobby */
  function people() {
    var now = Date.now(), out = [], id;
    for (id in S.lobby) {
      var d = S.lobby[id];
      if (!d || now - (d.seen || 0) > hereMs()) continue;
      out.push({ id: id, name: String(d.name || 'Someone').slice(0, 24), want: d.want || {} });
    }
    if (S.me.id && !out.some(function (p) { return p.id === S.me.id; }))
      out.push({ id: S.me.id, name: S.me.name || 'You', want: S.myWant });
    out.sort(function (a, b) { return (b.id === S.me.id) - (a.id === S.me.id) || a.name.localeCompare(b.name); });
    return out;
  }
  function wants(p, type) { return !!p.want[type] && Date.now() - p.want[type] < WANT_MS; }

  function setWant(type, on) {
    if (on) S.myWant[type] = Date.now(); else delete S.myWant[type];
    checkIn();
    render();
  }

  function pname(p) { return p.ai ? (p.name || LEVELS[p.level] + ' AI') : (p.id === S.me.id ? (S.me.name || p.name) : p.name) || 'Player'; }
  function versus(g) { return g.players.map(pname).join(' vs '); }

  function renderLobby() {
    var ps = people(), root = $('#lobby');
    var kids = [];

    kids.push(h('section', { class: 'here' },
      h('h2', { class: 'label', text: 'In the lobby' }),
      h('div', { class: 'chips' }, ps.map(function (p) {
        var mine = p.id === S.me.id;
        return h('span', { class: 'chip' + (mine ? ' me' : '') }, p.name, mine ? h('em', { text: 'you' }) : null,
          !mine && !S.readOnly ? h('button', { class: 'x', type: 'button', title: 'Remove ' + p.name + ' from the lobby', 'aria-label': 'Remove ' + p.name + ' from the lobby',
            onclick: function () { dropFromLobby(p.id); } }, '\u00D7') : null);
      }))));

    var CATS = [['all', 'All games'], ['classic', 'Classic board games'], ['cards', 'Card games'], ['young', 'Games for young people'], ['modern', 'Modern board games']];
    if (!CATS.some(function (c) { return c[0] === S.filter; })) S.filter = 'all';
    var inCat = function (t, cat) { return cat === 'all' || (GAMES[t].cats || []).indexOf(cat) >= 0; };
    var shown = Object.keys(GAMES).filter(function (t) { return inCat(t, S.filter); });
    var waitingElsewhere = Object.keys(GAMES).filter(function (t) {
      return !inCat(t, S.filter) && ps.some(function (p) { return p.id !== S.me.id && wants(p, t); });
    });
    kids.push(h('section', { class: 'shelf' },
      h('div', { class: 'filters', role: 'group', 'aria-label': 'Show games' }, CATS.map(function (cat) {
        var count = Object.keys(GAMES).filter(function (t) { return inCat(t, cat[0]); }).length;
        return h('button', { class: 'filter', type: 'button', id: 'filter-' + cat[0], 'aria-pressed': S.filter === cat[0] ? 'true' : 'false',
          onclick: function () { S.filter = cat[0]; lsSet('fgn-filter', cat[0]); render(); } }, cat[1], h('em', { text: String(count) }));
      })),
      waitingElsewhere.length ? h('button', { class: 'elsewhere', type: 'button', onclick: function () { S.filter = 'all'; lsSet('fgn-filter', 'all'); render(); } },
        'Someone wants to play ' + waitingElsewhere.map(function (t) { return GAMES[t].name; }).join(', ') + '. Show all games.') : null,
      h('div', { class: 'tables' }, shown.map(function (type) {
      var G = GAMES[type], inList = ps.filter(function (p) { return wants(p, type); });
      var mine = inList.some(function (p) { return p.id === S.me.id; });
      var others = inList.filter(function (p) { return p.id !== S.me.id; });
      var startText = others.length === 0 ? (G.noAI ? 'Start game' : 'Play the AI') : others.length === 1 ? 'Start with ' + others[0].name : 'Start game';
      return h('article', { class: 'table t-' + type },
        h('div', { class: 'table-head' },
          h('span', { class: 'mark', 'aria-hidden': 'true' }),
          h('div', null, h('h3', { text: G.name }), G.like ? h('span', { class: 'like', text: 'Similar to ' + G.like }) : null, h('p', { text: G.blurb }))),
        h('div', { class: 'waiting' },
          h('span', { class: 'label', text: 'Wants to play' }),
          inList.length
            ? h('div', { class: 'chips' }, inList.map(function (p) { return h('span', { class: 'chip ready' + (p.id === S.me.id ? ' me' : '') }, p.name); }))
            : h('span', { class: 'none', text: 'Nobody yet' })),
        h('div', { class: 'row' },
          h('button', { class: 'btn toggle', id: 'want-' + type, 'aria-pressed': mine ? 'true' : 'false', disabled: S.readOnly, onclick: function () { setWant(type, !mine); } },
            mine ? 'I’m in ✓' : 'I’m in'),
          h('button', { class: 'btn primary', id: 'start-' + type, disabled: S.readOnly, onclick: function () { openStartSheet(type); } }, startText)));
      }))));

    var live = Object.keys(S.games).filter(function (id) { var g = S.games[id]; return g && g.status === 'active' && GAMES[g.type]; })
      .sort(function (a, b) { return S.games[b].updated - S.games[a].updated; });
    kids.push(h('section', { class: 'live' },
      h('h2', { class: 'label', text: 'Games in progress' }),
      live.length ? h('ul', null, live.map(function (id) {
        var g = S.games[id], mine = g.players.some(function (p) { return p.id === S.me.id; });
        return h('li', null,
          h('div', null, h('strong', { text: GAMES[g.type].name }), h('span', { text: versus(g) })),
          h('button', { class: 'btn small', onclick: function () { delete S.dismissed[id]; saveDismissed(); openGame(id); } }, mine ? 'Resume' : 'Watch'));
      })) : h('p', { class: 'none', text: 'No games right now. Tap “I’m in” on a table so others know you want to play, or start one yourself.' })));

    root.replaceChildren.apply(root, kids);
  }

  /* -------------------------------------------------------------------- sheets */
  function leaveLobbyAs(id) {
    if (!id) return;
    S.lobby = Object.assign({}, S.lobby); delete S.lobby[id];
    if (!S.readOnly) S.store.leaveLobby(id).catch(function () { });
  }
  function dropFromLobby(id) { leaveLobbyAs(id); render(); }
  function signOut() {
    leaveLobbyAs(S.me.id);
    S.me.name = ''; lsSet('fgn-name', ''); S.myWant = {};
    if (S.store.live && !S.fixedId) S.me.id = '';
    S.view = 'lobby'; S.gid = null;
    openNameSheet();
  }
  function openNameSheet() { S.sheet = { kind: 'name' }; render(); setTimeout(function () { var i = $('#name-input'); if (i) i.focus(); }, 50); }

  function openStartSheet(type) {
    var others = people().filter(function (p) { return p.id !== S.me.id && wants(p, type); });
    var G = GAMES[type], picks = others.slice(0, G.max - 1).map(function (p) { return p.id; });
    S.sheet = { kind: 'start', type: type, picks: picks, ais: (!G.noAI && picks.length + 1 < G.min) ? [1] : [], first: true, partner: 0, opts: {} };
    render();
  }

  function renderSheet() {
    var wrap = $('#sheet'), sh = S.sheet;
    if (!sh) { wrap.hidden = true; wrap.replaceChildren(); return; }
    wrap.hidden = false;
    var card;
    if (sh.kind === 'code') {
      var cin = h('input', { id: 'code-input', type: 'text', maxlength: '40', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
      card = h('form', { class: 'card', onsubmit: function (ev) {
        ev.preventDefault();
        var v = cin.value.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!v) { cin.focus(); return; }
        S.sheet = null; render(); tryRoom(v, false);
      } },
        h('h2', { text: 'Family passcode' }),
        h('p', { text: 'Enter the passcode that came with this link. You only need to do this once on each device.' }),
        h('label', { for: 'code-input', class: 'label', text: 'Passcode' }), cin,
        sh.err ? h('p', { class: 'hint', text: sh.err }) : null,
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', type: 'submit' }, 'Enter')));
    } else if (sh.kind === 'name') {
      var had = S.me.name;
      var input = h('input', { id: 'name-input', type: 'text', maxlength: '24', autocomplete: 'off', placeholder: 'Grandma, Dad, AJ…', value: sh.clash || had });
      var save = function (ev) {
        ev.preventDefault();
        var v = input.value.trim().slice(0, 24);
        if (!v) { input.focus(); return; }
        var byName = S.store.live && !S.fixedId, nid = byName ? idFor(v) : S.me.id, there = S.lobby[nid];
        if (byName && nid !== S.me.id && sh.clash !== v && there && Date.now() - (there.seen || 0) < hereMs()) { sh.clash = v; return render(); }
        if (byName && there && there.name) v = String(there.name).slice(0, 24);   // keep the spelling already in use
        if (had && nid !== S.me.id) leaveLobbyAs(S.me.id);
        if (nid !== S.me.id) { S.myWant = {}; S.view = 'lobby'; S.gid = null; }
        S.me.id = nid; S.me.name = v; lsSet('fgn-name', v); S.sheet = null;
        checkIn(); pullIn(); render();
      };
      card = h('form', { class: 'card', onsubmit: save },
        h('h2', { text: had ? 'Change player' : 'What should we call you?' }),
        h('p', { text: had
          ? 'You are playing as ' + had + '. Enter another name to switch players, or sign out on this device.'
          : 'This is the name the family sees. Use the same name on every device and your games follow you.' }),
        h('label', { for: 'name-input', class: 'label', text: 'Your name' }), input,
        sh.clash ? h('p', { class: 'hint', text: sh.clash + ' is in the lobby right now. If that is you on another device, carry on. If not, pick a different name.' }) : null,
        h('div', { class: 'row end' },
          had ? h('button', { class: 'btn ghost', type: 'button', id: 'sign-out', onclick: signOut }, 'Sign out') : null,
          had ? h('button', { class: 'btn ghost', type: 'button', onclick: function () { S.sheet = null; render(); } }, 'Cancel') : null,
          h('button', { class: 'btn primary', type: 'submit' }, sh.clash ? 'Yes, that is me' : had ? 'Switch' : 'Join the lobby')));
    } else {
      var G = GAMES[sh.type];
      var others = people().filter(function (p) { return p.id !== S.me.id && wants(p, sh.type); });
      sh.picks = sh.picks.filter(function (id) { return others.some(function (p) { return p.id === id; }); });
      var count = 1 + sh.picks.length + sh.ais.length, ok = count >= G.min && count <= G.max;
      var makeRoom = function () {           // keep the table at or under its seat limit
        while (1 + sh.picks.length + sh.ais.length > G.max - 1) {
          if (sh.ais.length) sh.ais.pop(); else if (sh.picks.length) sh.picks.pop(); else break;
        }
      };
      var seatWord = G.min === G.max ? G.min + ' players' : G.min + ' to ' + G.max + ' players';
      card = h('div', { class: 'card' },
        h('h2', { text: 'Start ' + G.name }),
        h('p', { text: seatWord + '. Everyone you pick is brought straight to the board.' }),
        h('ul', { class: 'seats' },
          h('li', null, h('span', { class: 'seat-name', text: S.me.name }), h('em', { text: 'you' })),
          others.map(function (p, i) {
            var on = sh.picks.indexOf(p.id) >= 0, cid = 'pick-' + i;
            return h('li', null,
              h('input', { type: 'checkbox', id: cid, checked: on, onchange: function () {
                if (on) sh.picks = sh.picks.filter(function (x) { return x !== p.id; });
                else { makeRoom(); sh.picks.push(p.id); }
                render();
              } }),
              h('label', { for: cid, class: 'seat-name', text: p.name }), h('em', { text: 'wants to play' }));
          }),
          sh.ais.map(function (lv, i) {
            var sid = 'ai-level-' + i;
            var sel = h('select', { id: sid, 'aria-label': 'AI skill', onchange: function () { sh.ais[i] = +sel.value; } },
              LEVELS.map(function (n, k) { return h('option', { value: String(k), selected: k === lv }, n); }));
            return h('li', null, h('span', { class: 'seat-name', text: 'AI player' }), sel,
              h('button', { class: 'btn small ghost', type: 'button', onclick: function () { sh.ais.splice(i, 1); render(); } }, 'Remove'));
          })),
        G.noAI ? null : h('button', { class: 'btn ghost', type: 'button', id: 'add-ai', onclick: function () { makeRoom(); sh.ais.push(1); render(); } }, '+ Add an AI player'),
        (G.teams && count === 4) ? (function () {
          var names = sh.picks.map(function (id) { var p = others.filter(function (o) { return o.id === id; })[0]; return p ? p.name : 'Player'; })
            .concat(sh.ais.map(function (lv) { return LEVELS[lv] + ' AI'; }));
          if (!(sh.partner < names.length)) sh.partner = 0;
          var ps = h('select', { id: 'partner', onchange: function () { sh.partner = +ps.value; } },
            names.map(function (n, k) { return h('option', { value: String(k), selected: k === sh.partner }, n); }));
          return h('div', { class: 'first' }, h('label', { for: 'partner', text: 'My partner' }), ps);
        })() : null,
        G.realtime ? null : h('div', { class: 'first' },
          h('input', { type: 'checkbox', id: 'go-first', checked: sh.first, onchange: function () { sh.first = !sh.first; render(); } }),
          h('label', { for: 'go-first', text: G.firstLabel || (G.seats[0] ? 'I move first, as ' + G.seats[0] : 'I take the first turn') })),
        (G.options || []).map(function (o) {
          if (o.choices) {
            if (!o.choices.some(function (c) { return c[0] === sh.opts[o.key]; })) sh.opts[o.key] = o.choices[0][0];
            var pickEl = h('select', { id: 'opt-' + o.key, onchange: function () { sh.opts[o.key] = pickEl.value; } },
              o.choices.map(function (c) { return h('option', { value: c[0], selected: c[0] === sh.opts[o.key] }, c[1]); }));
            return h('div', { class: 'first' }, h('label', { for: 'opt-' + o.key, text: o.label }), pickEl);
          }
          var off = !!o.needs && !sh.opts[o.needs];
          if (off) sh.opts[o.key] = false;
          return h('div', { class: 'first' },
            h('input', { type: 'checkbox', id: 'opt-' + o.key, checked: !!sh.opts[o.key], disabled: off, onchange: function () { sh.opts[o.key] = !sh.opts[o.key]; render(); } }),
            h('label', { for: 'opt-' + o.key, class: off ? 'off' : null, text: o.label }));
        }),
        ok ? null : h('p', { class: 'hint', text: count < G.min ? (G.noAI ? 'This game needs another person. Ask someone to tap \u201cI\u2019m in\u201d on it.' : 'Pick someone who wants to play, or add an AI player.') : 'That is too many players for ' + G.name + '.' }),
        h('div', { class: 'row end' },
          h('button', { class: 'btn ghost', type: 'button', onclick: function () { S.sheet = null; render(); } }, 'Cancel'),
          h('button', { class: 'btn primary', type: 'button', id: 'start-go', disabled: !ok, onclick: function () { startGame(sh, others); } }, 'Start game')));
    }
    wrap.replaceChildren(card);
  }

  function startGame(sh, others) {
    var G = GAMES[sh.type];
    var rest = sh.picks.map(function (id) {
      var p = others.filter(function (o) { return o.id === id; })[0];
      return { id: id, name: p ? p.name : 'Player', ai: false, level: 0 };
    }).concat(sh.ais.map(function (lv, i) {
      var twin = sh.ais.filter(function (x, k) { return x === lv && k < i; }).length;
      return { id: 'ai' + i, name: LEVELS[lv] + ' AI' + (twin ? ' ' + (twin + 1) : ''), ai: true, level: lv };
    }));
    if (G.teams && rest.length === 3) {            // partners sit across from each other
      var mate = rest.splice(sh.partner < 3 ? sh.partner : 0, 1)[0];
      rest = [rest[0], mate, rest[1]];
    }
    var me = { id: S.me.id, name: S.me.name, ai: false, level: 0 };
    createGame(sh.type, sh.first ? [me].concat(rest) : rest.concat([me]), sh.opts);
    if (S.myWant[sh.type]) setWant(sh.type, false);
  }

  function createGame(type, players, opts) {
    var now = Date.now(), id = rid('g'), old;
    for (old in S.games) {             // tidy up: finished games after 12 hours, abandoned ones after a week
      var o = S.games[old];
      if (o && ((o.status !== 'active' && now - o.updated > 12 * 3600e3) || now - o.updated > 7 * 24 * 3600e3))
        S.store.deleteGame(old).catch(function () { });
    }
    var g = { type: type, status: 'active', players: players, state: GAMES[type].init(players.length, opts || {}), host: S.me.id, created: now, updated: now, n: 0, result: null };
    S.sheet = null;
    commit(id, g);
    openGame(id);
  }

  /* ---------------------------------------------------------------------- game */
  function saveDismissed() { lsSet('fgn-dismissed', JSON.stringify(Object.keys(S.dismissed).slice(-60))); }

  function openGame(id) {
    S.view = 'game'; S.gid = id; S.sel = -1; S.promo = null; S.pick = null; S.chosen = []; S.resignArmed = false; S.aiKey = null;
    render(); driveAI();
  }
  function toLobby() {
    if (S.gid) { S.dismissed[S.gid] = 1; saveDismissed(); }
    S.view = 'lobby'; S.gid = null; S.sel = -1; S.promo = null; S.pick = null;
    render();
  }

  function commit(id, g) {
    var prev = S.games[id];
    S.games = Object.assign({}, S.games); S.games[id] = g;
    S.pending[id] = (S.pending[id] || 0) + 1;
    S.store.saveGame(id, g).then(function () { S.pending[id]--; }, function (e) {
      S.pending[id]--;
      if (S.games[id] === g) { S.games = Object.assign({}, S.games); if (prev) S.games[id] = prev; else delete S.games[id]; }
      writeFailed(e);
    });
    render();
  }

  function legalMoves(g) {
    var key = S.gid + ':' + g.n;
    if (!S.legal || S.legal.key !== key) S.legal = { key: key, moves: GAMES[g.type].moves(g.state) };
    return S.legal.moves;
  }

  function applyMove(id, move) {
    var g = S.games[id];
    if (!g || g.status !== 'active' || !move) return;
    var G = GAMES[g.type], ng = clone(g);
    try { ng.state = G.play(g.state, move); } catch (e) { return; }
    ng.n = g.n + 1; ng.updated = Date.now();
    var out = G.outcome(ng.state);
    if (out) { ng.status = 'done'; ng.result = out; }
    S.sel = -1; S.promo = null; S.pick = null; S.chosen = [];
    commit(id, ng);
    driveAI();
  }

  function tap(idx) {
    var g = S.games[S.gid];
    if (!g || g.status !== 'active' || S.readOnly) return;
    var seat = g.players.findIndex(function (p) { return p.id === S.me.id; });
    if (seat !== g.state.turn) return;
    var moves = legalMoves(g);
    if (S.sel >= 0) {
      var hit = moves.filter(function (m) { return m.from === S.sel && m.to === idx; });
      if (hit.length === 1) return applyMove(S.gid, hit[0]);
      if (hit.length > 1) { S.promo = { from: S.sel, to: idx }; return render(); }
    }
    if (g.state.cont >= 0) return;                     // mid-jump in checkers: the same piece must keep going
    S.promo = null;
    S.sel = (S.sel !== idx && moves.some(function (m) { return m.from === idx; })) ? idx : -1;
    render();
  }

  /* AI turns are played by the game's host; another player picks them up if the host has gone quiet. */
  var worker = null, jobs = {}, jobId = 0;
  function think(type, state, level) {
    return new Promise(function (res) {
      var direct = function () { setTimeout(function () { res(GAMES[type].ai(state, level)); }, 30); };
      try {
        if (worker === null) {
          worker = new Worker('games.js');
          worker.onmessage = function (e) { var cb = jobs[e.data.id]; delete jobs[e.data.id]; if (cb) cb(e.data.move); };
          worker.onerror = function () { var old = jobs; jobs = {}; worker = false; for (var k in old) old[k](null); };
        }
        if (!worker) return direct();
        var id = ++jobId;
        jobs[id] = function (mv) { if (mv) res(mv); else direct(); };
        worker.postMessage({ id: id, type: type, state: state, level: level });
      } catch (e) { worker = false; direct(); }
    });
  }

  function aiDelay(g) { var d = GAMES[g.type].aiDelay; return typeof d === 'function' ? d(g.state) : (d || 500); }

  function driveAI() {
    var gid = S.gid, g = gid && S.games[gid];
    if (S.view !== 'game' || !g || g.status !== 'active' || S.readOnly) return;
    var p = g.players[g.state.turn];
    if (!p || !p.ai || !g.players.some(function (q) { return q.id === S.me.id; })) return;
    var key = gid + ':' + g.n;
    if (S.aiKey === key) return;
    S.aiKey = key;
    var still = function () { var c = S.games[gid]; return S.view === 'game' && S.gid === gid && c && c.status === 'active' && gid + ':' + c.n === key; };
    setTimeout(function () {
      if (!still()) { if (S.aiKey === key) S.aiKey = null; return; }
      var c = S.games[gid];
      think(c.type, clone(c.state), p.level).then(function (mv) {
        if (!still()) { if (S.aiKey === key) S.aiKey = null; return; }
        applyMove(gid, mv);
      });
    }, g.host === S.me.id ? aiDelay(g) : 8000 + aiDelay(g));
  }

  function resign(seat) {
    var g = S.games[S.gid];
    if (!g || g.status !== 'active') return;
    if (!S.resignArmed) {
      S.resignArmed = true; render();
      setTimeout(function () { if (S.resignArmed) { S.resignArmed = false; render(); } }, 4000);
      return;
    }
    S.resignArmed = false;
    var ng = clone(g);
    ng.status = 'done';
    ng.result = g.players.length === 2 ? { winner: 1 - seat, reason: 'resignation' } : { winner: -2, reason: S.me.name }; ng.n = g.n + 1; ng.updated = Date.now();
    commit(S.gid, ng);
  }

  function rematch() {
    var g = S.games[S.gid];
    if (!g) return;
    S.dismissed[S.gid] = 1; saveDismissed();
    var ps = clone(g.players);
    ps.push(ps.shift());                 // the next player in line gets the first turn
    createGame(g.type, ps, g.state.opts);
  }

  function statusText(g, seat) {
    var G = GAMES[g.type];
    if (g.status !== 'active') {
      var r = g.result || { winner: -1, reason: '' };
      if (r.winner === -2) return r.reason + ' ended the game early.';
      if (r.winner < 0) return 'Draw: ' + r.reason + '.';
      if (r.team && r.team.length > 1) return (r.team.indexOf(seat) >= 0 ? 'Your team wins' : r.team.map(function (i) { return pname(g.players[i]); }).join(' and ') + ' win') + ' by ' + r.reason + '.';
      return (r.winner === seat ? 'You win' : pname(g.players[r.winner]) + ' wins') + ' by ' + r.reason + '.';
    }
    var p = g.players[g.state.turn], check = G.alert(g.state) >= 0 ? ' Check.' : '';
    if (!p) return seat >= 0 && G.hint ? G.hint(g.state) : 'Game in progress.';
    if (p.ai) return pname(p) + (G.ui === 'cards' && g.state.phase === 'show' ? ' deals next.' : G.ui === 'cards' && g.state.phase === 'count' ? ' is counting.' : ' is thinking\u2026') + check;
    if (g.state.turn === seat && S.pick) return 'Now choose a row for those tiles.';
    if (g.state.turn === seat && G.hint) return G.hint(g.state);
    if (G.ui === 'cards' && g.state.phase === 'count') return pname(p) + ' is counting.' + check;
    if (g.state.turn === seat) return (g.state.cont >= 0 ? 'Keep jumping with the same piece.' : 'Your move.') + check;
    return 'Waiting for ' + pname(p) + '.' + check;
  }

  function squareName(i) { return 'abcdefgh'[i & 7] + (8 - (i >> 3)); }

  function renderGame() {
    var g = S.games[S.gid], root = $('#game');
    if (!g || !GAMES[g.type]) { S.view = 'lobby'; S.gid = null; return render(); }
    var G = GAMES[g.type], st = g.state, active = g.status === 'active';
    var seat = g.players.findIndex(function (p) { return p.id === S.me.id; });
    if (G.ui !== 'snap') delete root.dataset.snap;
    if (G.ui === 'snap') return renderSnap(root, g, G, seat);
    if (G.ui === 'fish') return renderFish(root, g, G, seat);
    if (G.ui === 'flag') return renderFlag(root, g, G, seat);
    if (G.ui === 'rails') return renderRails(root, g, G, seat);
    if (G.ui === 'faces') return renderFaces(root, g, G, seat);
    if (G.ui === 'draft') return renderDraft(root, g, G, seat);
    if (G.ui === 'cards') return renderCards(root, g, G, seat);
    var flip = seat === 1, myTurn = active && seat === st.turn && !S.readOnly;
    var moves = myTurn ? legalMoves(g) : [];
    if (myTurn && st.cont >= 0) S.sel = st.cont;
    if (!myTurn) S.sel = -1;
    var dests = {}, movable = {}, alertSq = G.alert(st);
    moves.forEach(function (m) { movable[m.from] = 1; if (m.from === S.sel) dests[m.to] = 1; });

    var bar = function (s) {
      var p = g.players[s], on = active && st.turn === s;
      return h('div', { class: 'bar' + (on ? ' on' : '') },
        h('span', { class: 'swatch s' + s + ' g-' + g.type, 'aria-hidden': 'true' }),
        h('div', { class: 'who' }, h('strong', { text: pname(p) + (s === seat ? ' (you)' : '') }), h('span', { text: G.seats[s] + (on ? ', to move' : '') })),
        h('span', { class: 'tally', text: G.tally(st, s) }));
    };

    var board = h('div', { class: 'board g-' + g.type, role: 'grid', 'aria-label': G.name + ' board' });
    for (var i = 0; i < 64; i++) {
      (function (idx) {
        var r = idx >> 3, c = idx & 7, pc = G.piece(st, idx);
        var cls = 'sq ' + ((r + c) % 2 ? 'dk' : 'lt');
        if (st.last && (st.last.from === idx || st.last.to === idx)) cls += ' last';
        if (idx === S.sel) cls += ' sel';
        if (idx === alertSq) cls += ' alert';
        if (movable[idx]) cls += ' can';
        var label = squareName(idx) + (pc ? ', ' + G.seats[pc.seat] + ' ' + (pc.kind || (pc.king ? 'king' : 'piece')) : '');
        var b = h('button', { class: cls, type: 'button', 'aria-label': label, onclick: function () { tap(idx); } });
        if (pc) b.appendChild(pc.glyph
          ? h('span', { class: 'cp s' + pc.seat, text: pc.glyph })
          : h('span', { class: 'disc s' + pc.seat + (pc.king ? ' king' : '') }));
        if (dests[idx]) b.appendChild(h('span', { class: 'dot' + (pc ? ' ring' : '') }));
        board.appendChild(b);
      })(flip ? 63 - i : i);
    }

    var promo = null;
    if (S.promo) {
      var pr = S.promo;
      promo = h('div', { class: 'promo' }, h('span', { text: 'Promote to' }),
        [['Q', 'Queen'], ['R', 'Rook'], ['B', 'Bishop'], ['N', 'Knight']].map(function (k) {
          return h('button', { class: 'btn small', type: 'button', onclick: function () { applyMove(S.gid, { from: pr.from, to: pr.to, promo: k[0] }); } }, k[1]);
        }));
    }

    root.replaceChildren.apply(root, [
      h('div', { class: 'game-top' },
        h('button', { class: 'btn small ghost', type: 'button', onclick: toLobby }, '← Lobby'),
        h('h2', { text: G.name }),
        seat < 0 ? h('span', { class: 'chip', text: 'Watching' }) : h('span')),
      bar(flip ? 0 : 1),
      board,
      bar(flip ? 1 : 0),
      promo,
      footer(g, seat)
    ].flat().filter(Boolean));
  }


  function footer(g, seat) {
    var active = g.status === 'active', two = g.players.length === 2;
    var quit = S.resignArmed ? (two ? 'Tap again to resign' : 'Tap again to end it for everyone') : (two ? 'Resign' : 'End game');
    return [
      h('p', { class: 'status' + (active ? '' : ' over'), role: 'status', text: statusText(g, seat) }),
      h('div', { class: 'row end' },
        active && seat >= 0 && !S.readOnly ? h('button', { class: 'btn ghost' + (S.resignArmed ? ' danger' : ''), type: 'button', onclick: function () { resign(seat); } }, quit) : null,
        !active && seat >= 0 && !S.readOnly ? h('button', { class: 'btn primary', type: 'button', onclick: rematch }, two && GAMES[g.type].seats.length ? 'Rematch, swap sides' : 'Play again') : null,
        !active ? h('button', { class: 'btn', type: 'button', onclick: toLobby }, 'Back to lobby') : null)
    ];
  }

  /* ----------------------------------------------------- tile-drafting games */
  function tile(c, extra) { return h('span', { class: 'tl c' + c + (extra || '') }); }

  function renderDraft(root, g, G, seat) {
    var st = g.state, active = g.status === 'active';
    var myTurn = active && seat === st.turn && !S.readOnly;
    var moves = myTurn ? legalMoves(g) : [];
    if (!myTurn) S.pick = null;
    var pick = S.pick, okRow = {};
    if (pick) moves.forEach(function (m) { if (m.src === pick.src && m.color === pick.color) okRow[m.row] = m; });

    var pool = function (counts, src, label) {
      var kids = [];
      if (src < 0 && st.mk) kids.push(h('span', { class: 'tl mk', title: 'First-turn marker', 'aria-label': 'First-turn marker' }, '1'));
      counts.forEach(function (n, c) {
        for (var i = 0; i < n; i++) {
          var on = pick && pick.src === src && pick.color === c;
          kids.push(h('button', { class: 'tl c' + c + (on ? ' on' : '') + (myTurn ? ' can' : ''), type: 'button', disabled: !myTurn,
            'aria-label': G.colors[c] + ' tile, ' + label,
            onclick: function () { S.pick = on ? null : { src: src, color: c }; render(); } }));
        }
      });
      return kids;
    };

    var market = h('section', { class: 'market' },
      h('div', { class: 'trays' }, st.trays.map(function (t, i) {
        return h('div', { class: 'tray' + (t.some(Boolean) ? '' : ' empty') }, pool(t, i, 'tray ' + (i + 1)));
      })),
      h('div', { class: 'pile' }, h('span', { class: 'label', text: 'Middle' }),
        h('div', { class: 'pile-tiles' }, pool(st.pile, -1, 'middle'), (!st.mk && !st.pile.some(Boolean)) ? h('span', { class: 'none', text: 'Empty' }) : null)));

    var board = function (s, big) {
      var P = st.pl[s], p = g.players[s], mine = big && s === seat && myTurn && pick;
      var rows = [];
      for (var r = 0; r < 5; r++) {
        (function (r) {
          var slots = [];
          for (var i = r; i >= 0; i--) slots.push(i < P.rn[r] ? tile(P.rc[r]) : h('span', { class: 'tl slot' }));
          var ok = mine && okRow[r];
          rows.push(h(ok ? 'button' : 'div', { class: 'prow' + (ok ? ' ok' : ''), type: ok ? 'button' : null,
            'aria-label': ok ? 'Place in row ' + (r + 1) : null,
            onclick: ok ? function () { applyMove(S.gid, okRow[r]); } : null }, slots));
          var cells = [];
          for (var c = 0; c < 5; c++) cells.push(tile(G.yardColor(r, c), ((P.wall[r] >> c) & 1) ? '' : ' ghost'));
          rows.push(h('div', { class: 'yrow' }, cells));
        })(r);
      }
      var broken = [];
      if (P.fm) broken.push(h('span', { class: 'tl mk' }, '1'));
      P.fl.forEach(function (n, c) { for (var i = 0; i < n; i++) broken.push(tile(c)); });
      var fslots = G.penalties.map(function (pen, i) {
        return h('span', { class: 'fslot' }, broken[i] || h('span', { class: 'tl slot' }), big ? h('em', { text: '−' + pen }) : null);
      });
      var fok = mine && okRow[5];
      var floor = h(fok ? 'button' : 'div', { class: 'floor' + (fok ? ' ok' : ''), type: fok ? 'button' : null,
        'aria-label': fok ? 'Break these tiles' : null, onclick: fok ? function () { applyMove(S.gid, okRow[5]); } : null },
        big ? h('span', { class: 'label', text: 'Broken' }) : null, h('div', { class: 'fslots' }, fslots));
      var on = active && st.turn === s;
      return h('section', { class: 'dboard ' + (big ? 'big' : 'mini') + (on ? ' on' : '') },
        h('div', { class: 'dhead' },
          h('strong', { text: pname(p) + (s === seat ? ' (you)' : '') }),
          on ? h('span', { class: 'chip turn', text: 'to move' }) : null,
          h('span', { class: 'score', text: P.score + (P.score === 1 ? ' pt' : ' pts') + (st.over && P.bonus ? ' (+' + P.bonus + ' bonus)' : '') })),
        h('div', { class: 'dgrid' }, rows),
        floor);
    };

    var news = '';
    if (st.gain) news = (st.over ? 'Final round scored: ' : 'Round scored: ') + g.players.map(function (p, i) { return pname(p) + ' ' + (st.gain[i] >= 0 ? '+' : '−') + Math.abs(st.gain[i]); }).join(', ') + '.';
    else if (st.last) {
      var L = st.last;
      news = pname(g.players[L.seat]) + ' took ' + L.k + ' ' + G.colors[L.color] + (L.src < 0 ? ' from the middle' : ' from a tray') + (L.row < 5 ? ' for row ' + (L.row + 1) : ' and broke them') + '.';
    }

    var foot = footer(g, seat);
    var focus = seat >= 0 ? seat : st.turn, others = [];
    for (var i = 1; i < g.players.length; i++) others.push((focus + i) % g.players.length);

    root.replaceChildren.apply(root, [
      h('div', { class: 'game-top' },
        h('button', { class: 'btn small ghost', type: 'button', onclick: toLobby }, '← Lobby'),
        h('h2', { text: G.name }),
        h('span', { class: 'chip', text: seat < 0 ? 'Watching' : 'Round ' + st.round })),
      foot[0],
      active ? market : null,
      news ? h('p', { class: 'news', text: news }) : null,
      board(focus, true),
      h('div', { class: 'others' }, others.map(function (s) { return board(s, false); })),
      foot[1],
      h('details', { class: 'help' }, h('summary', { text: 'How to play ' + G.name }), h('ol', null, G.help.map(function (t) { return h('li', { text: t }); })))
    ].flat().filter(Boolean));
  }

  /* ------------------------------------------------------------- card games */
  var SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
  function cardEl(c, cls, onclick) {
    var red = c[1] === 'H' || c[1] === 'D';
    var kids = [h('b', { text: c[0] === 'T' ? '10' : c[0] }), h('i', { text: SUIT[c[1]] + '︎' })];
    return onclick
      ? h('button', { class: 'cd' + (red ? ' red' : '') + (cls || ''), type: 'button', 'aria-label': (c[0] === 'T' ? '10' : c[0]) + SUIT[c[1]], onclick: onclick }, kids)
      : h('span', { class: 'cd' + (red ? ' red' : '') + (cls || '') }, kids);
  }
  function backs(n) { var out = []; for (var i = 0; i < n; i++) out.push(h('span', { class: 'cd back' })); return out; }

  function renderCards(root, g, G, seat) {
    var st = g.state, active = g.status === 'active', n = st.n;
    var myTurn = active && seat === st.turn && !S.readOnly;
    var name = function (i) { return pname(g.players[i]) + (i === seat ? ' (you)' : ''); };
    var text = function (t) { return t.replace(/@(\d)/g, function (m, d) { return pname(g.players[+d]); }); };
    var sides = st.score.map(function (v, side) {
      var who = [];
      for (var i = 0; i < n; i++) if (G.sideOf(st, i) === side) who.push(i);
      return { score: v, who: who, mine: who.indexOf(seat) >= 0 };
    });
    var role = function (i) {
      var bits = [];
      if (i === st.dealer) bits.push('Dealer');
      if (n === 4) {
        if (seat < 0) bits.push('team ' + (G.sideOf(st, i) + 1));
        else if (i !== seat) bits.push(G.sideOf(st, i) === G.sideOf(st, seat) ? 'your partner' : 'other team');
      }
      return bits.join(', ');
    };

    var scores = h('section', { class: 'pegs' }, sides.map(function (sd) {
      return h('div', { class: 'peg' + (sd.mine ? ' mine' : '') },
        h('div', { class: 'peg-top' }, h('strong', { text: sd.who.map(function (i) { return pname(g.players[i]); }).join(' & ') + (sd.mine ? (sd.who.length > 1 ? ' (your team)' : ' (you)') : '') }),
          h('span', { class: 'score', text: sd.score + ' / 121' })),
        h('div', { class: 'track' }, h('span', { style: 'width:' + (sd.score / 121 * 100).toFixed(1) + '%' })));
    }));

    var stack = G.cards(st.stack), starter = G.cards(st.starter)[0];
    var table = h('section', { class: 'ctable' },
      h('div', { class: 'cmid' },
        h('div', { class: 'cslot' }, h('span', { class: 'label', text: 'Starter' }), starter ? cardEl(starter) : h('span', { class: 'cd back' })),
        h('div', { class: 'cslot' }, h('span', { class: 'label', text: 'Count' }), h('span', { class: 'count', text: st.phase === 'play' ? String(st.count) : '–' })),
        h('div', { class: 'cslot' }, h('span', { class: 'label', text: pname(g.players[st.dealer]) + '’s crib' }), h('div', { class: 'fan' }, backs(G.cards(st.crib).length)))),
      (st.phase === 'discard' || st.phase === 'play') ? h('ul', { class: 'cseats' }, g.players.map(function (p, i) {
        var laid = G.cards(st.tbl[i]), left = G.cards(st.hands[i]).length;
        return h('li', { class: (active && st.turn === i ? 'on' : '') },
          h('div', { class: 'cwho' }, h('strong', { text: name(i) }), h('span', { text: role(i) })),
          h('div', { class: 'fan' }, laid.map(function (c) { return cardEl(c, stack.indexOf(c) >= 0 ? '' : ' dim'); }), i === seat ? null : backs(left)));
      })) : null);

    var show = null;
    if ((st.phase === 'show' || st.phase === 'count') && st.show) {
      show = h('section', { class: 'cshow' }, h('h3', { text: st.phase === 'count' ? 'Counted so far' : 'Hand ' + st.hand + ' counted' }),
        h('ul', null, st.show.map(function (e) {
          return h('li', null,
            h('div', { class: 'cwho' }, h('strong', { text: e.crib ? pname(g.players[e.seat]) + '’s crib' : name(e.seat) }), h('span', { text: e.why + (e.max !== undefined && !e.missed && e.max > 0 ? '. Found everything.' : '') })),
            h('div', { class: 'fan' }, G.cards(e.cards).map(function (c) { return cardEl(c); }), starter ? cardEl(starter, ' starter') : null),
            h('span', { class: 'score', text: '+' + e.pts }),
            e.missed ? h('p', { class: 'missed', text: 'Missed ' + (e.max - e.pts) + ': ' + e.missed }) : null);
        })));
    }

    var counter = null;
    if (st.phase === 'count' && active) {
      var cur = G.counting(st), five = cur.hand.concat([cur.starter]);
      if (myTurn) {
        var ck = S.gid + ':' + g.n;
        if (!S.cnt || S.cnt.key !== ck) S.cnt = { key: ck, sel: [], got: [], sure: false };
        var C = S.cnt, verdict = G.judge(st, C.sel), tally = G.countPoints(st, C.got);
        var finish = function () { applyMove(S.gid, { count: C.got.slice() }); };
        counter = h('section', { class: 'ccount' },
          h('h3', { text: cur.crib ? 'Count your crib' : 'Count your hand' }),
          h('p', { class: 'note', text: 'Tap the cards that make a fifteen, a pair or a run. Then claim the points.' }),
          h('div', { class: 'fan count' }, five.map(function (c) {
            var on = C.sel.indexOf(c) >= 0;
            return h('div', { class: 'cwrap' },
              cardEl(c, ' can' + (on ? ' on' : ''), function () {
                if (on) C.sel.splice(C.sel.indexOf(c), 1); else C.sel.push(c);
                C.sure = false; render();
              }),
              h('em', { text: c === cur.starter ? 'starter' : ' ' }));
          })),
          h('p', { class: 'readout', 'aria-live': 'polite', text: C.sel.length ? C.sel.map(G.cardName).join(' + ') + ' = ' + verdict.sum : 'No cards picked yet.' }),
          verdict.claims.map(function (cl) {
            var fresh = cl.keys.filter(function (k) { return C.got.indexOf(k) < 0; });
            if (!fresh.length) return h('p', { class: 'note', text: cl.label + ' with these cards is already counted.' });
            var worth = cl.pts * fresh.length / cl.keys.length;
            return h('button', { class: 'btn primary big', type: 'button', onclick: function () {
              fresh.forEach(function (k) { C.got.push(k); });
              C.sel = []; C.sure = false;
              toast(cl.label + ' for ' + worth + '!'); render();
            } }, 'Claim ' + cl.label.toLowerCase() + ' for ' + worth);
          }),
          verdict.note ? h('p', { class: 'note', text: verdict.note }) : null,
          C.sel.length ? h('button', { class: 'btn big', type: 'button', onclick: function () { C.sel = []; render(); } }, 'Put the cards back') : null,
          C.got.length ? h('ul', { class: 'got' }, C.got.map(function (k) { return h('li', { text: G.comboLabel(k) }); })) : null,
          h('p', { class: 'total', text: 'Counted so far: ' + tally.pts + (tally.pts === 1 ? ' point' : ' points') }),
          st.opts && st.opts.tell ? h('p', { class: 'tell' + (tally.pts === tally.max ? ' all' : ''), text: tally.pts === tally.max ? (tally.max ? 'That is everything in this hand!' : 'There are no points in this hand.') : 'There is more to find.' }) : null,
          C.sure
            ? h('div', { class: 'sure' }, h('p', { class: 'note', text: 'Score ' + tally.pts + (tally.pts === 1 ? ' point' : ' points') + ' and finish?' }),
                h('button', { class: 'btn primary big', type: 'button', id: 'count-yes', onclick: finish }, 'Yes, score ' + tally.pts),
                h('button', { class: 'btn big', type: 'button', onclick: function () { C.sure = false; render(); } }, 'Keep counting'))
            : h('div', { class: 'sure' },
                C.got.length ? h('button', { class: 'btn big', type: 'button', onclick: function () { C.got = []; C.sel = []; render(); } }, 'Start over') : null,
                h('button', { class: 'btn big', type: 'button', id: 'count-done', onclick: function () { C.sure = true; render(); } }, 'I am done counting')));
      } else {
        counter = h('section', { class: 'ccount' },
          h('h3', { text: name(cur.seat) + ' is counting ' + (cur.crib ? 'the crib' : 'a hand') }),
          h('div', { class: 'fan' }, cur.hand.map(function (c) { return cardEl(c); }), cardEl(cur.starter, ' starter')));
      }
    }

    var hand = null;
    if (seat >= 0 && (st.phase === 'discard' || st.phase === 'play')) {
      var mine = G.cards(st.hands[seat]), need = n === 2 ? 2 : 1, kids;
      S.chosen = S.chosen.filter(function (c) { return mine.indexOf(c) >= 0; });
      if (st.phase === 'discard') {
        var owner = st.dealer === seat ? 'the crib is yours' : (n === 4 && G.sideOf(st, st.dealer) === G.sideOf(st, seat)) ? 'the crib is your partner’s' : 'the crib is ' + pname(g.players[st.dealer]) + '’s';
        kids = mine.map(function (c) {
          if (!myTurn) return cardEl(c);
          var on = S.chosen.indexOf(c) >= 0;
          return cardEl(c, ' can' + (on ? ' on' : ''), function () {
            if (on) S.chosen = S.chosen.filter(function (x) { return x !== c; });
            else { S.chosen.push(c); if (S.chosen.length > need) S.chosen.shift(); }
            render();
          });
        });
        hand = h('section', { class: 'chand' }, h('span', { class: 'label', text: 'Your hand, ' + owner }),
          h('div', { class: 'fan big' }, kids),
          myTurn ? h('button', { class: 'btn primary big', type: 'button', id: 'to-crib', disabled: S.chosen.length !== need,
            onclick: function () { applyMove(S.gid, { d: S.chosen.join('') }); } }, need === 2 ? 'Send 2 cards to the crib' : 'Send 1 card to the crib') : null);
      } else {
        kids = mine.map(function (c) {
          var ok = myTurn && st.count + G.cardValue(c) <= 31;
          var on = S.chosen[0] === c;
          return ok ? cardEl(c, ' can' + (on ? ' on' : ''), function () { S.chosen = on ? [] : [c]; render(); }) : cardEl(c, myTurn ? ' dim' : '');
        });
        var pc = myTurn && S.chosen[0];
        hand = h('section', { class: 'chand' }, h('span', { class: 'label', text: 'Your hand' }),
          h('div', { class: 'fan big' }, kids.length ? kids : h('span', { class: 'none', text: 'All your cards are played.' })),
          myTurn ? h('button', { class: 'btn primary big', type: 'button', id: 'play-card', disabled: !pc,
            onclick: function () { applyMove(S.gid, { c: pc }); } }, pc ? 'Play ' + G.cardName(pc) + ' to make ' + (st.count + G.cardValue(pc)) : 'Tap a card, then play it') : null);
      }
    }

    var foot = footer(g, seat);
    root.replaceChildren.apply(root, [
      h('div', { class: 'game-top' },
        h('button', { class: 'btn small ghost', type: 'button', onclick: toLobby }, '← Lobby'),
        h('h2', { text: G.name }),
        h('span', { class: 'chip', text: seat < 0 ? 'Watching' : 'Hand ' + st.hand })),
      foot[0],
      scores,
      table,
      counter,
      show,
      active && myTurn && st.phase === 'show' ? h('button', { class: 'btn primary big', type: 'button', id: 'next-hand', onclick: function () { applyMove(S.gid, { next: 1 }); } }, 'Deal the next hand') : null,
      hand,
      h('ul', { class: 'clog' }, st.log.slice().reverse().map(function (t) { return h('li', { text: text(t) }); })),
      foot[1],
      h('details', { class: 'help' }, h('summary', { text: 'How to play ' + G.name }), h('ol', null, G.help.map(function (t) { return h('li', { text: t }); })))
    ].flat().filter(Boolean));
  }

  /* --------------------------------------------- shared by the newer screens */
  /* Save one small part of a game (a player's own corner of it) without rewriting the rest. */
  function patch(id, path, value) {
    var g = S.games[id];
    if (!g) return;
    var ng = clone(g), node = ng;
    for (var i = 0; i < path.length - 1; i++) { if (!node[path[i]] || typeof node[path[i]] !== 'object') node[path[i]] = {}; node = node[path[i]]; }
    node[path[path.length - 1]] = value;
    S.games = Object.assign({}, S.games); S.games[id] = ng;
    S.store.patchGame(id, path, value, ng).catch(writeFailed);
  }
  function topBar(G, chip) {
    return h('div', { class: 'game-top' },
      h('button', { class: 'btn small ghost', type: 'button', onclick: toLobby }, '← Lobby'),
      h('h2', { text: G.name }), h('span', { class: 'chip', text: chip }));
  }
  function helpBox(G) {
    return h('details', { class: 'help' }, h('summary', { text: 'How to play ' + G.name }), h('ol', null, G.help.map(function (t) { return h('li', { text: t }); })));
  }

  /* ---------------------------------------------------------------- Pond Snap */
  var FROG = ['#2e9c8f', '#e6a93c', '#cf4a3c', '#7a5ab5'];

  function renderSnap(root, g, G, seat) {
    var gid = S.gid;
    if (root.dataset.snap !== gid) {
      root.dataset.snap = gid;
      var canvas = h('canvas', { class: 'pond', width: '640', height: '640', role: 'img', 'aria-label': 'The pond' });
      var btn = h('button', { class: 'btn primary snapbtn', type: 'button', id: 'snap' }, 'Snap!');
      var foot = h('div', { class: 'snapfoot' });
      root.replaceChildren(topBar(G, seat < 0 ? 'Watching' : 'No turns'), canvas, btn, foot, helpBox(G));
      S.snap = { canvas: canvas, btn: btn, foot: foot, last: 0, tongue: {}, ai: {}, done: false, seen: 0 };
      var go = function (ev) { if (ev) ev.preventDefault(); snapNow(gid); };
      btn.addEventListener('pointerdown', go); btn.addEventListener('click', go); canvas.addEventListener('pointerdown', go);
      requestAnimationFrame(function loop() {
        if (S.view !== 'game' || S.gid !== gid || root.dataset.snap !== gid || !document.body.contains(canvas)) return;
        snapFrame(gid);
        requestAnimationFrame(loop);
      });
    }
    var ui = S.snap;
    ui.btn.hidden = g.status !== 'active' || seat < 0 || S.readOnly;
    ui.foot.replaceChildren.apply(ui.foot, footer(g, seat).filter(Boolean));
  }

  function snapNow(gid) {
    var g = S.games[gid], ui = S.snap, t = Date.now();
    if (!g || !ui || g.status !== 'active' || S.readOnly) return;
    var seat = g.players.findIndex(function (p) { return p.id === S.me.id; });
    if (seat < 0 || t - ui.last < 280) return;
    ui.last = t; ui.tongue[seat] = t;
    GAMES[g.type].inZone(g.state, seat, t).slice(0, 4).forEach(function (i) { patch(gid, ['state', 'eat', 's' + seat, 'm' + i], t); });
  }

  function snapFrame(gid) {
    var g = S.games[gid], ui = S.snap;
    if (!g || !ui) return;
    var G = GAMES[g.type], st = g.state, t = Date.now(), n = st.n, active = g.status === 'active';
    var seat = g.players.findIndex(function (p) { return p.id === S.me.id; });
    var ctx = ui.canvas.getContext('2d'), W = ui.canvas.width, c = W / 2, R = W / 2 - 10;
    var rot = seat > 0 ? -seat * 2 * Math.PI / n : 0, cs = Math.cos(rot), sn = Math.sin(rot);
    var pt = function (x, y) { return [c + (x * cs - y * sn) * R, c + (x * sn + y * cs) * R]; };
    var scores = G.scores(st), k, i, p;

    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = '#0e4d5c'; ctx.beginPath(); ctx.arc(c, c, R, 0, 6.3); ctx.fill();
    ctx.strokeStyle = '#2b7a6a'; ctx.lineWidth = 10; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.arc(c, c, R * 0.42, 0, 6.3); ctx.fill();

    for (k = 0; k < n; k++) {
      var z = G.zone(st, k), zp = pt(z.x, z.y), a = G.angle(st, k), fp = pt(0.93 * Math.cos(a), 0.93 * Math.sin(a));
      var eat = (st.eat || {})['s' + k], lastEat = 0;
      if (eat) for (var m in eat) if (eat[m] > lastEat) lastEat = eat[m];
      var snapAt = Math.max(ui.tongue[k] || 0, k === seat ? 0 : lastEat);
      ctx.strokeStyle = FROG[k]; ctx.globalAlpha = k === seat ? 0.95 : 0.4; ctx.lineWidth = k === seat ? 5 : 2;
      ctx.setLineDash(k === seat ? [] : [8, 8]);
      ctx.beginPath(); ctx.arc(zp[0], zp[1], z.r * R, 0, 6.3); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (t - snapAt < 220) { ctx.strokeStyle = '#f08a9b'; ctx.lineWidth = 12; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(fp[0], fp[1]); ctx.lineTo(zp[0], zp[1]); ctx.stroke(); }
      ctx.fillStyle = FROG[k]; ctx.beginPath(); ctx.arc(fp[0], fp[1], R * 0.12, 0, 6.3); ctx.fill();
      var dx = (c - fp[0]) / R, dy = (c - fp[1]) / R, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      for (i = -1; i <= 1; i += 2) {
        var ex = fp[0] + ux * R * 0.07 + (-uy) * i * R * 0.06, ey = fp[1] + uy * R * 0.07 + ux * i * R * 0.06;
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, ey, R * 0.035, 0, 6.3); ctx.fill();
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(ex + ux * 3, ey + uy * 3, R * 0.016, 0, 6.3); ctx.fill();
      }
      var lp = pt(0.66 * Math.cos(a) * 1.0, 0.66 * Math.sin(a) * 1.0);
      ctx.fillStyle = '#f4ecd9'; ctx.font = '700 ' + Math.round(W / 26) + 'px Figtree, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var label = pname(g.players[k]) + (k === seat ? ' (you)' : '') + '  ' + scores[k];
      var lx = c + (fp[0] - c) * 0.72, ly = c + (fp[1] - c) * 0.72 + (fp[1] > c ? R * 0.2 : -R * 0.2) * 0;
      ctx.fillText(label, Math.min(W - 90, Math.max(90, fp[0] + (fp[0] < c - 5 ? 70 : fp[0] > c + 5 ? -70 : 0))), Math.min(W - 16, Math.max(16, fp[1] + (fp[1] > c ? -R * 0.19 : R * 0.19))));
    }

    if (t >= st.t0) for (i = 0; i < st.count; i++) {
      if (G.owner(st, i) >= 0) continue;
      p = G.flyAt(st, i, Math.min(t, G.endsAt(st)));
      if (!p) continue;
      var q = pt(p.x, p.y);
      ctx.fillStyle = 'rgba(255,226,122,0.25)'; ctx.beginPath(); ctx.arc(q[0], q[1], 17, 0, 6.3); ctx.fill();
      ctx.fillStyle = '#ffe27a'; ctx.beginPath(); ctx.arc(q[0], q[1], 8, 0, 6.3); ctx.fill();
    }

    ctx.fillStyle = '#f4ecd9'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (active && t < st.t0) {
      ctx.font = '800 ' + Math.round(W / 4) + 'px "Bricolage Grotesque", sans-serif';
      ctx.fillText(String(Math.ceil((st.t0 - t) / 1000)), c, c);
    } else if (active) {
      ctx.font = '700 ' + Math.round(W / 22) + 'px Figtree, sans-serif'; ctx.globalAlpha = 0.7;
      ctx.fillText(Math.max(0, Math.ceil((G.endsAt(st) - t) / 1000)) + 's', c, c);
      ctx.globalAlpha = 1;
    }

    if (!active || S.readOnly || t < st.t0) return;
    if (g.host === S.me.id) g.players.forEach(function (pl, k) {       // the host's screen plays the AI frogs
      if (!pl.ai) return;
      var ids = G.inZone(st, k, t), ai = ui.ai[k] || (ui.ai[k] = { ready: 0 });
      if (!ids.length) { ai.ready = 0; return; }
      if (!ai.ready) { ai.ready = t + [900, 450, 180][pl.level] + Math.random() * [900, 500, 260][pl.level]; return; }
      if (t < ai.ready) return;
      ai.ready = 0; ui.tongue[k] = t;
      ids.slice(0, 4).forEach(function (i) { patch(gid, ['state', 'eat', 's' + k, 'm' + i], t); });
    });
    if (seat >= 0 && !ui.done && G.finished(st, t)) {
      if (!ui.seen) ui.seen = t;
      if (t - ui.seen > (g.host === S.me.id ? 1500 : 5000)) {         // give the last snaps a moment to arrive
        ui.done = true;
        var ng = clone(S.games[gid]);
        ng.status = 'done'; ng.result = G.finish(ng.state); ng.n = g.n + 1; ng.updated = t;
        commit(gid, ng);
      }
    }
  }

  /* ------------------------------------------------------------------ Go Fish */
  function renderFish(root, g, G, seat) {
    var st = g.state, active = g.status === 'active', n = st.n;
    var myTurn = active && seat === st.turn && !S.readOnly;
    var text = function (t) { return t.replace(/@(\d)/g, function (m, d) { return pname(g.players[+d]); }); };
    var key = S.gid + ':' + g.n;
    if (!S.ask || S.ask.key !== key) S.ask = { key: key, to: -1, r: '' };
    var A = S.ask, targets = [];
    for (var i = 0; i < n; i++) if (i !== seat && G.cards(st.hands[i]).length) targets.push(i);
    if (myTurn && targets.length === 1) A.to = targets[0];

    var seats = h('ul', { class: 'fseats' }, g.players.map(function (p, i) {
      var cards = G.cards(st.hands[i]).length, books = st.books[i].slice(1).split('').filter(Boolean);
      var can = myTurn && targets.indexOf(i) >= 0;
      var body = [
        h('div', { class: 'cwho' }, h('strong', { text: pname(p) + (i === seat ? ' (you)' : '') }), h('span', { text: cards + (cards === 1 ? ' card' : ' cards') + (active && st.turn === i ? ', asking now' : '') })),
        h('div', { class: 'books' }, books.length ? books.map(function (r) { return h('span', { class: 'book', text: r === 'T' ? '10' : r }); }) : h('span', { class: 'none', text: 'No books yet' }))];
      return h('li', null, can
        ? h('button', { class: 'fseat can' + (A.to === i ? ' on' : ''), type: 'button', 'aria-pressed': A.to === i ? 'true' : 'false', onclick: function () { A.to = i; render(); } }, body)
        : h('div', { class: 'fseat' + (active && st.turn === i ? ' turn' : '') }, body));
    }));

    var hand = null;
    if (seat >= 0) {
      var mine = G.cards(st.hands[seat]), groups = {}, order = [];
      mine.forEach(function (c) { if (!groups[c[0]]) { groups[c[0]] = []; order.push(c[0]); } groups[c[0]].push(c); });
      if (A.r && !groups[A.r]) A.r = '';
      hand = h('section', { class: 'chand' }, h('span', { class: 'label', text: 'Your hand' }),
        h('div', { class: 'groups' }, order.length ? order.map(function (r) {
          var kids = groups[r].map(function (c) { return cardEl(c); });
          return myTurn
            ? h('button', { class: 'grp can' + (A.r === r ? ' on' : ''), type: 'button', 'aria-label': 'Your ' + G.plural(r), 'aria-pressed': A.r === r ? 'true' : 'false', onclick: function () { A.r = A.r === r ? '' : r; render(); } }, kids)
            : h('div', { class: 'grp' }, kids);
        }) : h('span', { class: 'none', text: 'You have no cards.' })),
        st.drew && st.drew.seat === seat ? h('p', { class: 'note', text: 'You drew ' + G.cardName(st.drew.card) + '.' }) : null,
        myTurn ? h('button', { class: 'btn primary big', type: 'button', id: 'ask', disabled: !(A.r && A.to >= 0),
          onclick: function () { applyMove(S.gid, { to: A.to, r: A.r }); } },
          !A.r ? 'Pick a kind of card from your hand' : A.to < 0 ? 'Now pick who to ask' : 'Ask ' + pname(g.players[A.to]) + ' for ' + G.plural(A.r)) : null);
    }

    var foot = footer(g, seat), pool = G.cards(st.pool).length;
    root.replaceChildren.apply(root, [
      topBar(G, seat < 0 ? 'Watching' : pool + ' in the pool'),
      foot[0], seats, hand,
      h('ul', { class: 'clog' }, st.log.slice().reverse().map(function (t) { return h('li', { text: text(t) }); })),
      foot[1], helpBox(G)
    ].filter(Boolean));
  }

  /* -------------------------------------------------------------- Mystery Face */
  var SKIN = ['#f6d7b8', '#e3b07c', '#b97a4a', '#7d4a2a'], HAIR = ['#262322', '#6b4423', '#e3c25a', '#c2492c', '#eeeae2'], SHIRT = ['#2e9c8f', '#e6a93c', '#cf4a3c', '#7a5ab5', '#4a78c2'];
  function faceEl(p) {
    var hair = HAIR[p.hair], skin = SKIN[p.skin], edge = ' stroke="rgba(0,0,0,0.35)" stroke-width="0.8"';
    var top = '<path d="M17 25 Q17 9 32 9 Q47 9 47 25 Q41 16 32 16 Q23 16 17 25 Z" fill="' + hair + '"' + edge + '/>';
    var s = '<svg viewBox="0 0 64 64" aria-hidden="true">';
    if (p.style === 2) s += '<path d="M12 28 Q12 7 32 7 Q52 7 52 28 L52 52 L43 52 L43 26 L21 26 L21 52 L12 52 Z" fill="' + hair + '"' + edge + '/>';
    s += '<path d="M8 64 Q8 50 32 50 Q56 50 56 64 Z" fill="' + SHIRT[p.shirt] + '"/><rect x="27" y="40" width="10" height="12" fill="' + skin + '"/>';
    s += '<ellipse cx="32" cy="28" rx="14" ry="16" fill="' + skin + '" stroke="rgba(0,0,0,0.25)" stroke-width="0.8"/>';
    if (p.style === 1 || p.style === 2) s += top;
    if (p.style === 3) [[19, 19], [25, 13], [32, 11], [39, 13], [45, 19], [17, 26], [47, 26]].forEach(function (q) { s += '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="5.5" fill="' + hair + '"' + edge + '/>'; });
    if (p.beard) s += '<path d="M18.5 31 Q19 46 32 47.5 Q45 46 45.5 31 Q40 39 32 39 Q24 39 18.5 31 Z" fill="' + (p.style === 0 ? '#6b4423' : hair) + '"' + edge + '/>';
    s += '<circle cx="26" cy="28" r="1.8" fill="#1c1614"/><circle cx="38" cy="28" r="1.8" fill="#1c1614"/><path d="M27 35 Q32 39 37 35" fill="none" stroke="#7a2f2a" stroke-width="1.6" stroke-linecap="round"/>';
    if (p.glasses) s += '<g fill="rgba(255,255,255,0.25)" stroke="#1c1614" stroke-width="1.5"><circle cx="26" cy="28" r="5"/><circle cx="38" cy="28" r="5"/><path d="M31 28 L33 28"/></g>';
    if (p.hat) s += '<rect x="17" y="3" width="30" height="11" rx="3" fill="#d1495b"/><rect x="11" y="13" width="42" height="4.5" rx="2" fill="#a83546"/>';
    var el = h('span', { class: 'fsvg' });
    el.innerHTML = s + '</svg>';
    return el;
  }

  function renderFaces(root, g, G, seat) {
    var st = g.state, active = g.status === 'active' && !S.readOnly, P = G.people;
    if (!S.gs || S.gs.key !== S.gid) S.gs = { key: S.gid, mode: false, pick: -1, clear: false };
    var Q = S.gs, down = seat >= 0 ? st.down['s' + seat] : '000000000000000000000000', other = seat >= 0 ? g.players[1 - seat] : null;
    var up = function (str) { return str.split('').filter(function (c) { return c === '0'; }).length; };
    var over = g.status !== 'active';

    var secret = null;
    if (seat >= 0) {
      var mineP = P[st.secret[seat]];
      secret = h('section', { class: 'secret' }, faceEl(mineP),
        h('div', { class: 'cwho' }, h('span', { class: 'label', text: 'Your secret person' }), h('strong', { text: mineP.name }),
          h('span', { text: over ? pname(other) + ' had ' + P[st.secret[1 - seat]].name + '.' : pname(other) + ' has ' + up(st.down['s' + (1 - seat)]) + ' faces still up.' })));
    } else if (over) {
      secret = h('p', { class: 'note', text: g.players.map(function (p, i) { return pname(p) + ' had ' + P[st.secret[i]].name; }).join('. ') + '.' });
    }

    var grid = h('div', { class: 'faces' + (Q.mode ? ' guessing' : '') }, P.map(function (p, i) {
      var isDown = down[i] === '1';
      return h('button', { class: 'face' + (isDown ? ' down' : '') + (Q.pick === i ? ' pick' : ''), type: 'button', disabled: !active || seat < 0,
        'aria-label': p.name + (isDown ? ', flipped down' : ''), 'aria-pressed': isDown ? 'true' : 'false',
        onclick: function () {
          if (Q.mode) { Q.pick = i; return render(); }
          Q.clear = false;
          patch(S.gid, ['state', 'down', 's' + seat], down.substr(0, i) + (isDown ? '0' : '1') + down.substr(i + 1));
          render();
        } }, faceEl(p), h('span', { class: 'fname', text: p.name }));
    }));

    var controls = null;
    if (active && seat >= 0) {
      var cancel = h('button', { class: 'btn big', type: 'button', onclick: function () { Q.mode = false; Q.pick = -1; render(); } }, 'Not yet');
      if (!Q.mode) controls = h('div', { class: 'sure' },
        h('button', { class: 'btn primary big', type: 'button', id: 'guess', onclick: function () { Q.mode = true; Q.pick = -1; render(); } }, 'Make a guess'),
        up(down) < 24 ? h('button', { class: 'btn big', type: 'button', onclick: function () {
          if (!Q.clear) { Q.clear = true; return render(); }
          Q.clear = false; patch(S.gid, ['state', 'down', 's' + seat], '000000000000000000000000'); render();
        } }, Q.clear ? 'Tap again to stand them all up' : 'Stand every face back up') : null);
      else if (Q.pick < 0) controls = h('div', { class: 'sure' }, h('p', { class: 'note', text: 'Tap the face you think is ' + pname(other) + '’s secret person.' }), cancel);
      else controls = h('div', { class: 'sure' },
        h('p', { class: 'note', text: 'Guess ' + P[Q.pick].name + '? A wrong guess loses the game.' }),
        h('button', { class: 'btn primary big', type: 'button', id: 'guess-yes', onclick: function () { applyMove(S.gid, { seat: seat, guess: Q.pick }); } }, 'Yes, guess ' + P[Q.pick].name),
        cancel);
    }

    var foot = footer(g, seat);
    root.replaceChildren.apply(root, [topBar(G, seat < 0 ? 'Watching' : up(down) + ' still up'), foot[0], secret, grid, controls, foot[1], helpBox(G)].filter(Boolean));
  }

  /* -------------------------------------------------------------- Banner Clash */
  var PIECE_ICON = {
    '1': '<path d="M12 1 L15.5 14 L12 17 L8.5 14 Z"/><rect x="6" y="16.5" width="12" height="2.4" rx="1"/><rect x="10.6" y="18.5" width="2.8" height="4.8" rx="1"/>',
    '2': '<path d="M9 3 H14.5 V12.5 L21 15.5 Q23 16.6 23 19.5 V21 H9 Z"/><path d="M1.5 7 H6.5 M0.5 12 H6.5 M1.5 17 H6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    '3': '<path d="M4.5 21 L19 4.5 M19.5 21 L6 5.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M13 2.5 Q21.5 2.5 21.5 11" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/><path d="M1.5 5.5 L5.5 1.5 L9.5 5 L5 9.5 Z"/>',
    B: '<path d="M1 21 L4.5 8 L8 21 L12 5 L16 21 L19.5 8 L23 21 Z"/>',
    F: '<path d="M5 2 V23" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M6 3 H21 L17 8.5 L21 14 H6 Z"/>'
  };
  /* What is printed on a piece: its power, plus a small icon for the pieces with special powers. */
  function pieceFace(r) {
    var out = [];
    if (r !== 'B' && r !== 'F') out.push(h('span', { class: 'pn', text: r === 'X' ? '10' : r }));
    if (PIECE_ICON[r]) {
      var ic = h('span', { class: 'pi' + (r === 'B' || r === 'F' ? ' solo' : '') });
      ic.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + PIECE_ICON[r] + '</svg>';
      out.push(ic);
    }
    return out;
  }
  function rankShort(r) { return r === 'X' ? '10' : r === 'B' ? 'trap' : r === 'F' ? 'banner' : r; }

  /* Portraits are drawn here from simple shapes, one per unit on each side. */
  function portrait(side, r) {
    var evil = side !== 1, S1 = '#f0c9a0', BONE = '#e9e4d4', DARK = '#17131c', GLOW = '#7dff8a', GOLD = '#ffd866', STEEL = '#c9d1dc';
    var body = function (c) { return '<path d="M16 100 Q16 70 50 70 Q84 70 84 100 Z" fill="' + c + '"/>'; };
    var head = function (c, rx, ry, cy) { return '<ellipse cx="50" cy="' + (cy || 48) + '" rx="' + (rx || 16) + '" ry="' + (ry || 18) + '" fill="' + c + '"/>'; };
    var eyes = function (c, y, rad) { return '<circle cx="43" cy="' + (y || 46) + '" r="' + (rad || 2.2) + '" fill="' + c + '"/><circle cx="57" cy="' + (y || 46) + '" r="' + (rad || 2.2) + '" fill="' + c + '"/>'; };
    var smile = '<path d="M44 56 Q50 60 56 56" fill="none" stroke="#7a2f2a" stroke-width="1.8" stroke-linecap="round"/>';
    var skull = head(BONE, 16, 17, 46) + '<rect x="41" y="58" width="18" height="9" rx="3" fill="' + BONE + '"/><ellipse cx="43" cy="46" rx="5" ry="6" fill="' + DARK + '"/><ellipse cx="57" cy="46" rx="5" ry="6" fill="' + DARK + '"/>' + eyes(GLOW, 46, 2) +
      '<path d="M50 52 L47 58 L53 58 Z" fill="' + DARK + '"/><path d="M45 61 V67 M50 61 V67 M55 61 V67" stroke="' + DARK + '" stroke-width="1.2"/>';
    var ribs = body('#241c2e') + '<path d="M50 72 V98 M36 78 Q50 84 64 78 M34 86 Q50 92 66 86 M34 94 Q50 100 66 94" fill="none" stroke="' + BONE + '" stroke-width="3" stroke-linecap="round"/>';
    var crown = function (c, y, gem) { return '<path d="M32 ' + y + ' L32 ' + (y - 13) + ' L41 ' + (y - 5) + ' L50 ' + (y - 17) + ' L59 ' + (y - 5) + ' L68 ' + (y - 13) + ' L68 ' + y + ' Z" fill="' + c + '"/><circle cx="50" cy="' + (y - 5) + '" r="2.4" fill="' + gem + '"/>'; };
    var sword = function (blade, hilt) { return '<rect x="80" y="18" width="5" height="46" rx="2" fill="' + blade + '"/><rect x="74" y="62" width="17" height="4.5" rx="2" fill="' + hilt + '"/><rect x="80.5" y="66" width="4" height="12" rx="1.5" fill="' + hilt + '"/>'; };
    var bow = function (c) { return '<path d="M80 20 Q98 50 80 80" fill="none" stroke="' + c + '" stroke-width="3.5" stroke-linecap="round"/><path d="M80 20 V80" stroke="#ddd" stroke-width="1"/>'; };
    var dagger = '<path d="M84 44 L88 64 L84 68 L80 64 Z" fill="' + STEEL + '"/><rect x="77" y="67" width="14" height="3.5" rx="1.5" fill="#6b4423"/><rect x="82.2" y="70" width="3.6" height="9" rx="1.5" fill="#6b4423"/>';
    var tools = function (c) { return '<path d="M12 92 L46 60 M88 92 L54 60" stroke="#8a5a2b" stroke-width="4" stroke-linecap="round"/><path d="M40 52 Q52 50 58 62" fill="none" stroke="' + c + '" stroke-width="5" stroke-linecap="round"/><path d="M46 62 L56 52 L64 58 L54 68 Z" fill="' + c + '"/>'; };
    var jaws = function (c, g) { return '<ellipse cx="50" cy="66" rx="38" ry="12" fill="rgba(0,0,0,0.45)"/><path d="M14 62 L22 40 L30 62 L38 36 L46 62 L54 36 L62 62 L70 40 L78 62 L86 46 L86 66 L14 66 Z" fill="' + c + '"/><path d="M14 68 H86" stroke="' + g + '" stroke-width="3" stroke-linecap="round"/>'; };
    var bat = function (x, y, k) { return '<g transform="translate(' + x + ' ' + y + ') scale(' + k + ')"><path d="M0 0 Q-6 -9 -15 -4 Q-11 -2 -12 5 Q-7 0 -3 6 Q0 2 3 6 Q7 0 12 5 Q11 -2 15 -4 Q6 -9 0 0 Z" fill="' + DARK + '" stroke="#5a3d7a" stroke-width="0.6"/><circle cx="-1.6" cy="0" r="0.9" fill="#ff4d3d"/><circle cx="1.6" cy="0" r="0.9" fill="#ff4d3d"/></g>'; };
    var art = '';
    if (r === '?') art = body('#0e0a14') + head('#0e0a14') + '<text x="50" y="58" text-anchor="middle" font-size="30" font-weight="700" fill="' + (evil ? GLOW : GOLD) + '">?</text>';
    else if (!evil) {
      if (r === 'X') art = body('#b3202a') + '<path d="M30 74 Q50 86 70 74 L70 80 Q50 92 30 80 Z" fill="#fff"/>' + head(S1) + '<path d="M36 52 Q38 72 50 74 Q62 72 64 52 Q57 60 50 60 Q43 60 36 52 Z" fill="#8a5a2b"/>' + eyes('#1c1614') + crown(GOLD, 34, '#cf4a3c');
      else if (r === '9') art = '<path d="M86 24 V98" stroke="#8a5a2b" stroke-width="4" stroke-linecap="round"/><circle cx="86" cy="20" r="6" fill="' + GOLD + '"/>' + body('#5b3fb0') + head(S1) + '<path d="M35 52 Q36 86 50 92 Q64 86 65 52 Q57 60 50 60 Q43 60 35 52 Z" fill="#f2f0ea"/>' + eyes('#1c1614') + '<path d="M30 36 L50 2 L70 36 Z" fill="#5b3fb0"/><ellipse cx="50" cy="36" rx="25" ry="5.5" fill="#4a3296"/><path d="M50 14 L52 20 L58 20 L53 24 L55 30 L50 26 L45 30 L47 24 L42 20 L48 20 Z" fill="' + GOLD + '"/>';
      else if (r === '8') art = body(STEEL) + '<path d="M50 30 Q46 8 62 6 Q56 16 58 30 Z" fill="' + GOLD + '"/>' + head('#dfe6ee', 17, 20) + '<rect x="47.5" y="36" width="5" height="24" fill="#1c1614"/><rect x="38" y="43" width="24" height="5" fill="#1c1614"/><path d="M8 62 H34 V82 Q21 96 8 82 Z" fill="#2445b8" stroke="' + GOLD + '" stroke-width="2"/><path d="M21 66 V88 M13 74 H29" stroke="' + GOLD + '" stroke-width="3"/>';
      else if (r === '7') art = body('#8d99a8') + head(STEEL, 17, 20) + '<rect x="37" y="43" width="26" height="5" rx="2" fill="#1c1614"/><path d="M50 50 V64" stroke="#8d99a8" stroke-width="2"/><path d="M50 28 Q50 14 60 12 Q56 20 56 28 Z" fill="#cf4a3c"/>' + sword('#eef2f6', GOLD);
      else if (r === '6') art = '<path d="M86 14 V98" stroke="#8a5a2b" stroke-width="4" stroke-linecap="round"/><path d="M86 4 L91 18 H81 Z" fill="' + STEEL + '"/>' + body('#2f55b0') + head(S1) + eyes('#1c1614') + smile + '<path d="M34 36 Q36 20 50 20 Q64 20 66 36 Z" fill="' + STEEL + '"/><ellipse cx="50" cy="36" rx="24" ry="5" fill="#a9b3c0"/>';
      else if (r === '5') art = body('#2f7d4f') + '<path d="M29 56 Q26 22 50 20 Q74 22 71 56 Q62 42 50 42 Q38 42 29 56 Z" fill="#256640"/>' + head(S1, 13, 15, 50) + eyes('#1c1614', 49) + '<path d="M45 57 Q50 60 55 57" fill="none" stroke="#7a2f2a" stroke-width="1.6" stroke-linecap="round"/>' + bow('#8a5a2b');
      else if (r === '4') art = body('#a8793f') + head(S1) + eyes('#1c1614') + smile + '<path d="M33 38 Q34 22 50 22 Q66 22 67 38 Z" fill="#b3202a"/><path d="M64 26 Q76 14 80 4 Q70 10 62 22 Z" fill="#f2f0ea"/><rect x="81" y="40" width="4" height="26" rx="2" fill="#eef2f6"/><rect x="76.5" y="64" width="13" height="4" rx="2" fill="#8a5a2b"/>';
      else if (r === '3') art = tools(STEEL) + body('#7a5a3a') + head(S1) + eyes('#1c1614') + smile + '<path d="M33 38 Q34 24 50 24 Q66 24 67 38 Z" fill="#8d99a8"/><rect x="30" y="36" width="40" height="4" rx="2" fill="#6f7a88"/>';
      else if (r === '2') art = '<path d="M4 44 H22 M2 56 H20 M6 68 H22" stroke="' + GOLD + '" stroke-width="4" stroke-linecap="round"/>' + body('#e0a030') + head(S1) + eyes('#1c1614') + smile + '<rect x="33" y="34" width="34" height="5" rx="2" fill="#cf4a3c"/><path d="M67 36 L80 30 L78 40 Z" fill="#cf4a3c"/>';
      else if (r === '1') art = '<path d="M16 100 Q16 70 50 70 V100 Z" fill="#cf4a3c"/><path d="M50 70 Q84 70 84 100 H50 Z" fill="#e6a93c"/>' + head(S1) + eyes('#1c1614') + '<path d="M41 54 Q50 64 59 54" fill="#fff" stroke="#7a2f2a" stroke-width="1.6"/><path d="M34 38 Q22 22 14 30 Q26 30 30 44 Z" fill="#cf4a3c"/><path d="M66 38 Q78 22 86 30 Q74 30 70 44 Z" fill="#e6a93c"/><path d="M34 40 Q50 26 66 40 Z" fill="#7a5ab5"/><circle cx="14" cy="31" r="3.5" fill="' + GOLD + '"/><circle cx="86" cy="31" r="3.5" fill="' + GOLD + '"/>' + dagger;
      else if (r === 'B') art = jaws(STEEL, '#8a5a2b');
      else art = '<path d="M28 10 V94" stroke="#8a5a2b" stroke-width="5" stroke-linecap="round"/><path d="M30 14 H82 L70 32 L82 50 H30 Z" fill="' + GOLD + '"/><path d="M42 40 L42 28 L47 33 L52 24 L57 33 L62 28 L62 40 Z" fill="#2445b8"/>';
    } else {
      if (r === 'X') art = body('#1b1026') + '<path d="M30 76 L50 92 L70 76" fill="none" stroke="' + GLOW + '" stroke-width="2"/>' + skull + crown('#9aa3ad', 32, GLOW);
      else if (r === '9') art = '<path d="M14 66 Q10 34 44 30 L36 10 L52 27 L58 8 L64 30 Q86 34 92 54 L76 58 L92 68 Q72 82 50 76 Q28 80 14 66 Z" fill="' + DARK + '" stroke="#5a3d7a" stroke-width="2"/><ellipse cx="62" cy="45" rx="6.5" ry="4" fill="#ff4d3d"/><ellipse cx="62" cy="45" rx="1.6" ry="4" fill="' + DARK + '"/><path d="M58 62 L62 70 L66 62 L70 69 L74 61 L78 67 L81 60" fill="none" stroke="' + BONE + '" stroke-width="2.2" stroke-linejoin="round"/><circle cx="86" cy="56" r="1.6" fill="#ff4d3d"/>';
      else if (r === '8') art = '<path d="M16 100 L22 46 L42 72 L58 72 L78 46 L84 100 Z" fill="#8a1220"/><path d="M26 100 L30 62 L44 76 L56 76 L70 62 L74 100 Z" fill="' + DARK + '"/>' + head('#e6e0ea', 14, 17) + '<path d="M36 46 Q34 26 50 26 Q66 26 64 46 Q59 34 50 41 Q41 34 36 46 Z" fill="' + DARK + '"/>' + eyes('#ff4d3d', 48, 2) + '<path d="M44 57 H56" stroke="#8a1220" stroke-width="1.6"/><path d="M45 57 L46.5 62 L48 57 Z M52 57 L53.5 62 L55 57 Z" fill="#fff"/>';
      else if (r === '7') art = body('#2a2433') + '<path d="M34 40 Q16 34 16 14 Q24 28 38 30 Z M66 40 Q84 34 84 14 Q76 28 62 30 Z" fill="#4a4257"/>' + head('#3a3344', 17, 20) + '<rect x="37" y="43" width="26" height="5" rx="2" fill="' + GLOW + '"/><path d="M50 50 V64" stroke="#17131c" stroke-width="2"/>' + sword('#4a4257', GLOW);
      else if (r === '6') art = body('#4a6b3a') + '<path d="M28 46 L14 36 L30 56 Z M72 46 L86 36 L70 56 Z" fill="#5f8a4a"/>' + head('#5f8a4a', 22, 21, 50) + '<path d="M36 40 L46 44 M64 40 L54 44" stroke="#2f4a22" stroke-width="3" stroke-linecap="round"/>' + eyes('#ffd866', 48, 2.4) + '<path d="M38 60 Q50 66 62 60" fill="none" stroke="#2f4a22" stroke-width="2.4"/><path d="M40 62 L42.5 52 L45 62 Z M55 62 L57.5 52 L60 62 Z" fill="' + BONE + '"/>';
      else if (r === '5') art = ribs + skull + bow(BONE);
      else if (r === '4') art = ribs + skull + '<rect x="81" y="36" width="4.5" height="30" rx="2" fill="#8a6a4a"/><rect x="76" y="64" width="14" height="4" rx="2" fill="#5a4632"/>';
      else if (r === '3') art = '<path d="M86 30 V96" stroke="#8a5a2b" stroke-width="4" stroke-linecap="round"/><path d="M79 12 H93 V26 Q86 34 79 26 Z" fill="#8d99a8"/>' + body('#3a3a40') + '<path d="M28 60 Q24 20 50 18 Q76 20 72 60 Q64 46 50 46 Q36 46 28 60 Z" fill="#2c2c33"/><ellipse cx="50" cy="52" rx="13" ry="14" fill="#0e0a14"/>' + eyes(GLOW, 51, 2.2);
      else if (r === '2') art = '<circle cx="66" cy="30" r="17" fill="#d9d2ee" opacity="0.85"/>' + bat(38, 34, 1.5) + bat(66, 58, 1.9) + bat(28, 70, 1.2);
      else if (r === '1') art = '<path d="M34 62 Q12 44 8 60 Q18 58 20 72 Q26 64 34 74 Z M66 62 Q88 44 92 60 Q82 58 80 72 Q74 64 66 74 Z" fill="#7a1a14"/>' + body('#a52a20') + '<path d="M38 36 L32 16 L46 32 Z M62 36 L68 16 L54 32 Z" fill="' + BONE + '"/><path d="M34 48 L20 42 L34 56 Z M66 48 L80 42 L66 56 Z" fill="#c0392b"/>' + head('#c0392b', 15, 16, 48) + eyes('#ffd866', 46, 2.6) + '<path d="M41 55 Q50 63 59 55 Z" fill="#17131c"/><path d="M44 55 L45.5 59 L47 55 Z M53 55 L54.5 59 L56 55 Z" fill="#fff"/>';
      else if (r === 'B') art = jaws(BONE, GLOW);
      else art = '<path d="M28 10 V94" stroke="' + BONE + '" stroke-width="5" stroke-linecap="round"/><path d="M30 14 H82 L74 26 L82 34 L72 42 L80 52 H62 L56 46 L50 54 L44 46 L38 52 H30 Z" fill="' + DARK + '" stroke="#5a3d7a" stroke-width="1.5"/><circle cx="54" cy="30" r="8" fill="' + BONE + '"/><circle cx="51" cy="29" r="2" fill="' + DARK + '"/><circle cx="57" cy="29" r="2" fill="' + DARK + '"/><rect x="50.5" y="36" width="7" height="4" fill="' + BONE + '"/>';
    }
    var el = h('span', { class: 'portrait s' + (evil ? 0 : 1) });
    el.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><radialGradient id="pg' + (evil ? 0 : 1) + '" cx="50%" cy="35%" r="70%"><stop offset="0" stop-color="' + (evil ? '#6a359c' : '#5c8cff') + '"/><stop offset="1" stop-color="' + (evil ? '#160a24' : '#14296e') + '"/></radialGradient><clipPath id="pc"><circle cx="50" cy="50" r="46"/></clipPath></defs>' +
      '<circle cx="50" cy="50" r="46" fill="url(#pg' + (evil ? 0 : 1) + ')"/><g clip-path="url(#pc)">' + art + '</g><circle cx="50" cy="50" r="46" fill="none" stroke="' + (evil ? GLOW : GOLD) + '" stroke-width="3"/></svg>';
    return el;
  }

  /* The card that shows who a piece is: portrait on top, name, power and special rule underneath. */
  function unitCard(G, side, r, note) {
    if (r === '?') return h('section', { class: 'unit s' + side }, portrait(side, '?'),
      h('strong', { class: 'uname', text: 'Unknown enemy' }), h('p', { class: 'urule', text: 'Its power stays hidden until it clashes with one of your pieces.' }));
    var a = G.about(r, side);
    return h('section', { class: 'unit s' + side }, portrait(side, r),
      h('strong', { class: 'uname', text: a.name }),
      h('span', { class: 'upower', text: (a.power ? a.power + ' · ' : '') + a.count + ' in each army' + (note ? ' · ' + note : '') }),
      h('p', { class: 'urule', text: a.rule }));
  }

  function renderFlag(root, g, G, seat) {
    var st = g.state, gid = S.gid, active = g.status === 'active' && !S.readOnly, over = g.status !== 'active';
    if (!S.fl || S.fl.key !== gid) S.fl = { key: gid, sel: -1, dest: -1, sure: false, started: false, show: null };
    var F = S.fl, other = seat >= 0 ? g.players[1 - seat] : null, kids = [], mySide = seat === 1 ? 1 : 0;
    if (!F.show) F.show = { side: mySide, r: 'X' };
    var legendFor = function (side) {
      return h('ul', { class: 'legend' }, G.order.map(function (r) {
        return h('li', null, h('button', { class: 'fp s' + side, type: 'button', 'aria-label': 'Show ' + G.names[side][r], onclick: function () { F.show = { side: side, r: r }; render(); } }, pieceFace(r)),
          h('span', { text: G.names[side][r] + ' ×' + G.counts[r] }));
      }));
    };
    var legend = h('details', { class: 'help' }, h('summary', { text: 'The two armies' }),
      h('p', { class: 'note', text: 'Tap a piece to see its portrait.' }),
      h('div', { class: 'armies' }, h('div', null, h('span', { class: 'label', text: 'Evil army' }), legendFor(0)), h('div', null, h('span', { class: 'label', text: 'Good army' }), legendFor(1))));

    if (st.phase === 'setup') {
      // The host's screen readies any AI player and starts the battle once both sides are ready.
      if (active && seat >= 0 && !F.started) setTimeout(function () {
        var cur = S.games[gid];
        if (!cur || cur.status !== 'active' || cur.state.phase !== 'setup' || S.fl.key !== gid || S.fl.started) return;
        var ready = cur.state.ready, mine = cur.host === S.me.id;
        if (mine) cur.players.forEach(function (p, k) { if (p.ai && !ready['s' + k]) patch(gid, ['state', 'ready', 's' + k], 1); });
        ready = S.games[gid].state.ready;
        if (!ready.s0 || !ready.s1) return;
        var go = function () {
          var c2 = S.games[gid];
          if (c2 && c2.status === 'active' && c2.state.phase === 'setup' && !S.fl.started) { S.fl.started = true; applyMove(gid, { start: 1 }); }
        };
        if (mine) go(); else setTimeout(go, 4000);
      }, 0);

      if (seat >= 0) {
        var mine = st.setup['s' + seat], amReady = !!st.ready['s' + seat];
        var cells = [];
        for (var k = 0; k < 40; k++) (function (k) {
          cells.push(h('button', { class: 'fp s' + seat + (F.sel === k ? ' sel' : ''), type: 'button', disabled: !active,
            'aria-label': G.label(mine[k], seat) + ', row ' + (Math.floor(k / 10) + 1) + ', column ' + (k % 10 + 1),
            onclick: function () {
              F.sure = false; F.show = { side: seat, r: mine[k] };
              if (amReady) return render();
              if (F.sel < 0) { F.sel = k; return render(); }
              if (F.sel !== k) {
                var a = mine.split(''), t = a[k]; a[k] = a[F.sel]; a[F.sel] = t;
                patch(gid, ['state', 'setup', 's' + seat], a.join(''));
              }
              F.sel = -1; render();
            } }, pieceFace(mine[k])));
        })(k);
        kids.push(unitCard(G, F.show.side, F.show.r));
        kids.push(h('section', { class: 'fsetup' },
          h('p', { class: 'note', text: amReady ? 'You are ready. Waiting for ' + pname(other) + '.' : 'The top row is your front line. Tap two pieces to swap them.' }),
          h('div', { class: 'fgrid setup' }, cells),
          F.sel >= 0 ? h('p', { class: 'readout', text: G.label(mine[F.sel], seat) + ' picked. Tap where it should go.' }) : null,
          amReady || !active ? null : h('div', { class: 'sure' },
            h('button', { class: 'btn big', type: 'button', id: 'shuffle', onclick: function () { F.sel = -1; F.sure = false; patch(gid, ['state', 'setup', 's' + seat], G.newSetup()); render(); } }, 'Shuffle my pieces'),
            h('button', { class: 'btn primary big', type: 'button', id: 'ready', onclick: function () {
              if (!F.sure) { F.sure = true; return render(); }
              F.sure = false; F.sel = -1; patch(gid, ['state', 'ready', 's' + seat], 1); render();
            } }, F.sure ? 'Tap again to lock in this setup' : 'I am ready'))));
      } else kids.push(h('p', { class: 'note', text: 'Both armies are taking their places.' }));
    } else {
      var flip = seat === 1, me = String(seat), myTurn = active && seat === st.turn;
      var moves = myTurn ? legalMoves(g) : [], canFrom = {}, dests = {};
      if (!myTurn) { F.sel = -1; F.dest = -1; }
      moves.forEach(function (m) { canFrom[m.from] = 1; if (m.from === F.sel) dests[m.to] = 1; });
      if (F.sel >= 0 && !canFrom[F.sel]) { F.sel = -1; F.dest = -1; }
      if (F.dest >= 0 && !dests[F.dest]) F.dest = -1;
      var board = h('div', { class: 'fgrid field', role: 'grid', 'aria-label': 'The field' });
      for (var i = 0; i < 100; i++) (function (idx) {
        var o = st.own[idx], cls = 'fc', label = 'Row ' + (Math.floor(idx / 10) + 1) + ', column ' + (idx % 10 + 1), kid = null, known = false;
        if (o === '#') { cls += ' pond'; label += ', pond'; }
        else if (o !== '.') {
          known = o === me || st.seen[idx] === '1' || over || seat < 0 && st.seen[idx] === '1';
          kid = h('span', { class: 'fp s' + o + (known ? '' : ' hid') + (o === me && st.seen[idx] === '1' ? ' shown' : '') }, known ? pieceFace(st.rk[idx]) : h('span', { class: 'pn', text: '?' }));
          label += ', ' + (o === me ? 'your ' : 'enemy ') + (known ? G.label(st.rk[idx], +o) : 'hidden piece');
        }
        if (st.last && st.last.from === idx) cls += ' from';
        if (st.last && st.last.to === idx) cls += ' to';
        if (idx === F.sel) cls += ' sel';
        if (idx === F.dest) cls += ' aim';
        if (canFrom[idx]) cls += ' can';
        var b = h('button', { class: cls, type: 'button', 'aria-label': label, onclick: function () {
          if (o === '0' || o === '1') F.show = { side: +o, r: known ? st.rk[idx] : '?' };
          if (myTurn) {
            if (canFrom[idx]) { F.sel = F.sel === idx ? -1 : idx; F.dest = -1; }
            else if (dests[idx]) F.dest = idx;
            else { F.sel = -1; F.dest = -1; }
          }
          render();
        } }, kid);
        if (dests[idx] && idx !== F.dest) b.appendChild(h('span', { class: 'dot' + (o !== '.' ? ' ring' : '') }));
        board.appendChild(b);
      })(flip ? 99 - i : i);

      var bare = function (n) { return n.replace(/^The /, ''); };
      var whoOf = function (s2) { return s2 === seat ? 'Your ' : pname(g.players[s2]) + '’s '; };
      var clashText = function (s2, a, d, res) {
        var A = bare(G.label(a, s2)), D = 'the ' + bare(G.label(d, 1 - s2));
        return whoOf(s2) + A + (res === 'f' ? ' captured ' + D : res === 'w' ? ' defeated ' + D : res === 'l' ? ' fell to ' + D : ' and ' + D + ' destroyed each other') + '.';
      };
      var tok = function (side, r, cls) {
        return h('button', { class: 'fp s' + side + (cls || ''), type: 'button', 'aria-label': 'Show ' + G.names[side][r], onclick: function () { F.show = { side: side, r: r }; render(); } }, pieceFace(r));
      };

      // The last move: an arrow on the field, a flash on the squares, and a line of text that stays until the next move.
      var L = st.last, moveLine = null;
      if (L) {
        if (F.animN !== g.n) { F.animN = g.n; F.animAt = Date.now(); }
        var lag = '-' + Math.min(6000, Date.now() - F.animAt) + 'ms';
        var at = function (idx) { var v = flip ? 99 - idx : idx; return [(v % 10) * 10 + 5, Math.floor(v / 10) * 10 + 5]; };
        var p1 = at(L.from), p2 = at(L.to), dx = p2[0] - p1[0], dy = p2[1] - p1[1], len = Math.hypot(dx, dy) || 1;
        var ex = p2[0] - dx / len * 7.4, ey = p2[1] - dy / len * 7.4;      // stop at the edge of the square so the piece stays readable
        var arrow = h('div', { class: 'farrow' + (L.seat !== seat ? ' theirs' : '') });
        arrow.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><marker id="fah" markerWidth="4" markerHeight="4" refX="1.6" refY="2" orient="auto"><path d="M0 0 L4 2 L0 4 Z" fill="currentColor"/></marker></defs>' +
          '<line x1="' + p1[0] + '" y1="' + p1[1] + '" x2="' + (p2[0] - dx / len * 5.6) + '" y2="' + (p2[1] - dy / len * 5.6) + '" stroke="rgba(0,0,0,0.6)" stroke-width="3.4" stroke-linecap="round"/>' +
          '<line x1="' + p1[0] + '" y1="' + p1[1] + '" x2="' + ex + '" y2="' + ey + '" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" marker-end="url(#fah)"/>' +
          '<circle cx="' + p1[0] + '" cy="' + p1[1] + '" r="2.4" fill="currentColor"/></svg>';
        arrow.style.animationDelay = lag;
        board.appendChild(arrow);
        Array.prototype.forEach.call(board.querySelectorAll('.fc.to'), function (c) { c.style.animationDelay = lag; });

        var txt;
        if (L.res !== 'move') txt = clashText(L.seat, L.a, L.d, L.res[0]);
        else {
          var dr = Math.floor(L.to / 10) - Math.floor(L.from / 10), dc = L.to % 10 - L.from % 10;
          if (flip) { dr = -dr; dc = -dc; }
          var far = Math.abs(dr) + Math.abs(dc), own = L.seat === seat;
          var dir = dr ? (seat < 0 ? (dr < 0 ? 'up the field' : 'down the field') : own ? (dr < 0 ? 'forward' : 'back') : (dr > 0 ? 'toward you' : 'away from you')) : dc < 0 ? 'to the left' : 'to the right';
          var plain = L.seat === seat || st.seen[L.to] === '1' || over;
          txt = (L.seat === seat ? 'You moved your ' + bare(G.label(L.a, L.seat)) : pname(g.players[L.seat]) + ' moved ' + (plain ? 'the ' + bare(G.label(L.a, L.seat)) : 'a hidden piece')) +
            ' ' + far + (far === 1 ? ' square ' : ' squares ') + dir + '.';
        }
        moveLine = h('p', { class: 'lastmove' + (L.res !== 'move' ? ' clash' : '') + (L.seat !== seat ? ' theirs' : ''), role: 'status' },
          h('span', { class: 'label', text: L.seat === seat ? 'Your last move' : 'Their last move' }), h('span', { text: txt }));
        moveLine.style.animationDelay = lag;
      }

      // Every clash so far in this battle, newest first.
      var fights = (st.fights || []).slice().reverse();
      var clashes = h('section', { class: 'clashes' }, h('h3', { text: 'Clashes' }),
        fights.length ? h('ul', null, fights.slice(0, 8).map(function (f, k) {
          var s2 = +f[0], a = f[1], d = f[2], res = f[3], ago = (st.mc || 0) - (+f.split(':')[1] || 0);
          var aGone = res === 'l' || res === 't', dGone = res !== 'l';
          return h('li', { class: k === 0 ? 'newest' : null },
            h('div', { class: 'duel' }, tok(s2, a, aGone ? ' gone' : ''), h('span', { class: 'vs', text: res === 't' ? 'tied' : res === 'l' ? 'lost to' : 'beat' }), tok(1 - s2, d, dGone ? ' gone' : '')),
            h('span', { class: 'ctext', text: clashText(s2, a, d, res) }),
            h('span', { class: 'ago', text: ago <= 0 ? 'just now' : ago === 1 ? '1 move ago' : ago + ' moves ago' }));
        })) : h('p', { class: 'none', text: 'No clashes yet. Ranks stay hidden until two pieces meet.' }),
        fights.length > 8 ? h('p', { class: 'none', text: 'Showing the latest 8.' }) : null);

      var tray = function (o) {
        var have = {}, out = [];
        for (var q = 0; q < 100; q++) if (st.own[q] === o) have[st.rk[q]] = (have[st.rk[q]] || 0) + 1;
        G.order.forEach(function (r) { var n = G.counts[r] - (have[r] || 0); if (n > 0) out.push(h('span', { class: 'cap' }, tok(+o, r), n > 1 ? h('em', { text: '×' + n }) : null)); });
        return out.length ? h('div', { class: 'caprow' }, out) : h('span', { class: 'none', text: 'Nothing yet' });
      };
      var caps = seat >= 0
        ? [h('div', null, h('span', { class: 'label', text: 'You have taken' }), tray(String(1 - seat))), h('div', null, h('span', { class: 'label', text: 'You have lost' }), tray(me))]
        : [h('div', null, h('span', { class: 'label', text: pname(g.players[0]) + ' has lost' }), tray('0')), h('div', null, h('span', { class: 'label', text: pname(g.players[1]) + ' has lost' }), tray('1'))];

      kids.push(board);
      if (moveLine) kids.push(moveLine);
      if (myTurn) kids.push(h('button', { class: 'btn primary big', type: 'button', id: 'fl-go', disabled: F.dest < 0,
        onclick: function () { var mv = { from: F.sel, to: F.dest }; F.sel = -1; F.dest = -1; applyMove(gid, mv); } },
        F.sel < 0 ? 'Tap one of your pieces' : F.dest < 0 ? G.label(st.rk[F.sel], seat) + ' picked. Tap where it goes' : (st.own[F.dest] === '.' ? 'Move ' : 'Attack with ') + G.label(st.rk[F.sel], seat)));
      kids.push(clashes);
      kids.push(h('section', { class: 'caps' }, caps));
      kids.push(unitCard(G, F.show.side, F.show.r));
    }

    var foot = footer(g, seat);
    root.replaceChildren.apply(root, [topBar(G, seat < 0 ? 'Watching' : G.seats[seat]), foot[0]].concat(kids, [foot[1], legend, helpBox(G)]).filter(Boolean));
  }

  /* ---------------------------------------------------------------- Iron Roads */
  var RAIL_FILL = { r: '#d6403a', o: '#ee8d2c', y: '#f2d13c', g: '#3fa34d', b: '#3d72d9', p: '#9152c9', k: '#2b2b2e', w: '#f3f0e6', x: '#a9adb3', A: '#e2e2e2' };
  var RAIL_MARK = { r: '◆', o: '▲', y: '●', g: '♣', b: '■', p: '♠', k: '✖', w: '✚', A: '★' };
  var RAIL_PLAYER = ['#e8459f', '#1fc3d6', '#a6dd3a', '#c48a3a'];
  /* Where a town's name sits: x and baseline offsets and anchor, chosen per town by the map generator to avoid other names and routes. */
  var RAIL_LABEL = [[20, 8, 'start'], [-20, 8, 'end'], [0, -22, 'middle'], [0, 36, 'middle'], [15, -16, 'start'], [-15, -16, 'end'], [15, 30, 'start'], [-15, 30, 'end'], [20, -6, 'start'], [-20, -6, 'end'], [20, 24, 'start'], [-20, 24, 'end']];

  function railGeom(M, r) {
    var R = M.routes[r], A = M.towns[R[0]], B = M.towns[R[1]];
    var ax = A[1], ay = A[2], bx = B[1], by = B[2], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy), nx = dy / len, ny = -dx / len;
    var off = R[5] < 0 ? 0 : (r < R[5] ? -8 : 8);
    ax += nx * off; ay += ny * off; bx += nx * off; by += ny * off;
    var cx = (ax + bx) / 2 + nx * R[4] * 2, cy = (ay + by) / 2 + ny * R[4] * 2;
    var pts = [], total = 0, prev = null;
    for (var i = 0; i <= 60; i++) {
      var t = i / 60, u = 1 - t, x = u * u * ax + 2 * u * t * cx + t * t * bx, y = u * u * ay + 2 * u * t * cy + t * t * by;
      if (prev) total += Math.hypot(x - prev[0], y - prev[1]);
      pts.push([x, y, total]); prev = [x, y];
    }
    var at = function (d) {
      for (var k = 1; k < pts.length; k++) if (pts[k][2] >= d) {
        var a = pts[k - 1], b = pts[k], f = (d - a[2]) / ((b[2] - a[2]) || 1);
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI];
      }
      var z = pts[pts.length - 1], y2 = pts[pts.length - 2];
      return [z[0], z[1], Math.atan2(z[1] - y2[1], z[0] - y2[0]) * 180 / Math.PI];
    };
    return { d: 'M' + ax.toFixed(1) + ' ' + ay.toFixed(1) + ' Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + bx.toFixed(1) + ' ' + by.toFixed(1), total: total, at: at };
  }

  function railSvg(G, st, ui, seat) {
    var out = [], hi = {}, rings = {};
    if (ui.sel && ui.sel.kind === 'route') hi[ui.sel.id] = 'sel';
    if (st.last && st.last.k === 'claim') hi[st.last.r] = hi[st.last.r] || 'last';
    (ui.show || []).forEach(function (t) { rings[t] = 1; });
    if (ui.sel && ui.sel.kind === 'town') rings[ui.sel.id] = 1;
    var M = G.mapOf(st), top = M.minY || 0;
    out.push('<svg viewBox="0 ' + top + ' ' + M.w + ' ' + (M.h - top) + '" role="img" aria-label="Railway map of ' + M.name + '">');
    if (M.land) out.push('<rect x="0" y="' + top + '" width="' + M.w + '" height="' + (M.h - top) + '" class="rwater"/>' +
      (M.near ? '<path d="' + M.near + '" class="rnear"/>' : '') + '<path d="' + M.land + '" class="rland"/>' + (M.lakes ? '<path d="' + M.lakes + '" class="rlake"/>' : ''));
    M.routes.forEach(function (R, r) {
      var geo = railGeom(M, r), n = R[2], trim = 20, seg = (geo.total - trim * 2) / n, o = st.own[r];
      var mine = o !== '.', fill = mine ? RAIL_PLAYER[+o] : RAIL_FILL[R[3]], dim = !mine && G.blocked(st, r, seat < 0 ? 0 : seat) && st.n <= 3 ? ' opacity="0.3"' : '';
      if (hi[r]) out.push('<path d="' + geo.d + '" fill="none" stroke="' + (hi[r] === 'sel' ? '#ffffff' : '#ffd24a') + '" stroke-width="' + (hi[r] === 'sel' ? 26 : 22) + '" stroke-linecap="round" opacity="0.85" class="' + (hi[r] === 'last' ? 'rlast' : '') + '"/>');
      if (mine) {                               // a claimed route becomes one solid band in the owner's color
        var cut = function (d) { var q = geo.at(d); return q[0].toFixed(1) + ' ' + q[1].toFixed(1); };
        var band = 'M' + cut(trim - 4);
        for (var q = 1; q <= 24; q++) band += ' L' + cut(trim - 4 + (geo.total - trim * 2 + 8) * q / 24);
        out.push('<path d="' + band + '" fill="none" stroke="#0b0b0b" stroke-width="21" stroke-linecap="round"/><path d="' + band + '" fill="none" stroke="' + fill + '" stroke-width="14" stroke-linecap="round"/>');
        for (var j = 0; j < n; j++) { var c2 = geo.at(trim + seg * (j + 0.5)); out.push('<circle cx="' + c2[0].toFixed(1) + '" cy="' + c2[1].toFixed(1) + '" r="3.6" fill="#fff" stroke="#0b0b0b" stroke-width="1.2"/>'); }
      }
      for (var i = 0; i < n && !mine; i++) {
        var p = geo.at(trim + seg * (i + 0.5)), w = Math.max(8, seg - 5);
        out.push('<g transform="translate(' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ') rotate(' + p[2].toFixed(1) + ')"' + dim + '><rect x="' + (-w / 2).toFixed(1) + '" y="-6.5" width="' + w.toFixed(1) + '" height="13" rx="3" fill="' + fill + '" stroke="' + (mine ? '#101010' : 'rgba(0,0,0,0.55)') + '" stroke-width="' + (mine ? 2.4 : 1.4) + '"/>' +
          (mine ? '<circle r="3.2" fill="#fff"/>' : '') + '</g>');
      }
      out.push('<path d="' + geo.d + '" fill="none" stroke="transparent" stroke-width="' + (R[5] < 0 ? 26 : 14) + '" data-r="' + r + '" class="rhit"/>');
    });
    var names = [], hits = [];
    M.towns.forEach(function (T, t) {
      var L = RAIL_LABEL[T[3] === undefined ? 3 : T[3]];
      if (rings[t]) out.push('<circle cx="' + T[1] + '" cy="' + T[2] + '" r="25" fill="none" stroke="#ffd24a" stroke-width="6"/>');
      out.push('<circle cx="' + T[1] + '" cy="' + T[2] + '" r="12" fill="#f4ecd9" stroke="#1c1614" stroke-width="3.5"/>');
      names.push('<text x="' + (T[1] + L[0]) + '" y="' + (T[2] + L[1] * (M.fs || 25) / 25) + '" text-anchor="' + L[2] + '" font-size="' + (M.fs || 25) + '" class="rtown' + (rings[t] ? ' on' : '') + '">' + T[0] + '</text>');
      hits.push('<circle cx="' + T[1] + '" cy="' + T[2] + '" r="30" fill="transparent" data-t="' + t + '" class="rhit"/>');
    });
    out.push(names.join(''), hits.join(''));
    out.push('</svg>');
    return out.join('');
  }

  function railCard(c, n, extra) {
    return [h('span', { class: 'rmark', text: RAIL_MARK[c] + '︎', 'aria-hidden': 'true' }),
      h('span', { class: 'rname', text: GAMES.ironroads.colors[c] }), n !== undefined ? h('strong', { class: 'rcount', text: String(n) }) : null, extra || null];
  }

  function renderRails(root, g, G, seat) {
    var st = g.state, gid = S.gid, active = g.status === 'active' && !S.readOnly, over = !!st.over || g.status !== 'active';
    var myTurn = active && seat === st.turn && !over, MAP = G.mapOf(st), T = MAP.towns;
    if (!S.rr || S.rr.key !== gid) S.rr = { key: gid, n: -1, sel: null, pay: '', card: -2, keep: {}, zoom: false, sure: false, show: [] };
    var U = S.rr;
    if (U.n !== g.n) { U.n = g.n; U.card = -2; U.pay = ''; U.sure = false; U.keep = {}; if (U.sel && U.sel.kind === 'route' && st.own[U.sel.id] !== '.') U.sel = null; }
    var tn = function (i) { return T[i][0]; };
    var rname = function (r) { var R = MAP.routes[r]; return tn(R[0]) + ' – ' + tn(R[1]); };
    var who = function (i) { return pname(g.players[i]) + (i === seat ? ' (you)' : ''); };
    var text = function (t) { return t.replace(/@(\d)/g, function (m, d) { return pname(g.players[+d]); }); };
    var hand = seat >= 0 ? st.hands[seat] : null;
    var moves = myTurn ? legalMoves(g) : [];
    var kids = [];

    // Map
    var map = h('div', { class: 'rmap' + (U.zoom ? ' zoom' : '') });
    map.innerHTML = railSvg(G, st, U, seat);
    map.addEventListener('click', function (ev) {
      var el = ev.target.closest('[data-r],[data-t]');
      if (!el) return;
      if (el.hasAttribute('data-r')) U.sel = { kind: 'route', id: +el.getAttribute('data-r') };
      else U.sel = { kind: 'town', id: +el.getAttribute('data-t') };
      U.pay = ''; U.sure = false; render();
    });
    kids.push(h('section', { class: 'rmapwrap' }, h('p', { class: 'rmapname', text: 'Map: ' + MAP.name }), map,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', id: 'rr-zoom', onclick: function () { U.zoom = !U.zoom; render(); } }, U.zoom ? 'Fit the map to the screen' : 'Make the map bigger'),
        U.show.length ? h('button', { class: 'btn small ghost', type: 'button', onclick: function () { U.show = []; render(); } }, 'Clear highlights') : null)));

    // Last move
    if (st.log.length > 1) kids.push(h('p', { class: 'lastmove' + (st.last && st.last.seat !== seat ? ' theirs' : '') + (st.last && st.last.k === 'claim' ? ' clash' : '') },
      h('span', { class: 'label', text: 'Latest' }), h('span', { text: text(st.log[st.log.length - 1]) })));

    // Choosing tickets
    if (st.step === 'keep' && myTurn) {
      var offer = G.list(st.offer), min = st.phase === 'start' ? Math.min(2, offer.length) : 1, chosen = offer.filter(function (c) { return U.keep[c]; });
      kids.push(h('section', { class: 'rpanel keep' },
        h('h3', { text: st.phase === 'start' ? 'Pick your first destination tickets' : 'New destination tickets' }),
        h('p', { class: 'note', text: 'Keep at least ' + min + '. Tickets you finish add their points. Unfinished ones are taken away at the end.' }),
        h('div', { class: 'rtix' }, offer.map(function (c) {
          var Tk = MAP.tickets[parseInt(c, 36)], on = !!U.keep[c];
          return h('button', { class: 'rticket' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: function () {
            U.keep[c] = !on; U.show = [Tk[0], Tk[1]]; render();
          } }, h('span', { class: 'rt-towns', text: tn(Tk[0]) + ' to ' + tn(Tk[1]) }), h('strong', { class: 'rt-pts', text: Tk[2] + ' pts' }), h('span', { class: 'rt-tick', text: on ? 'Keeping' : 'Tap to keep' }));
        })),
        h('button', { class: 'btn primary big', type: 'button', id: 'rr-keep', disabled: chosen.length < min,
          onclick: function () { U.show = []; applyMove(gid, { k: 'keep', t: chosen.join('') }); } },
          chosen.length < min ? 'Pick at least ' + min : 'Keep ' + chosen.length + (chosen.length === 1 ? ' ticket' : ' tickets'))));
    } else if (st.step === 'keep' && !over) {
      kids.push(h('p', { class: 'note', text: who(st.turn) + ' is choosing destination tickets.' }));
    }

    // Selected route or town
    if (U.sel && st.step !== 'keep') {
      if (U.sel.kind === 'town') {
        var mineR = [];
        MAP.routes.forEach(function (R, r) { if (R[0] === U.sel.id || R[1] === U.sel.id) mineR.push(r); });
        kids.push(h('section', { class: 'rpanel' }, h('h3', { text: tn(U.sel.id) }), h('p', { class: 'note', text: 'Routes from here. Tap one to look at it.' }),
          h('div', { class: 'rlist' }, mineR.map(function (r) {
            var R = MAP.routes[r], o = st.own[r];
            return h('button', { class: 'rrow', type: 'button', onclick: function () { U.sel = { kind: 'route', id: r }; render(); } },
              h('span', { class: 'rchip c-' + R[3] }, railCard(R[3])), h('span', { class: 'rrname', text: rname(r) }),
              h('span', { class: 'rmeta', text: R[2] + (R[2] === 1 ? ' train' : ' trains') + (o !== '.' ? ', ' + pname(g.players[+o]) + '’s' : '') }));
          }))));
      } else {
        var r = U.sel.id, R = MAP.routes[r], o = st.own[r], opts = [], why = '';
        if (o !== '.') why = 'Claimed by ' + who(+o) + '.';
        else if (seat >= 0 && G.blocked(st, r, seat)) why = st.own[R[5]] === String(seat) ? 'You already have the other half of this double route.' : 'With 2 or 3 players only one half of a double route can be used.';
        else if (seat >= 0 && R[2] > st.trains[seat]) why = 'You only have ' + st.trains[seat] + ' trains left.';
        else if (seat >= 0) {
          opts = G.pay(st, r, seat);
          if (!opts.length) {
            if (R[3] === 'x') why = 'You need ' + R[2] + ' cards of one color, counting locomotives.';
            else why = 'You need ' + (R[2] - hand[G.cards.indexOf(R[3])] - hand[8]) + ' more ' + G.colors[R[3]].toLowerCase() + ' cards or locomotives.';
          }
        }
        if (opts.length && !opts.some(function (q) { return q.x === U.pay; })) U.pay = opts.length === 1 ? opts[0].x : '';
        var canClaim = myTurn && st.step !== 'second' && opts.length > 0;
        kids.push(h('section', { class: 'rpanel' },
          h('h3', { text: rname(r) }),
          h('p', { class: 'rfacts' }, h('span', { class: 'rchip c-' + R[3] }, railCard(R[3])),
            h('span', { text: R[2] + (R[2] === 1 ? ' train' : ' trains') + ' · ' + G.points[R[2]] + (G.points[R[2]] === 1 ? ' point' : ' points') + (R[5] >= 0 ? ' · double route' : '') })),
          why ? h('p', { class: 'note', text: why }) : null,
          canClaim && opts.length > 1 ? h('div', { class: 'rlist' }, opts.map(function (q) {
            return h('button', { class: 'rrow' + (U.pay === q.x ? ' on' : ''), type: 'button', 'aria-pressed': U.pay === q.x ? 'true' : 'false', onclick: function () { U.pay = q.x; render(); } },
              h('span', { class: 'rchip c-' + q.x }, railCard(q.x)),
              h('span', { class: 'rrname', text: (q.color ? q.color + ' ' + G.colors[q.x].toLowerCase() : '') + (q.color && q.wild ? ' + ' : '') + (q.wild ? q.wild + (q.wild === 1 ? ' locomotive' : ' locomotives') : '') }));
          })) : null,
          canClaim ? h('button', { class: 'btn primary big', type: 'button', id: 'rr-claim', disabled: !U.pay, onclick: function () { applyMove(gid, { k: 'claim', r: r, x: U.pay }); } },
            U.pay ? 'Claim this route' : 'Choose how to pay') : null,
          myTurn && st.step === 'second' && opts.length ? h('p', { class: 'note', text: 'Take your second card first. You can claim on a later turn.' }) : null,
          h('button', { class: 'btn small ghost', type: 'button', onclick: function () { U.sel = null; render(); } }, 'Close')));
      }
    }

    // Taking cards
    if (myTurn && st.step !== 'keep') {
      var up = st.up.split(''), deckLeft = G.list(st.deck).length + G.list(st.disc).length;
      var pickCard = function (i) { U.card = U.card === i ? -2 : i; render(); };
      var cardBtns = up.map(function (c, i) {
        if (c === '.') return h('span', { class: 'rcard empty' });
        var off = st.step === 'second' && c === 'A';
        return h('button', { class: 'rcard c-' + c + (U.card === i ? ' on' : ''), type: 'button', disabled: off, 'aria-pressed': U.card === i ? 'true' : 'false', onclick: function () { pickCard(i); } }, railCard(c));
      });
      cardBtns.push(h('button', { class: 'rcard deck' + (U.card === -1 ? ' on' : ''), type: 'button', disabled: !deckLeft, onclick: function () { pickCard(-1); } },
        h('span', { class: 'rmark', text: '?' }), h('span', { class: 'rname', text: 'Deck' }), h('strong', { class: 'rcount', text: String(G.list(st.deck).length) })));
      var label = U.card === -2 ? (st.step === 'second' ? 'Tap your second card' : 'Tap a card to take') : U.card === -1 ? 'Take the top card of the deck' : 'Take the ' + G.colors[up[U.card]].toLowerCase() + (up[U.card] === 'A' ? ' (it counts as both cards)' : ' card');
      kids.push(h('section', { class: 'rpanel' }, h('h3', { text: st.step === 'second' ? 'Take your second card' : 'Take train cards' }),
        st.step === 'second' ? h('p', { class: 'note', text: 'A face-up locomotive cannot be your second card.' }) : null,
        h('div', { class: 'rmarket' }, cardBtns),
        h('button', { class: 'btn primary big', type: 'button', id: 'rr-take', disabled: U.card === -2, onclick: function () { applyMove(gid, { k: 'card', i: U.card }); } }, label)));

      if (st.step !== 'second') {
        var claimable = [];
        moves.forEach(function (m) { if (m.k === 'claim' && claimable.indexOf(m.r) < 0) claimable.push(m.r); });
        claimable.sort(function (a, b) { return MAP.routes[b][2] - MAP.routes[a][2] || rname(a).localeCompare(rname(b)); });
        kids.push(h('details', { class: 'rpanel', open: claimable.length > 0 && claimable.length <= 8 ? true : null },
          h('summary', { text: claimable.length ? 'Routes you can claim now (' + claimable.length + ')' : 'No routes you can claim yet' }),
          h('div', { class: 'rlist' }, claimable.map(function (r) {
            var R = MAP.routes[r];
            return h('button', { class: 'rrow' + (U.sel && U.sel.id === r && U.sel.kind === 'route' ? ' on' : ''), type: 'button', onclick: function () { U.sel = { kind: 'route', id: r }; U.pay = ''; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
              h('span', { class: 'rchip c-' + R[3] }, railCard(R[3])), h('span', { class: 'rrname', text: rname(r) }), h('span', { class: 'rmeta', text: R[2] + ' · +' + G.points[R[2]] }));
          }))));
        if (G.list(st.tdeck).length) kids.push(h('button', { class: 'btn big', type: 'button', id: 'rr-tickets', onclick: function () {
          if (!U.sure) { U.sure = true; return render(); }
          applyMove(gid, { k: 'tickets' });
        } }, U.sure ? 'Tap again to draw 3 destination tickets' : 'Draw more destination tickets'));
      }
    }

    // Your hand and tickets
    if (seat >= 0) {
      kids.push(h('section', { class: 'rpanel' }, h('h3', { text: 'Your train cards' }),
        h('div', { class: 'rhand' }, G.cards.split('').map(function (c, i) {
          return h('span', { class: 'rcard small c-' + c + (hand[i] ? '' : ' none') }, railCard(c, hand[i]));
        }))));
      var mine = G.ticketIds(st.tix[seat]);
      kids.push(h('section', { class: 'rpanel' }, h('h3', { text: 'Your destination tickets' }),
        mine.length ? h('div', { class: 'rlist' }, mine.map(function (t) {
          var Tk = MAP.tickets[t], done = G.ticketDone(st, seat, t), on = U.show[0] === Tk[0] && U.show[1] === Tk[1];
          return h('button', { class: 'rrow' + (on ? ' on' : '') + (done ? ' done' : ''), type: 'button', onclick: function () { U.show = on ? [] : [Tk[0], Tk[1]]; render(); } },
            h('span', { class: 'rdone', text: done ? '✓' : '•' }), h('span', { class: 'rrname', text: tn(Tk[0]) + ' to ' + tn(Tk[1]) }),
            h('span', { class: 'rmeta', text: Tk[2] + ' pts' + (done ? ', done' : '') }));
        })) : h('p', { class: 'none', text: 'None yet.' }),
        mine.length ? h('p', { class: 'note', text: 'Tap a ticket to ring its towns on the map.' }) : null));
    }

    // Players
    kids.push(h('section', { class: 'rpanel' }, h('h3', { text: over ? 'Final scores' : 'Players' }),
      h('ul', { class: 'rplayers' }, g.players.map(function (p, i) {
        var cards = st.hands[i].reduce(function (a, b) { return a + b; }, 0), tix = G.ticketIds(st.tix[i]).length;
        var line = over && st.res
          ? 'Routes ' + st.res[i][0] + ', tickets +' + st.res[i][1] + (st.res[i][2] ? ' −' + st.res[i][2] : '') + (st.res[i][3] ? ', longest line +10' : '') + ' (' + st.res[i][6] + ' trains long)'
          : st.trains[i] + ' trains left · ' + cards + ' cards · ' + tix + (tix === 1 ? ' ticket' : ' tickets');
        return h('li', { class: st.turn === i && !over ? 'on' : null },
          h('span', { class: 'rswatch', style: 'background:' + RAIL_PLAYER[i] }),
          h('div', { class: 'cwho' }, h('strong', { text: who(i) }), h('span', { text: line })),
          h('span', { class: 'score', text: (over && st.res ? st.res[i][4] : st.pts[i]) + ' pts' }));
      })),
      !over ? h('p', { class: 'note', text: 'Scores show route points only. Tickets and the longest line are added at the end.' }) : null,
      st.final > 0 && !over ? h('p', { class: 'note warn', text: 'Last round: ' + st.final + (st.final === 1 ? ' turn' : ' turns') + ' left.' }) : null));

    if (over) {
      kids.push(h('section', { class: 'rpanel' }, h('h3', { text: 'Everyone’s tickets' }),
        h('ul', { class: 'rplayers' }, g.players.map(function (p, i) {
          return h('li', null, h('span', { class: 'rswatch', style: 'background:' + RAIL_PLAYER[i] }),
            h('div', { class: 'cwho' }, h('strong', { text: who(i) }),
              h('span', { text: G.ticketIds(st.tix[i]).map(function (t) { var Tk = MAP.tickets[t]; return (G.ticketDone(st, i, t) ? '✓ ' : '✗ ') + tn(Tk[0]) + '–' + tn(Tk[1]) + ' ' + Tk[2]; }).join(', ') })));
        }))));
    }
    kids.push(h('ul', { class: 'clog' }, st.log.slice().reverse().map(function (t) { return h('li', { text: text(t) }); })));

    var foot = footer(g, seat);
    root.replaceChildren.apply(root, [topBar(G, seat < 0 ? 'Watching' : st.trains[seat] + ' trains'), foot[0]].concat(kids, [foot[1], helpBox(G)]).filter(Boolean));
  }

  /* -------------------------------------------------------------------- render */
  function render() {
    $('#splash').hidden = S.ready;
    $('#lobby').hidden = !S.ready || S.view !== 'lobby';
    $('#game').hidden = !S.ready || S.view !== 'game';
    var me = $('#me');
    me.hidden = !S.ready || !S.me.name;
    me.textContent = S.me.name ? S.me.name + ' ✎' : '';
    var note = $('#note');
    note.hidden = !S.note; note.textContent = S.note;
    if (!S.ready) { renderSheet(); return; }
    if (S.view === 'game') renderGame(); else renderLobby();
    renderSheet();
  }

  $('#me').addEventListener('click', openNameSheet);
  boot();
})();
