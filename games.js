/* Family Game Night: game rules and AI players.
   Each game exposes the same interface, so adding a game means adding one more entry to GAMES:
     id, name, blurb, min, max, seats[]         basics for the lobby
     cats[]                                     lobby filters it appears under: classic, cards, young, modern
     like                                       optional: the well-known game this one is similar to, shown as a tag
     init(playerCount, options) -> state        plain JSON, state.turn is the seat to move
     options[]                                  optional: on/off settings offered when the game is started
     moves(state) -> [{from,to,promo?}]         legal moves for state.turn
     play(state, move) -> state                 returns a new state
     outcome(state) -> null | {winner, reason}  winner is a seat, or -1 for a draw
     piece(state, i) -> null | {seat, ...}      what sits on square i (row 0 is the top for seat 0)
     tally(state, seat) -> string               short score line for the player bar
     alert(state) -> square | -1                square to flag (a king in check)
     ai(state, level) -> move                   level 0 easy, 1 medium, 2 hard
*/
var GAMES = (function () {
  'use strict';
  var TIMEOUT = { timeout: true };
  var INF = 1e9;

  /* ---------------------------------------------------------------- Checkers */
  var ALL4 = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var UP = [[-1, -1], [-1, 1]], DOWN = [[1, -1], [1, 1]];

  function ckOwn(ch, turn) { return turn === 0 ? (ch === 'r' || ch === 'R') : (ch === 'b' || ch === 'B'); }

  function ckGen(s) {
    var b = s.board, jumps = [], steps = [];
    for (var i = 0; i < 64; i++) {
      if (s.cont >= 0 && i !== s.cont) continue;
      var ch = b[i];
      if (!ckOwn(ch, s.turn)) continue;
      var r = i >> 3, c = i & 7, dirs = ch === 'r' ? UP : ch === 'b' ? DOWN : ALL4;
      for (var k = 0; k < dirs.length; k++) {
        var r1 = r + dirs[k][0], c1 = c + dirs[k][1];
        if (r1 < 0 || r1 > 7 || c1 < 0 || c1 > 7) continue;
        var t = b[r1 * 8 + c1];
        if (t === '.') steps.push({ from: i, to: r1 * 8 + c1 });
        else if (!ckOwn(t, s.turn)) {
          var r2 = r1 + dirs[k][0], c2 = c1 + dirs[k][1];
          if (r2 >= 0 && r2 < 8 && c2 >= 0 && c2 < 8 && b[r2 * 8 + c2] === '.')
            jumps.push({ from: i, to: r2 * 8 + c2, cap: r1 * 8 + c1 });
        }
      }
    }
    return jumps.length ? jumps : (s.cont >= 0 ? [] : steps);
  }

  function ckPlay(s, m) {
    var a = s.board.split(''), ch = a[m.from], wasMan = ch === 'r' || ch === 'b', crowned = false;
    a[m.from] = '.';
    if (ch === 'r' && m.to < 8) { ch = 'R'; crowned = true; }
    if (ch === 'b' && m.to >= 56) { ch = 'B'; crowned = true; }
    a[m.to] = ch;
    var jumped = m.cap !== undefined;
    if (jumped) a[m.cap] = '.';
    var ns = { board: a.join(''), turn: s.turn, cont: -1, quiet: (jumped || wasMan) ? 0 : s.quiet + 1, last: { from: m.from, to: m.to } };
    if (jumped && !crowned) {
      ns.cont = m.to;
      if (ckGen(ns).length) return ns;
      ns.cont = -1;
    }
    ns.turn = 1 - s.turn;
    return ns;
  }

  function ckEval(s, seat) {
    var sc = 0, b = s.board;
    for (var i = 0; i < 64; i++) {
      var ch = b[i];
      if (ch === '.') continue;
      var r = i >> 3, c = i & 7, mid = (c >= 2 && c <= 5) ? 4 : 0;
      if (ch === 'r') sc += 100 + (7 - r) * 4 + mid + (r === 7 ? 8 : 0);
      else if (ch === 'R') sc += 180 + mid;
      else if (ch === 'b') sc -= 100 + r * 4 + mid + (r === 0 ? 8 : 0);
      else sc -= 180 + mid;
    }
    return seat === 0 ? sc : -sc;
  }

  function ckNega(s, d, alpha, beta, ctx) {
    if ((++ctx.nodes & 255) === 0 && Date.now() > ctx.end) throw TIMEOUT;
    var mv = ckGen(s);
    if (!mv.length) return -100000 - d;
    if (s.quiet >= 80) return 0;
    if (d <= 0 && mv[0].cap === undefined) return ckEval(s, s.turn);
    var best = -INF;
    for (var i = 0; i < mv.length; i++) {
      var ns = ckPlay(s, mv[i]);
      var v = ns.turn === s.turn ? ckNega(ns, d, alpha, beta, ctx) : -ckNega(ns, d - 1, -beta, -alpha, ctx);
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }

  var CK_LEVEL = [{ depth: 2, ms: 300, noise: 45 }, { depth: 5, ms: 600, noise: 0 }, { depth: 14, ms: 1500, noise: 0 }];

  function ckAI(s, level) {
    var cfg = CK_LEVEL[level] || CK_LEVEL[1], mv = ckGen(s);
    if (mv.length <= 1) return mv[0] || null;
    var ctx = { nodes: 0, end: Date.now() + cfg.ms }, pick = mv[0];
    try {
      for (var d = 1; d <= cfg.depth; d++) {
        var best = -INF, bm = mv[0], alpha = -INF;
        for (var i = 0; i < mv.length; i++) {
          var ns = ckPlay(s, mv[i]);
          var v = ns.turn === s.turn ? ckNega(ns, d, cfg.noise ? -INF : alpha, INF, ctx) : -ckNega(ns, d - 1, -INF, cfg.noise ? INF : -alpha, ctx);
          if (cfg.noise) v += Math.random() * cfg.noise;
          if (v > best) { best = v; bm = mv[i]; }
          if (v > alpha) alpha = v;
        }
        pick = bm;
        mv.splice(mv.indexOf(bm), 1); mv.unshift(bm);
      }
    } catch (e) { if (e !== TIMEOUT) throw e; }
    return { from: pick.from, to: pick.to };
  }

  var checkers = {
    id: 'checkers', cats: ['classic'], name: 'Checkers', min: 2, max: 2, seats: ['Red', 'Black'],
    blurb: 'Jump to capture, and you must jump when you can. Reach the far row to crown a king.',
    init: function () {
      var b = '';
      for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
        var dark = (r + c) % 2 === 1;
        b += dark && r < 3 ? 'b' : dark && r > 4 ? 'r' : '.';
      }
      return { board: b, turn: 0, cont: -1, quiet: 0, last: null };
    },
    moves: function (s) { return ckGen(s).map(function (m) { return { from: m.from, to: m.to }; }); },
    play: function (s, m) {
      var all = ckGen(s);
      for (var i = 0; i < all.length; i++) if (all[i].from === m.from && all[i].to === m.to) return ckPlay(s, all[i]);
      throw new Error('That move is not allowed');
    },
    outcome: function (s) {
      if (s.quiet >= 80) return { winner: -1, reason: '40 moves each without a capture' };
      if (ckGen(s).length) return null;
      var left = 0;
      for (var i = 0; i < 64; i++) if (ckOwn(s.board[i], s.turn)) left++;
      return { winner: 1 - s.turn, reason: left ? 'the other side has no moves left' : 'capturing every piece' };
    },
    piece: function (s, i) {
      var ch = s.board[i];
      if (ch === '.') return null;
      return { seat: (ch === 'r' || ch === 'R') ? 0 : 1, king: ch === 'R' || ch === 'B' };
    },
    tally: function (s, seat) {
      var n = 0;
      for (var i = 0; i < 64; i++) if (ckOwn(s.board[i], seat)) n++;
      return n + (n === 1 ? ' piece' : ' pieces');
    },
    alert: function () { return -1; },
    ai: ckAI
  };

  /* ------------------------------------------------------------------- Chess */
  var KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  var DIAG = ALL4, ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]], ROYAL = DIAG.concat(ORTH);
  var VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
  var CRMASK = [];
  for (var q = 0; q < 64; q++) CRMASK[q] = 15;
  CRMASK[60] = 12; CRMASK[63] = 14; CRMASK[56] = 13; CRMASK[4] = 3; CRMASK[7] = 11; CRMASK[0] = 7;

  function cSide(ch) { return ch === '.' ? -1 : (ch < 'a' ? 0 : 1); }
  function cPos(s) { return { b: s.board.split(''), turn: s.turn, cr: s.cr, ep: s.ep, half: s.half }; }

  function cAttacked(p, sq, by) {
    var b = p.b, r = sq >> 3, c = sq & 7, i, r1, c1, ch;
    var pr = by === 0 ? r + 1 : r - 1, pawn = by === 0 ? 'P' : 'p';
    if (pr >= 0 && pr < 8) {
      if (c > 0 && b[pr * 8 + c - 1] === pawn) return true;
      if (c < 7 && b[pr * 8 + c + 1] === pawn) return true;
    }
    var kn = by === 0 ? 'N' : 'n', kg = by === 0 ? 'K' : 'k';
    for (i = 0; i < 8; i++) {
      r1 = r + KN[i][0]; c1 = c + KN[i][1];
      if (r1 >= 0 && r1 < 8 && c1 >= 0 && c1 < 8 && b[r1 * 8 + c1] === kn) return true;
      r1 = r + ROYAL[i][0]; c1 = c + ROYAL[i][1];
      if (r1 >= 0 && r1 < 8 && c1 >= 0 && c1 < 8 && b[r1 * 8 + c1] === kg) return true;
    }
    var bq = by === 0 ? 'B' : 'b', rq = by === 0 ? 'R' : 'r', qq = by === 0 ? 'Q' : 'q';
    for (i = 0; i < 4; i++) {
      r1 = r + DIAG[i][0]; c1 = c + DIAG[i][1];
      while (r1 >= 0 && r1 < 8 && c1 >= 0 && c1 < 8) {
        ch = b[r1 * 8 + c1];
        if (ch !== '.') { if (ch === bq || ch === qq) return true; break; }
        r1 += DIAG[i][0]; c1 += DIAG[i][1];
      }
      r1 = r + ORTH[i][0]; c1 = c + ORTH[i][1];
      while (r1 >= 0 && r1 < 8 && c1 >= 0 && c1 < 8) {
        ch = b[r1 * 8 + c1];
        if (ch !== '.') { if (ch === rq || ch === qq) return true; break; }
        r1 += ORTH[i][0]; c1 += ORTH[i][1];
      }
    }
    return false;
  }

  function cKing(p, side) {
    var k = side === 0 ? 'K' : 'k';
    for (var i = 0; i < 64; i++) if (p.b[i] === k) return i;
    return -1;
  }

  function cPawnPush(out, from, to, promo, capsOnly) {
    if (!promo) { out.push({ from: from, to: to, promo: '', fl: 0 }); return; }
    out.push({ from: from, to: to, promo: 'Q', fl: 0 });
    if (capsOnly) return;
    out.push({ from: from, to: to, promo: 'N', fl: 0 });
    out.push({ from: from, to: to, promo: 'R', fl: 0 });
    out.push({ from: from, to: to, promo: 'B', fl: 0 });
  }

  /* Pseudo-legal moves: may leave the mover's own king in check. */
  function cGen(p, capsOnly) {
    var out = [], b = p.b, us = p.turn, them = 1 - us;
    for (var s = 0; s < 64; s++) {
      var ch = b[s];
      if (ch === '.' || cSide(ch) !== us) continue;
      var r = s >> 3, c = s & 7, t = us === 0 ? ch : ch.toUpperCase(), i, r1, c1, to, tg;
      if (t === 'P') {
        var d = us === 0 ? -1 : 1, start = us === 0 ? 6 : 1, last = us === 0 ? 0 : 7;
        r1 = r + d;
        if (r1 < 0 || r1 > 7) continue;
        for (i = -1; i <= 1; i += 2) {
          c1 = c + i;
          if (c1 < 0 || c1 > 7) continue;
          to = r1 * 8 + c1; tg = b[to];
          if (tg !== '.') { if (cSide(tg) === them) cPawnPush(out, s, to, r1 === last, capsOnly); }
          else if (to === p.ep) out.push({ from: s, to: to, promo: '', fl: 1 });
        }
        to = r1 * 8 + c;
        if (b[to] === '.') {
          if (!capsOnly) {
            cPawnPush(out, s, to, r1 === last, false);
            if (r === start && b[to + d * 8] === '.') out.push({ from: s, to: to + d * 8, promo: '', fl: 4 });
          } else if (r1 === last) cPawnPush(out, s, to, true, true);
        }
      } else if (t === 'N' || t === 'K') {
        var offs = t === 'N' ? KN : ROYAL;
        for (i = 0; i < 8; i++) {
          r1 = r + offs[i][0]; c1 = c + offs[i][1];
          if (r1 < 0 || r1 > 7 || c1 < 0 || c1 > 7) continue;
          to = r1 * 8 + c1; tg = b[to];
          if (tg === '.') { if (!capsOnly) out.push({ from: s, to: to, promo: '', fl: 0 }); }
          else if (cSide(tg) === them) out.push({ from: s, to: to, promo: '', fl: 0 });
        }
        if (t === 'K' && !capsOnly) {
          var home = us === 0 ? 60 : 4, rook = us === 0 ? 'R' : 'r';
          var kBit = us === 0 ? 1 : 4, qBit = us === 0 ? 2 : 8;
          if (s === home && (p.cr & (kBit | qBit)) && !cAttacked(p, home, them)) {
            if ((p.cr & kBit) && b[home + 1] === '.' && b[home + 2] === '.' && b[home + 3] === rook &&
              !cAttacked(p, home + 1, them) && !cAttacked(p, home + 2, them))
              out.push({ from: s, to: home + 2, promo: '', fl: 2 });
            if ((p.cr & qBit) && b[home - 1] === '.' && b[home - 2] === '.' && b[home - 3] === '.' && b[home - 4] === rook &&
              !cAttacked(p, home - 1, them) && !cAttacked(p, home - 2, them))
              out.push({ from: s, to: home - 2, promo: '', fl: 3 });
          }
        }
      } else {
        var dirs = t === 'B' ? DIAG : t === 'R' ? ORTH : ROYAL;
        for (i = 0; i < dirs.length; i++) {
          r1 = r + dirs[i][0]; c1 = c + dirs[i][1];
          while (r1 >= 0 && r1 < 8 && c1 >= 0 && c1 < 8) {
            to = r1 * 8 + c1; tg = b[to];
            if (tg === '.') { if (!capsOnly) out.push({ from: s, to: to, promo: '', fl: 0 }); }
            else { if (cSide(tg) === them) out.push({ from: s, to: to, promo: '', fl: 0 }); break; }
            r1 += dirs[i][0]; c1 += dirs[i][1];
          }
        }
      }
    }
    return out;
  }

  function cMake(p, m) {
    var b = p.b, pc = b[m.from], cap = b[m.to], white = p.turn === 0;
    var u = { cap: cap, cr: p.cr, ep: p.ep, half: p.half, pc: pc, epc: '' };
    b[m.from] = '.';
    b[m.to] = m.promo ? (white ? m.promo : m.promo.toLowerCase()) : pc;
    if (m.fl === 1) { var cs = (m.from & 56) | (m.to & 7); u.epc = b[cs]; b[cs] = '.'; }
    else if (m.fl === 2) { b[m.to + 1] = '.'; b[m.to - 1] = white ? 'R' : 'r'; }
    else if (m.fl === 3) { b[m.to - 2] = '.'; b[m.to + 1] = white ? 'R' : 'r'; }
    p.ep = m.fl === 4 ? (m.from + m.to) >> 1 : -1;
    p.cr &= CRMASK[m.from] & CRMASK[m.to];
    p.half = (cap !== '.' || pc === 'P' || pc === 'p') ? 0 : p.half + 1;
    p.turn ^= 1;
    return u;
  }

  function cUnmake(p, m, u) {
    var b = p.b;
    p.turn ^= 1;
    var white = p.turn === 0;
    b[m.from] = u.pc; b[m.to] = u.cap;
    if (m.fl === 1) b[(m.from & 56) | (m.to & 7)] = u.epc;
    else if (m.fl === 2) { b[m.to + 1] = white ? 'R' : 'r'; b[m.to - 1] = '.'; }
    else if (m.fl === 3) { b[m.to - 2] = white ? 'R' : 'r'; b[m.to + 1] = '.'; }
    p.cr = u.cr; p.ep = u.ep; p.half = u.half;
  }

  function cLegal(p) {
    var ps = cGen(p, false), out = [], us = p.turn;
    for (var i = 0; i < ps.length; i++) {
      var u = cMake(p, ps[i]);
      if (!cAttacked(p, cKing(p, us), 1 - us)) out.push(ps[i]);
      cUnmake(p, ps[i], u);
    }
    return out;
  }

  function cInCheck(p) { return cAttacked(p, cKing(p, p.turn), 1 - p.turn); }

  function cEval(p) {
    var b = p.b, sc = 0, heavy = [0, 0], i, ch;
    for (i = 0; i < 64; i++) {
      ch = b[i];
      if (ch === '.' || ch === 'P' || ch === 'p' || ch === 'K' || ch === 'k') continue;
      heavy[ch < 'a' ? 0 : 1] += VAL[ch.toUpperCase()];
    }
    for (i = 0; i < 64; i++) {
      ch = b[i];
      if (ch === '.') continue;
      var white = ch < 'a', t = white ? ch : ch.toUpperCase(), r = i >> 3, c = i & 7;
      var adv = white ? 7 - r : r, cd = Math.max(Math.abs(c - 3.5), Math.abs(r - 3.5)), v = VAL[t];
      if (t === 'P') v += (adv - 1) * 6 + ((c === 3 || c === 4) && adv >= 3 ? 16 : 0) + (adv >= 5 ? (adv - 4) * 25 : 0);
      else if (t === 'N') v += 22 - cd * 11;
      else if (t === 'B') v += 12 - cd * 5;
      else if (t === 'R') v += adv === 6 ? 15 : 0;
      else if (t === 'K') {
        if (heavy[white ? 1 : 0] <= 1300) v += 20 - cd * 10;
        else v += (adv === 0 ? 12 : -18 * adv) + (c <= 2 || c >= 6 ? 14 : 0);
      }
      sc += white ? v : -v;
    }
    return p.turn === 0 ? sc : -sc;
  }

  function cOrder(p, mv) {
    for (var i = 0; i < mv.length; i++) {
      var m = mv[i], cap = p.b[m.to], sc = 0;
      if (cap !== '.') sc = 10 * VAL[cap.toUpperCase()] - VAL[p.b[m.from].toUpperCase()] / 10 + 1000;
      else if (m.fl === 1) sc = 1900;
      if (m.promo) sc += VAL[m.promo];
      m.sc = sc;
    }
    mv.sort(function (a, b) { return b.sc - a.sc; });
  }

  function cQuiesce(p, alpha, beta, ctx, qd) {
    if ((++ctx.nodes & 1023) === 0 && Date.now() > ctx.end) throw TIMEOUT;
    var stand = cEval(p);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (qd <= 0) return stand;
    var mv = cGen(p, true), us = p.turn;
    cOrder(p, mv);
    for (var i = 0; i < mv.length; i++) {
      var u = cMake(p, mv[i]);
      if (cAttacked(p, cKing(p, us), 1 - us)) { cUnmake(p, mv[i], u); continue; }
      var v = -cQuiesce(p, -beta, -alpha, ctx, qd - 1);
      cUnmake(p, mv[i], u);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }

  function cSearch(p, d, alpha, beta, ply, ctx) {
    if (p.half >= 100) return 0;
    if (d <= 0) return cQuiesce(p, alpha, beta, ctx, 6);
    if ((++ctx.nodes & 1023) === 0 && Date.now() > ctx.end) throw TIMEOUT;
    var mv = cGen(p, false), us = p.turn, any = false, best = -INF;
    cOrder(p, mv);
    for (var i = 0; i < mv.length; i++) {
      var u = cMake(p, mv[i]);
      if (cAttacked(p, cKing(p, us), 1 - us)) { cUnmake(p, mv[i], u); continue; }
      any = true;
      var v = -cSearch(p, d - 1, -beta, -alpha, ply + 1, ctx);
      cUnmake(p, mv[i], u);
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    if (!any) return cInCheck(p) ? -900000 + ply : 0;
    return best;
  }

  var C_LEVEL = [{ depth: 1, ms: 400, noise: 140 }, { depth: 3, ms: 900, noise: 0 }, { depth: 6, ms: 2500, noise: 0 }];

  function cAI(s, level) {
    var cfg = C_LEVEL[level] || C_LEVEL[1], p = cPos(s), mv = cLegal(p);
    if (!mv.length) return null;
    cOrder(p, mv);
    var pick = mv[0];
    if (mv.length > 1) {
      var ctx = { nodes: 0, end: Date.now() + cfg.ms };
      try {
        for (var d = 1; d <= cfg.depth; d++) {
          var best = -INF, bm = mv[0], alpha = -INF;
          for (var i = 0; i < mv.length; i++) {
            var u = cMake(p, mv[i]);
            var v = -cSearch(p, d - 1, -INF, cfg.noise ? INF : -alpha, 1, ctx);
            cUnmake(p, mv[i], u);
            if (cfg.noise && v > -800000) v += Math.random() * cfg.noise;
            if (v > best) { best = v; bm = mv[i]; }
            if (v > alpha) alpha = v;
          }
          pick = bm;
          mv.splice(mv.indexOf(bm), 1); mv.unshift(bm);
          if (best > 800000) break;
        }
      } catch (e) { if (e !== TIMEOUT) throw e; }
    }
    return { from: pick.from, to: pick.to, promo: pick.promo };
  }

  function cKey(s) { return s.board + s.turn + s.cr + ':' + s.ep; }

  var START = 'rnbqkbnr' + 'pppppppp' + '................................' + 'PPPPPPPP' + 'RNBQKBNR';
  var FULL = { P: 8, N: 2, B: 2, R: 2, Q: 1 };
  var GLYPH = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };

  var chess = {
    id: 'chess', cats: ['classic'], name: 'Chess', min: 2, max: 2, seats: ['White', 'Black'],
    blurb: 'The full game, with castling, en passant and promotion. Checkmate the king to win.',
    init: function () {
      var s = { board: START, turn: 0, cr: 15, ep: -1, half: 0, hist: [], last: null };
      s.hist.push(cKey(s));
      return s;
    },
    moves: function (s) {
      return cLegal(cPos(s)).map(function (m) { return { from: m.from, to: m.to, promo: m.promo }; });
    },
    play: function (s, m) {
      var p = cPos(s), all = cLegal(p), want = m.promo || '', hit = null;
      for (var i = 0; i < all.length; i++) {
        var a = all[i];
        if (a.from === m.from && a.to === m.to && (a.promo === want || (a.promo === 'Q' && !want))) { hit = a; break; }
      }
      if (!hit) throw new Error('That move is not allowed');
      cMake(p, hit);
      var ns = { board: p.b.join(''), turn: p.turn, cr: p.cr, ep: p.ep, half: p.half, hist: p.half === 0 ? [] : s.hist.slice(), last: { from: m.from, to: m.to } };
      ns.hist.push(cKey(ns));
      return ns;
    },
    outcome: function (s) {
      var p = cPos(s);
      if (!cLegal(p).length) return cInCheck(p) ? { winner: 1 - s.turn, reason: 'checkmate' } : { winner: -1, reason: 'stalemate' };
      if (s.half >= 100) return { winner: -1, reason: '50 moves without a capture or pawn move' };
      var key = cKey(s), seen = 0;
      for (var i = 0; i < s.hist.length; i++) if (s.hist[i] === key) seen++;
      if (seen >= 3) return { winner: -1, reason: 'the same position three times' };
      var minor = 0;
      for (i = 0; i < 64; i++) {
        var ch = s.board[i].toUpperCase();
        if (ch === 'P' || ch === 'R' || ch === 'Q') return null;
        if (ch === 'N' || ch === 'B') minor++;
      }
      return minor <= 1 ? { winner: -1, reason: 'not enough pieces left to checkmate' } : null;
    },
    piece: function (s, i) {
      var ch = s.board[i];
      if (ch === '.') return null;
      var k = ch.toUpperCase();
      return { seat: ch < 'a' ? 0 : 1, kind: k, glyph: GLYPH[k] + '︎' };
    },
    tally: function (s, seat) {
      var have = { P: 0, N: 0, B: 0, R: 0, Q: 0 }, out = '';
      for (var i = 0; i < 64; i++) {
        var ch = s.board[i];
        if (ch !== '.' && cSide(ch) !== seat && have[ch.toUpperCase()] !== undefined) have[ch.toUpperCase()]++;
      }
      ['Q', 'R', 'B', 'N', 'P'].forEach(function (k) {
        for (var n = FULL[k] - have[k]; n > 0; n--) out += GLYPH[k] + '︎';
      });
      return out;
    },
    alert: function (s) {
      var p = cPos(s);
      return cInCheck(p) ? cKing(p, p.turn) : -1;
    },
    ai: cAI
  };

  /* ---------------------------------------------------------------- Tileyard */
  /* A tile-drafting game for 2 to 4. Take every tile of one color from a tray or from the middle,
     line them up in a prep row, and at the end of each round every full row sets one tile into your yard. */
  var TY_PEN = [0, 1, 2, 4, 6, 8, 11, 14];          // total penalty for 0..7 broken tiles
  var TY_TRAYS = { 2: 5, 3: 7, 4: 9 };

  function tySum(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return t; }
  function tyCol(color, row) { return (color + row) % 5; }
  function tyBit(mask, c) { return (mask >> c) & 1; }

  function tyDraw(s) {
    var total = tySum(s.bag);
    if (!total) { s.bag = s.lid; s.lid = [0, 0, 0, 0, 0]; total = tySum(s.bag); }
    if (!total) return -1;
    var r = Math.floor(Math.random() * total);
    for (var c = 0; c < 5; c++) { if (r < s.bag[c]) { s.bag[c]--; return c; } r -= s.bag[c]; }
    return -1;
  }
  function tyFill(s) {
    for (var t = 0; t < s.trays.length; t++) {
      s.trays[t] = [0, 0, 0, 0, 0];
      for (var k = 0; k < 4; k++) { var c = tyDraw(s); if (c >= 0) s.trays[t][c]++; }
    }
    s.mk = 1;
  }
  function tyPlaceScore(wall, row, col) {
    var h = 1, v = 1, i;
    for (i = col - 1; i >= 0 && tyBit(wall[row], i); i--) h++;
    for (i = col + 1; i < 5 && tyBit(wall[row], i); i++) h++;
    for (i = row - 1; i >= 0 && tyBit(wall[i], col); i--) v++;
    for (i = row + 1; i < 5 && tyBit(wall[i], col); i++) v++;
    return (h > 1 ? h : 0) + (v > 1 ? v : 0) || 1;
  }
  function tyMoves(s) {
    if (s.over) return [];
    var P = s.pl[s.turn], out = [];
    for (var src = -1; src < s.trays.length; src++) {
      var pool = src < 0 ? s.pile : s.trays[src];
      for (var c = 0; c < 5; c++) {
        if (!pool[c]) continue;
        for (var r = 0; r < 5; r++)
          if ((P.rc[r] === -1 || P.rc[r] === c) && P.rn[r] < r + 1 && !tyBit(P.wall[r], tyCol(c, r)))
            out.push({ src: src, color: c, row: r });
        out.push({ src: src, color: c, row: 5 });
      }
    }
    return out;
  }
  function tyMarketEmpty(s) {
    if (tySum(s.pile)) return false;
    for (var t = 0; t < s.trays.length; t++) if (tySum(s.trays[t])) return false;
    return true;
  }
  /* Take and place, without the end-of-round bookkeeping. Returns true when the market is now empty. */
  function tyTake(s, m) {
    var P = s.pl[s.turn], k, c;
    if (m.src >= 0) {
      var tray = s.trays[m.src];
      k = tray[m.color];
      for (c = 0; c < 5; c++) if (c !== m.color) s.pile[c] += tray[c];
      s.trays[m.src] = [0, 0, 0, 0, 0];
    } else {
      k = s.pile[m.color]; s.pile[m.color] = 0;
      if (s.mk) { s.mk = 0; P.fm = 1; s.start = s.turn; }
    }
    var put = 0;
    if (m.row < 5) { put = Math.min(k, m.row + 1 - P.rn[m.row]); P.rc[m.row] = m.color; P.rn[m.row] += put; }
    P.fl[m.color] += k - put;
    s.last = { seat: s.turn, src: m.src, color: m.color, row: m.row, k: k };
    return tyMarketEmpty(s);
  }
  function tyEndRound(s) {
    var gain = [], ended = false, i, r, c;
    for (i = 0; i < s.pl.length; i++) {
      var P = s.pl[i], got = 0;
      for (r = 0; r < 5; r++) {
        if (P.rn[r] !== r + 1) continue;
        var col = tyCol(P.rc[r], r);
        got += tyPlaceScore(P.wall, r, col);
        P.wall[r] |= 1 << col;
        s.lid[P.rc[r]] += r;
        P.rc[r] = -1; P.rn[r] = 0;
      }
      var pen = TY_PEN[Math.min(7, tySum(P.fl) + P.fm)];
      for (c = 0; c < 5; c++) { s.lid[c] += P.fl[c]; P.fl[c] = 0; }
      P.fm = 0;
      var next = Math.max(0, P.score + got - pen);
      gain.push(next - P.score);
      P.score = next;
      for (r = 0; r < 5; r++) if (P.wall[r] === 31) ended = true;
    }
    s.gain = gain;
    if (ended) {
      for (i = 0; i < s.pl.length; i++) {
        var W = s.pl[i].wall, b = 0;
        for (r = 0; r < 5; r++) if (W[r] === 31) b += 2;
        for (c = 0; c < 5; c++) {
          var full = true, all = true;
          for (r = 0; r < 5; r++) { if (!tyBit(W[r], c)) full = false; if (!tyBit(W[r], tyCol(c, r))) all = false; }
          if (full) b += 7;
          if (all) b += 10;
        }
        s.pl[i].bonus = b; s.pl[i].score += b;
      }
      s.over = 1;
    } else {
      s.round++; s.turn = s.start;
      tyFill(s);
    }
  }
  function tyRows(P) { var n = 0; for (var r = 0; r < 5; r++) if (P.wall[r] === 31) n++; return n; }

  /* How good a move looks for the player making it, in points. */
  function tyValue(s, m) {
    var P = s.pl[s.turn], pool = m.src < 0 ? s.pile : s.trays[m.src], k = pool[m.color];
    var marker = (m.src < 0 && s.mk) ? 1 : 0, before = tySum(P.fl) + P.fm;
    var put = m.row < 5 ? Math.min(k, m.row + 1 - P.rn[m.row]) : 0, over = k - put;
    var v = -(TY_PEN[Math.min(7, before + over + marker)] - TY_PEN[Math.min(7, before)]);
    if (!put) return v - 0.2;
    var cap = m.row + 1, n2 = P.rn[m.row] + put, col = tyCol(m.color, m.row), r, c;
    var inCol = 0, inRow = 0, ofColor = 0;
    for (r = 0; r < 5; r++) { inCol += tyBit(P.wall[r], col); ofColor += tyBit(P.wall[r], tyCol(m.color, r)); }
    for (c = 0; c < 5; c++) inRow += tyBit(P.wall[m.row], c);
    var worth = tyPlaceScore(P.wall, m.row, col) + inCol * 0.45 + ofColor * 0.4 + inRow * 0.25;
    if (n2 === cap) return v + worth + 0.6;
    var left = -k, t;
    for (t = 0; t < s.trays.length; t++) left += s.trays[t][m.color];
    left += s.pile[m.color];
    return v + worth * (n2 / cap) * (left >= cap - n2 ? 0.6 : 0.2) - 0.1 * (cap - n2);
  }

  function tyAI(s, level) {
    var mv = tyMoves(s);
    if (!mv.length) return null;
    var best = -INF, pick = mv[0];
    for (var i = 0; i < mv.length; i++) {
      var v = tyValue(s, mv[i]);
      if (level === 0) v += Math.random() * 5;
      else v += Math.random() * 0.05;
      if (level === 2) {                     // also weigh what this leaves for the next player
        var ns = JSON.parse(JSON.stringify(s));
        if (!tyTake(ns, mv[i])) {
          ns.turn = (ns.turn + 1) % ns.pl.length;
          var reply = tyMoves(ns), rb = -INF;
          for (var j = 0; j < reply.length; j++) { var rv = tyValue(ns, reply[j]); if (rv > rb) rb = rv; }
          v -= rb * (s.pl.length === 2 ? 0.5 : 0.08);
        }
      }
      if (v > best) { best = v; pick = mv[i]; }
    }
    return { src: pick.src, color: pick.color, row: pick.row };
  }

  var tileyard = {
    id: 'tileyard', cats: ['modern'], name: 'Tileyard', like: 'Azul', min: 2, max: 4, seats: [], ui: 'draft', aiDelay: 1100,
    blurb: 'Draft colored tiles from the trays, line them up, and set them into your yard. Rows, columns and full colors score.',
    colors: ['Teal', 'Amber', 'Red', 'Plum', 'Cream'],
    penalties: [1, 1, 2, 2, 2, 3, 3],
    help: [
      'On your turn, take every tile of one color from one tray. The rest of that tray slides to the middle. Or take every tile of one color from the middle.',
      'The first player to take from the middle each round also takes the first-turn marker. It costs a point, and that player starts the next round.',
      'Put the tiles you took into one prep row. A row holds one color only, and not a color that row of your yard already has. Tiles that do not fit break.',
      'The round ends when the trays and the middle are empty. Each full prep row sets one tile into your yard, then empties. Unfinished rows stay for next round.',
      'A tile set on its own scores 1. If it touches others, it scores the length of its line across plus the length of its line down.',
      'Broken tiles cost 1, 1, 2, 2, 2, 3, 3 points. Your score never drops below zero.',
      'The game ends after the round in which someone finishes a row across their yard. Bonuses: 2 per full row, 7 per full column, 10 for all five tiles of one color.'
    ],
    init: function (n) {
      n = Math.max(2, Math.min(4, n || 2));
      var s = { turn: 0, round: 1, start: 0, mk: 1, over: 0, trays: [], pile: [0, 0, 0, 0, 0], bag: [20, 20, 20, 20, 20], lid: [0, 0, 0, 0, 0], pl: [] };
      for (var t = 0; t < TY_TRAYS[n]; t++) s.trays.push([0, 0, 0, 0, 0]);
      for (var i = 0; i < n; i++) s.pl.push({ rc: [-1, -1, -1, -1, -1], rn: [0, 0, 0, 0, 0], wall: [0, 0, 0, 0, 0], fl: [0, 0, 0, 0, 0], fm: 0, score: 0, bonus: 0 });
      tyFill(s);
      return s;
    },
    moves: tyMoves,
    play: function (s, m) {
      var ok = tyMoves(s).some(function (x) { return x.src === m.src && x.color === m.color && x.row === m.row; });
      if (!ok) throw new Error('That move is not allowed');
      var ns = JSON.parse(JSON.stringify(s));
      delete ns.gain;
      if (tyTake(ns, m)) tyEndRound(ns); else ns.turn = (ns.turn + 1) % ns.pl.length;
      return ns;
    },
    outcome: function (s) {
      if (!s.over) return null;
      var best = -1, who = [], i;
      for (i = 0; i < s.pl.length; i++) {
        var key = s.pl[i].score * 10 + tyRows(s.pl[i]);
        if (key > best) { best = key; who = [i]; } else if (key === best) who.push(i);
      }
      if (who.length > 1) return { winner: -1, reason: 'tied on points and on finished rows' };
      return { winner: who[0], reason: 'scoring ' + s.pl[who[0]].score + ' points' };
    },
    yardColor: function (row, col) { return (col - row + 5) % 5; },
    piece: function () { return null; },
    tally: function (s, seat) { return s.pl[seat].score + ' pts'; },
    alert: function () { return -1; },
    ai: tyAI
  };

  /* ---------------------------------------------------------------- Cribbage */
  /* Cards are two characters, rank then suit ("5H", "TS"). Card lists are stored as one string with a
     leading "-" so that an empty list is still a value the database keeps. */
  var CB_RANKS = 'A23456789TJQK', CB_SUITS = 'SHDC', CB_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
  function cbList(str) { var out = []; for (var i = 1; i + 1 < str.length; i += 2) out.push(str.substr(i, 2)); return out; }
  function cbStr(arr) { return '-' + arr.join(''); }
  function cbRank(c) { return CB_RANKS.indexOf(c[0]) + 1; }
  function cbVal(c) { return Math.min(10, cbRank(c)); }
  function cbName(c) { return (c[0] === 'T' ? '10' : c[0]) + CB_GLYPH[c[1]] + '\uFE0E'; }
  function cbSide(s, seat) { return s.n === 4 ? seat % 2 : seat; }
  function cbSort(arr) { return arr.slice().sort(function (a, b) { return cbRank(a) - cbRank(b) || CB_SUITS.indexOf(a[1]) - CB_SUITS.indexOf(b[1]); }); }

  /* Points for a four-card hand with the starter. */
  function cbShow(hand, starter, isCrib) {
    var all = hand.concat([starter]), fif = 0, pairs = 0, run = 0, i, j, m;
    for (m = 1; m < 32; m++) { var sum = 0; for (i = 0; i < 5; i++) if (m & (1 << i)) sum += cbVal(all[i]); if (sum === 15) fif += 2; }
    for (i = 0; i < 5; i++) for (j = i + 1; j < 5; j++) if (all[i][0] === all[j][0]) pairs += 2;
    for (var size = 5; size >= 3 && !run; size--) {
      for (m = 1; m < 32; m++) {
        var rs = [];
        for (i = 0; i < 5; i++) if (m & (1 << i)) rs.push(cbRank(all[i]));
        if (rs.length !== size) continue;
        rs.sort(function (a, b) { return a - b; });
        var ok = true;
        for (i = 1; i < size; i++) if (rs[i] !== rs[i - 1] + 1) ok = false;
        if (ok) run += size;
      }
    }
    var flush = 0, same = hand.every(function (c) { return c[1] === hand[0][1]; });
    if (same && starter[1] === hand[0][1]) flush = 5; else if (same && !isCrib) flush = 4;
    var nobs = hand.some(function (c) { return c[0] === 'J' && c[1] === starter[1]; }) ? 1 : 0;
    var why = [];
    if (fif) why.push('fifteens ' + fif);
    if (pairs) why.push('pairs ' + pairs);
    if (run) why.push('runs ' + run);
    if (flush) why.push('flush ' + flush);
    if (nobs) why.push('jack of the starter suit 1');
    return { pts: fif + pairs + run + flush + nobs, why: why.length ? why.join(', ') : 'nothing' };
  }

  var CB_KIND = { f: 'Fifteen', p: 'Pair', r: 'Run', l: 'Flush', n: 'Jack of the starter suit' };
  function cbKey(kind, cards) { return kind + ':' + cbSort(cards).join(''); }
  function cbKeyCards(key) { return cbList('-' + key.slice(2)); }
  function cbKeyLabel(key) {
    var cards = cbKeyCards(key), kind = key[0];
    return (kind === 'r' ? 'Run of ' + cards.length : CB_KIND[kind]) + ' ' + cards.map(cbName).join(' ');
  }
  function cbIsRun(cards) {
    var rs = cards.map(cbRank).sort(function (a, b) { return a - b; });
    for (var i = 1; i < rs.length; i++) if (rs[i] !== rs[i - 1] + 1) return false;
    return rs.length >= 3;
  }
  function cbCombos(hand, starter, isCrib) {
    var all = hand.concat([starter]), out = [], m, i, j, size;
    var pick = function (mask) { var c = []; for (var k = 0; k < 5; k++) if (mask & (1 << k)) c.push(all[k]); return c; };
    for (m = 1; m < 32; m++) {
      var cs = pick(m);
      if (cs.length >= 2 && cs.reduce(function (t, c) { return t + cbVal(c); }, 0) === 15) out.push({ k: cbKey('f', cs), pts: 2 });
    }
    for (i = 0; i < 5; i++) for (j = i + 1; j < 5; j++) if (all[i][0] === all[j][0]) out.push({ k: cbKey('p', [all[i], all[j]]), pts: 2 });
    for (size = 5; size >= 3; size--) {
      var found = false;
      for (m = 1; m < 32; m++) { var rc = pick(m); if (rc.length === size && cbIsRun(rc)) { out.push({ k: cbKey('r', rc), pts: size }); found = true; } }
      if (found) break;
    }
    var same = hand.every(function (c) { return c[1] === hand[0][1]; });
    if (same && starter[1] === hand[0][1]) out.push({ k: cbKey('l', all), pts: 5 });
    else if (same && !isCrib) out.push({ k: cbKey('l', hand), pts: 4 });
    hand.forEach(function (c) { if (c[0] === 'J' && c[1] === starter[1]) out.push({ k: cbKey('n', [c, starter]), pts: 1 }); });
    return out;
  }
  function cbWhy(combos) {
    var t = { f: 0, p: 0, r: 0, l: 0, n: 0 }, why = [];
    combos.forEach(function (c) { t[c.k[0]] += c.pts; });
    if (t.f) why.push('fifteens ' + t.f);
    if (t.p) why.push('pairs ' + t.p);
    if (t.r) why.push('runs ' + t.r);
    if (t.l) why.push('flush ' + t.l);
    if (t.n) why.push('jack of the starter suit 1');
    return why.length ? why.join(', ') : 'nothing';
  }
  /* Whose hand is being counted right now, when players count their own. */
  function cbCounting(s) {
    var crib = s.ci >= s.n, seat = crib ? s.dealer : (s.dealer + 1 + s.ci) % s.n;
    return { seat: seat, crib: crib, hand: cbList(crib ? s.crib : s.kept[seat]), starter: cbList(s.starter)[0] };
  }
  /* What the selected cards make. Returns claims the player may take and a friendly note. */
  function cbJudge(s, sel) {
    var cur = cbCounting(s), combos = cbCombos(cur.hand, cur.starter, cur.crib), has = {}, claims = [], note = '';
    combos.forEach(function (c) { has[c.k] = c.pts; });
    var sum = sel.reduce(function (t, c) { return t + cbVal(c); }, 0), n = sel.length, i, j;
    if (n >= 2 && sum === 15) claims.push({ label: 'Fifteen', pts: 2, keys: [cbKey('f', sel)] });
    if (n >= 2 && sel.every(function (c) { return c[0] === sel[0][0]; })) {
      var keys = [];
      for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) keys.push(cbKey('p', [sel[i], sel[j]]));
      claims.push({ label: ['', '', 'Pair', 'Three of a kind', 'Four of a kind'][n], pts: keys.length * 2, keys: keys });
    }
    if (cbIsRun(sel)) {
      if (has[cbKey('r', sel)]) claims.push({ label: 'Run of ' + n, pts: n, keys: [cbKey('r', sel)] });
      else note = 'That is a run, and it can be longer. Add another card.';
    }
    var inHand = sel.filter(function (c) { return c !== cur.starter; });
    if (n >= 4 && sel.every(function (c) { return c[1] === sel[0][1]; })) {
      if (has[cbKey('l', sel)]) claims.push({ label: 'Flush', pts: has[cbKey('l', sel)], keys: [cbKey('l', sel)] });
      else if (n === 4 && inHand.length === 4 && cur.starter[1] === sel[0][1]) note = 'The starter is the same suit. Add it for a bigger flush.';
      else if (n === 4 && inHand.length === 4 && cur.crib) note = 'In the crib a flush needs all five cards.';
      else if (n === 4) note = 'A flush of four must be the four cards from the hand, not the starter.';
    }
    if (n === 2 && has[cbKey('n', sel)]) claims.push({ label: 'Jack of the starter suit', pts: 1, keys: [cbKey('n', sel)] });
    if (!claims.length && !note && n >= 2) note = n >= 3 && sel.every(function (c, k) { return k === 0 || c[0] !== sel[0][0]; }) && sum !== 15 ? 'Those add up to ' + sum + '. No points there.' : 'Those add up to ' + sum + '.';
    return { sum: sum, claims: claims, note: note };
  }
  function cbTally(s, keys) {
    var cur = cbCounting(s), combos = cbCombos(cur.hand, cur.starter, cur.crib), pts = 0, max = 0;
    combos.forEach(function (c) { max += c.pts; if (keys.indexOf(c.k) >= 0) pts += c.pts; });
    return { pts: pts, max: max };
  }

  /* Points for the card just added to the running stack during the play. */
  function cbPeg(stack, count) {
    var pts = 0, why = [], n = stack.length, k = 1, len, i;
    if (count === 15) { pts += 2; why.push('fifteen'); }
    if (count === 31) { pts += 2; why.push('thirty-one'); }
    while (k < n && stack[n - 1 - k][0] === stack[n - 1][0]) k++;
    if (k > 1) { pts += [0, 0, 2, 6, 12][k]; why.push(['', '', 'a pair', 'three of a kind', 'four of a kind'][k]); }
    for (len = n; len >= 3; len--) {
      var rs = [];
      for (i = n - len; i < n; i++) rs.push(cbRank(stack[i]));
      rs.sort(function (a, b) { return a - b; });
      var ok = true;
      for (i = 1; i < len; i++) if (rs[i] !== rs[i - 1] + 1) ok = false;
      if (ok) { pts += len; why.push('a run of ' + len); break; }
    }
    return { pts: pts, why: why.join(' and ') };
  }

  function cbLog(s, text) { s.log.push(text); while (s.log.length > 5) s.log.shift(); }
  function cbAdd(s, seat, pts, text) {
    if (!pts || s.over) return;
    var side = cbSide(s, seat);
    s.score[side] = Math.min(121, s.score[side] + pts);
    cbLog(s, text + ' +' + pts);
    if (s.score[side] >= 121) { s.over = 1; s.won = side; }
  }
  function cbDeal(s) {
    var deck = [], i, j, t;
    for (i = 0; i < 13; i++) for (j = 0; j < 4; j++) deck.push(CB_RANKS[i] + CB_SUITS[j]);
    for (i = 51; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    var per = s.n === 2 ? 6 : 5;
    s.hands = []; s.kept = []; s.tbl = [];
    for (i = 0; i < s.n; i++) { s.hands.push(cbStr(cbSort(deck.splice(0, per)))); s.kept.push('-'); s.tbl.push('-'); }
    s.crib = cbStr(s.n === 3 ? deck.splice(0, 1) : []);
    s.deck = cbStr(deck);
    s.starter = '-'; s.stack = '-'; s.count = 0; s.lastp = -1;
    s.phase = 'discard'; s.turn = (s.dealer + 1) % s.n;
    delete s.show;
    cbLog(s, '@' + s.dealer + ' deals hand ' + s.hand + ' and owns the crib.');
  }
  function cbCanPlay(s, seat) { return cbList(s.hands[seat]).some(function (c) { return s.count + cbVal(c) <= 31; }); }
  function cbCardsLeft(s) { for (var i = 0; i < s.n; i++) if (s.hands[i].length > 1) return true; return false; }

  function cbCountHands(s) {
    var starter = cbList(s.starter)[0], show = [], i;
    for (i = 1; i <= s.n && !s.over; i++) {
      var seat = (s.dealer + i) % s.n, hand = cbList(s.kept[seat]), r = cbShow(hand, starter, false);
      show.push({ seat: seat, crib: 0, cards: s.kept[seat], pts: r.pts, why: r.why });
      cbAdd(s, seat, r.pts, '@' + seat + '’s hand:');
    }
    if (!s.over) {
      var c = cbShow(cbList(s.crib), starter, true);
      show.push({ seat: s.dealer, crib: 1, cards: s.crib, pts: c.pts, why: c.why });
      cbAdd(s, s.dealer, c.pts, '@' + s.dealer + '’s crib:');
    }
    s.show = show; s.phase = 'show'; s.turn = (s.dealer + 1) % s.n;
  }

  /* After a card is played: hand the turn on, calling "go" and resetting the count when nobody can play. */
  function cbAdvance(s, p) {
    var i, seat;
    if (s.count === 31) { s.count = 0; s.stack = '-'; }
    for (i = 1; i <= s.n; i++) { seat = (p + i) % s.n; if (cbCanPlay(s, seat)) { s.turn = seat; return; } }
    if (s.count > 0) { cbAdd(s, p, 1, '@' + p + (cbCardsLeft(s) ? ' takes the go:' : ' plays the last card:')); s.count = 0; s.stack = '-'; }
    if (s.over) return;
    if (!cbCardsLeft(s)) {
      if (s.opts && s.opts.self) { delete s.show; s.phase = 'count'; s.ci = 0; s.turn = cbCounting(s).seat; }
      else cbCountHands(s);
      return;
    }
    for (i = 1; i <= s.n; i++) { seat = (p + i) % s.n; if (s.hands[seat].length > 1) { s.turn = seat; return; } }
  }

  function cbMoves(s) {
    if (s.over) return [];
    if (s.phase === 'show') return [{ next: 1 }];
    if (s.phase === 'count') {
      var cur = cbCounting(s);
      return [{ count: cbCombos(cur.hand, cur.starter, cur.crib).map(function (c) { return c.k; }) }];
    }
    var hand = cbList(s.hands[s.turn]), out = [], i, j;
    if (s.phase === 'discard') {
      if (s.n === 2) { for (i = 0; i < hand.length; i++) for (j = i + 1; j < hand.length; j++) out.push({ d: hand[i] + hand[j] }); }
      else for (i = 0; i < hand.length; i++) out.push({ d: hand[i] });
      return out;
    }
    hand.forEach(function (c) { if (s.count + cbVal(c) <= 31) out.push({ c: c }); });
    return out;
  }

  function cbPlay(s0, m) {
    var s = JSON.parse(JSON.stringify(s0)), p = s.turn, hand = cbList(s.hands[p]);
    if (s.over) throw new Error('The game is over');
    if (s.phase === 'show') {
      if (!m.next) throw new Error('That move is not allowed');
      s.dealer = (s.dealer + 1) % s.n; s.hand++;
      cbDeal(s);
      return s;
    }
    if (s.phase === 'count') {
      var cur = cbCounting(s), combos = cbCombos(cur.hand, cur.starter, cur.crib), want = m.count || [];
      var got = combos.filter(function (c) { return want.indexOf(c.k) >= 0; }), lost = combos.filter(function (c) { return want.indexOf(c.k) < 0; });
      var pts = got.reduce(function (t, c) { return t + c.pts; }, 0), max = combos.reduce(function (t, c) { return t + c.pts; }, 0);
      var entry = { seat: cur.seat, crib: cur.crib ? 1 : 0, cards: cbStr(cur.hand), pts: pts, why: cbWhy(got), max: max };
      if (lost.length) entry.missed = lost.map(function (c) { return cbKeyLabel(c.k) + ' (' + c.pts + ')'; }).join(', ');
      s.show = (s.show || []).concat([entry]);
      var what = '@' + cur.seat + ' counts ' + (cur.crib ? 'the crib' : 'a hand') + ':';
      if (pts) cbAdd(s, cur.seat, pts, what); else cbLog(s, what + ' no points.');
      if (s.over) return s;
      s.ci++;
      if (s.ci > s.n) { s.phase = 'show'; s.turn = (s.dealer + 1) % s.n; }
      else s.turn = cbCounting(s).seat;
      return s;
    }
    if (s.phase === 'discard') {
      var give = cbList('-' + (m.d || '')), need = s.n === 2 ? 2 : 1;
      if (give.length !== need || give[0] === give[1] || !give.every(function (c) { return hand.indexOf(c) >= 0; })) throw new Error('That move is not allowed');
      hand = hand.filter(function (c) { return give.indexOf(c) < 0; });
      s.hands[p] = cbStr(hand);
      s.crib = cbStr(cbList(s.crib).concat(give));
      if (p !== s.dealer) { s.turn = (p + 1) % s.n; return s; }
      for (var i = 0; i < s.n; i++) s.kept[i] = s.hands[i];
      var deck = cbList(s.deck), cut = deck.shift();
      s.deck = cbStr(deck); s.starter = cbStr([cut]);
      cbLog(s, 'The starter is ' + cbName(cut) + '.');
      if (cut[0] === 'J') cbAdd(s, s.dealer, 2, '@' + s.dealer + ' turned a jack:');
      s.phase = 'play'; s.turn = (s.dealer + 1) % s.n;
      return s;
    }
    if (!m.c || hand.indexOf(m.c) < 0 || s.count + cbVal(m.c) > 31) throw new Error('That move is not allowed');
    hand.splice(hand.indexOf(m.c), 1);
    s.hands[p] = cbStr(hand);
    s.tbl[p] = cbStr(cbList(s.tbl[p]).concat([m.c]));
    var stack = cbList(s.stack).concat([m.c]);
    s.stack = cbStr(stack); s.count += cbVal(m.c); s.lastp = p;
    var peg = cbPeg(stack, s.count);
    if (peg.pts) cbAdd(s, p, peg.pts, '@' + p + ' plays ' + cbName(m.c) + ' to ' + s.count + ' for ' + peg.why + ':');
    else cbLog(s, '@' + p + ' plays ' + cbName(m.c) + ' to ' + s.count + '.');
    if (!s.over) cbAdvance(s, p);
    return s;
  }

  /* Rough worth of the cards sent to a crib. */
  function cbCribWorth(give) {
    var v = 0;
    give.forEach(function (c) { if (c[0] === '5') v += 1.2; });
    if (give.length === 2) {
      if (give[0][0] === give[1][0]) v += 2.4;
      if (cbVal(give[0]) + cbVal(give[1]) === 15) v += 2.2;
      var gap = Math.abs(cbRank(give[0]) - cbRank(give[1]));
      if (gap === 1) v += 0.9; else if (gap === 2) v += 0.4;
      if (give[0][1] === give[1][1]) v += 0.15;
    }
    return v;
  }

  function cbAI(s, level) {
    var mv = cbMoves(s);
    if (!mv.length) return null;
    if (s.phase === 'show') return { next: 1 };
    if (s.phase === 'count') return mv[0];
    var p = s.turn, hand = cbList(s.hands[p]), best = -INF, pick = mv[0], i;
    if (s.phase === 'discard') {
      var mine = cbSide(s, p) === cbSide(s, s.dealer), all = [];
      if (level === 2) for (i = 0; i < 13; i++) for (var j = 0; j < 4; j++) { var cc = CB_RANKS[i] + CB_SUITS[j]; if (hand.indexOf(cc) < 0) all.push(cc); }
      mv.forEach(function (m) {
        var give = cbList('-' + m.d), keep = hand.filter(function (c) { return give.indexOf(c) < 0; }), v = 0;
        if (level === 2) { all.forEach(function (st) { v += cbShow(keep, st, false).pts; }); v /= all.length; }
        else {                                  // judge the four kept cards on their own
          var a, b, sum;
          for (a = 0; a < 4; a++) for (b = a + 1; b < 4; b++) {
            if (keep[a][0] === keep[b][0]) v += 2;
            if (cbVal(keep[a]) + cbVal(keep[b]) === 15) v += 2;
            if (Math.abs(cbRank(keep[a]) - cbRank(keep[b])) === 1) v += 0.7;
          }
          sum = keep.reduce(function (t, c) { return t + cbVal(c); }, 0);
          if (sum === 15) v += 2;
        }
        v += (mine ? 1 : -1) * cbCribWorth(give) * (level === 0 ? 0 : 1);
        v += Math.random() * (level === 0 ? 6 : 0.05);
        if (v > best) { best = v; pick = m; }
      });
      return { d: pick.d };
    }
    var stack = cbList(s.stack);
    mv.forEach(function (m) {
      var count = s.count + cbVal(m.c), v = cbPeg(stack.concat([m.c]), count).pts * 10;
      if (level > 0) {
        if (count === 5 || count === 21) v -= 3;            // leaves an easy fifteen or thirty-one
        if (count < 15 && count > 4 && 15 - count <= 10) v -= 1;
        if (!stack.length && cbVal(m.c) < 5) v += 2;        // a low lead cannot be made into fifteen
        if (!stack.length && m.c[0] === '5') v -= 4;
        v += cbVal(m.c) * 0.15;                             // otherwise shed high cards first
        if (level === 2 && hand.filter(function (c) { return c[0] === m.c[0]; }).length > 1 && count <= 31 - cbVal(m.c)) v += 1.5;
      }
      v += Math.random() * (level === 0 ? 14 : 0.05);
      if (v > best) { best = v; pick = m; }
    });
    return { c: pick.c };
  }

  var cribbage = {
    id: 'cribbage', cats: ['cards'], name: 'Cribbage', min: 2, max: 4, seats: [], ui: 'cards', teams: true,
    aiDelay: function (s) { return s.phase === 'show' ? 7000 : s.phase === 'count' ? 3500 : 1200; },
    options: [
      { key: 'self', label: 'Players count their own hands' },
      { key: 'tell', label: 'Say when a hand is fully counted', needs: 'self' }
    ],
    blurb: 'The classic card game to 121. Build your hand, feed the crib, and peg points as the cards go down. Four play as two teams.',
    help: [
      'Two players are dealt 6 cards each and send 2 to the crib. Three or four players are dealt 5 and send 1. The crib is an extra hand that scores for the dealer. With four players, partners sit across from each other and share one score.',
      'After the crib is filled, a starter card is turned. If it is a jack, the dealer scores 2.',
      'The play: starting left of the dealer, take turns laying one card and adding its value to the count. Face cards count 10 and aces 1. The count may not pass 31. If you cannot play, you are skipped.',
      'Points in the play: 2 for making the count 15, 2 for 31, 2 for a pair, 6 for three of a kind, 12 for four, and the length of a run of three or more made by the latest cards in any order. The last player able to play before the count resets scores 1.',
      'The show: each hand is counted with the starter, left of the dealer first, then the dealer, then the crib. Each combination adding to 15 scores 2, each pair 2, each run its length. Four cards of one suit in hand score 4, or 5 with the starter. The crib needs all five. A jack matching the starter suit scores 1.',
      'If the game was started with players counting their own hands, tap the cards that make a fifteen, a pair or a run and claim each one. You score what you find, and anything you miss is shown afterwards.',
      'The first player or team to 121 wins at once, even in the middle of a hand. The deal passes to the left after every hand.'
    ],
    init: function (n, opts) {
      n = Math.max(2, Math.min(4, n || 2));
      var self = opts && opts.self ? 1 : 0;
      var s = { n: n, dealer: Math.floor(Math.random() * n), hand: 1, over: 0, won: -1, score: [], log: [], opts: { self: self, tell: self && opts.tell ? 1 : 0 } };
      for (var i = 0; i < (n === 4 ? 2 : n); i++) s.score.push(0);
      cbDeal(s);
      return s;
    },
    moves: cbMoves,
    play: cbPlay,
    outcome: function (s) {
      if (!s.over) return null;
      var team = [], i, other = 0;
      for (i = 0; i < s.n; i++) if (cbSide(s, i) === s.won) team.push(i);
      s.score.forEach(function (v, k) { if (k !== s.won && v > other) other = v; });
      return { winner: team[0], team: team, reason: 'reaching 121 (' + s.score[s.won] + ' to ' + other + ')' };
    },
    hint: function (s) {
      if (s.phase === 'discard') return s.n === 2 ? 'Choose 2 cards for the crib.' : 'Choose 1 card for the crib.';
      if (s.phase === 'play') return 'Play a card. The count is ' + s.count + '.';
      if (s.phase === 'count') return s.ci >= s.n ? 'Count your crib.' : 'Count your hand.';
      return 'Deal the next hand when everyone has seen the scores.';
    },
    cards: cbList, cardName: cbName, cardValue: cbVal, sideOf: cbSide,
    counting: cbCounting, judge: cbJudge, countPoints: cbTally, comboLabel: cbKeyLabel, _combos: cbCombos,
    piece: function () { return null; },
    tally: function (s, seat) { return s.score[cbSide(s, seat)] + ' pts'; },
    alert: function () { return -1; },
    ai: cbAI,
    _show: cbShow, _peg: cbPeg
  };

  /* --------------------------------------------------------------- Pond Snap */
  /* Real time, not turn based. Fireflies drift on paths worked out from a shared seed, so every screen
     shows the same pond. A snap is saved as that player's own claim on a firefly; the earliest claim wins. */
  function psRng(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function psFly(s, i) {
    var r = psRng(s.seed + i * 7919), k = s.slow ? 0.55 : 1;
    return { ts: i * s.gap, c: r() * 6.283, w: (0.45 + r() * 0.55) * (r() < 0.5 ? -1 : 1) * k, a: (0.55 + r() * 0.55) * k };
  }
  function psPos(s, i, t) {
    var f = psFly(s, i), tau = (t - s.t0) / 1000 - f.ts;
    if (tau < 0) return null;
    var rad = 0.08 + 0.64 * Math.abs(Math.sin(f.a * tau)), ang = f.c + f.w * tau;
    return { x: rad * Math.cos(ang), y: rad * Math.sin(ang) };
  }
  function psAngle(s, k) { return Math.PI / 2 + k * 2 * Math.PI / s.n; }
  function psZone(s, k) { var a = psAngle(s, k); return { x: 0.62 * Math.cos(a), y: 0.62 * Math.sin(a), r: s.slow ? 0.3 : 0.24 }; }
  function psEnd(s) { return s.t0 + s.dur * 1000; }
  function psOwner(s, i) {
    var best = -1, bt = Infinity, eat = s.eat || {};
    for (var k = 0; k < s.n; k++) {
      var t = eat['s' + k] && eat['s' + k]['m' + i];
      if (typeof t === 'number' && t <= psEnd(s) && t < bt) { bt = t; best = k; }
    }
    return best;
  }
  function psInZone(s, k, t) {
    var z = psZone(s, k), out = [];
    if (t < s.t0 || t > psEnd(s)) return out;
    for (var i = 0; i < s.count; i++) {
      var p = psPos(s, i, t);
      if (p && (p.x - z.x) * (p.x - z.x) + (p.y - z.y) * (p.y - z.y) < z.r * z.r && psOwner(s, i) < 0) out.push(i);
    }
    return out;
  }
  function psScores(s) {
    var sc = [], i;
    for (i = 0; i < s.n; i++) sc.push(0);
    for (i = 0; i < s.count; i++) { var o = psOwner(s, i); if (o >= 0) sc[o]++; }
    return sc;
  }
  var pondsnap = {
    id: 'pondsnap', cats: ['young'], name: 'Pond Snap', like: 'Hungry Hungry Hippos', min: 2, max: 4, seats: [], ui: 'snap', realtime: true,
    blurb: 'Everyone plays at once. Fireflies drift over the pond, and your frog snaps up any that come close. Most fireflies wins.',
    options: [{ key: 'slow', label: 'Gentle pace: slower fireflies and a longer reach' }],
    help: [
      'There are no turns. When the countdown ends, fireflies start drifting out from the middle of the pond.',
      'Your frog sits at the bottom of your screen. The ring in front of it shows how far its tongue reaches.',
      'Press the big Snap button, or tap the pond, whenever a firefly is inside your ring. Every firefly in the ring is caught.',
      'If two frogs snap at the same firefly, the earlier snap gets it.',
      'The round ends when every firefly is caught or the time runs out. Whoever caught the most wins.'
    ],
    init: function (n, opts) {
      n = Math.max(2, Math.min(4, n || 2));
      var slow = opts && opts.slow ? 1 : 0;
      return { n: n, turn: -1, slow: slow, seed: Math.floor(Math.random() * 1e9), t0: Date.now() + 6000, dur: slow ? 75 : 55, count: slow ? 24 : 30, gap: slow ? 1.7 : 1.1 };
    },
    flyAt: psPos, zone: psZone, angle: psAngle, owner: psOwner, inZone: psInZone, scores: psScores, endsAt: psEnd,
    finished: function (s, t) {
      if (t > psEnd(s)) return true;
      for (var i = 0; i < s.count; i++) if (psOwner(s, i) < 0) return false;
      return true;
    },
    finish: function (s) {
      var sc = psScores(s), top = Math.max.apply(null, sc), who = [];
      sc.forEach(function (v, k) { if (v === top) who.push(k); });
      if (who.length > 1) return { winner: -1, reason: 'tied on ' + top + ' fireflies' };
      return { winner: who[0], reason: 'catching ' + top + ' fireflies' };
    },
    hint: function () { return 'Snap when a firefly is inside your ring.'; },
    moves: function () { return []; },
    play: function () { throw new Error('Pond Snap has no turns'); },
    outcome: function () { return null; },
    piece: function () { return null; },
    tally: function (s, seat) { return psScores(s)[seat] + ' caught'; },
    alert: function () { return -1; },
    ai: function () { return null; }
  };

  /* ----------------------------------------------------------------- Go Fish */
  var GF_PLURAL = { A: 'aces', T: '10s', J: 'jacks', Q: 'queens', K: 'kings' };
  function gfPlural(r) { return GF_PLURAL[r] || r + 's'; }
  function gfTotal(s) { var t = 0; s.books.forEach(function (b) { t += b.length - 1; }); return t; }
  function gfBooks(s, p) {
    var hand = cbList(s.hands[p]), by = {};
    hand.forEach(function (c) { by[c[0]] = (by[c[0]] || 0) + 1; });
    Object.keys(by).forEach(function (r) {
      if (by[r] < 4) return;
      hand = hand.filter(function (c) { return c[0] !== r; });
      s.books[p] += r; s.seen[p] = s.seen[p].replace(r, '');
      cbLog(s, '@' + p + ' laid down a book of ' + gfPlural(r) + '.');
    });
    s.hands[p] = cbStr(hand);
  }
  function gfDraw(s, p) {
    var pool = cbList(s.pool);
    if (!pool.length) return null;
    var c = pool.shift();
    s.pool = cbStr(pool);
    s.hands[p] = cbStr(cbSort(cbList(s.hands[p]).concat([c])));
    return c;
  }
  /* Anyone left with no cards draws one while the pool lasts; then make sure the turn sits with someone who can play. */
  function gfSettle(s) {
    var i, k;
    for (k = 0; k < 4; k++) for (i = 0; i < s.n; i++) if (s.hands[i].length <= 1 && s.pool.length > 1) { gfDraw(s, i); gfBooks(s, i); }
    if (gfTotal(s) >= 13) { s.over = 1; return; }
    for (i = 0; i < s.n && s.hands[s.turn].length <= 1; i++) s.turn = (s.turn + 1) % s.n;
    if (!gfMoves(s).length) s.over = 1;
  }
  function gfMoves(s) {
    if (s.over) return [];
    var ranks = {}, out = [];
    cbList(s.hands[s.turn]).forEach(function (c) { ranks[c[0]] = 1; });
    for (var to = 0; to < s.n; to++) {
      if (to === s.turn || s.hands[to].length <= 1) continue;
      Object.keys(ranks).forEach(function (r) { out.push({ to: to, r: r }); });
    }
    return out;
  }
  function gfPlay(s0, m) {
    var s = JSON.parse(JSON.stringify(s0)), p = s.turn;
    if (!gfMoves(s).some(function (x) { return x.to === m.to && x.r === m.r; })) throw new Error('That move is not allowed');
    var theirs = cbList(s.hands[m.to]), give = theirs.filter(function (c) { return c[0] === m.r; });
    if (s.seen[p].indexOf(m.r) < 0) s.seen[p] += m.r;
    delete s.drew;
    if (give.length) {
      s.hands[m.to] = cbStr(theirs.filter(function (c) { return c[0] !== m.r; }));
      s.hands[p] = cbStr(cbSort(cbList(s.hands[p]).concat(give)));
      s.seen[m.to] = s.seen[m.to].replace(m.r, '');
      cbLog(s, '@' + p + ' asked @' + m.to + ' for ' + gfPlural(m.r) + ' and got ' + give.length + '.');
      gfBooks(s, p);
    } else {
      var c = gfDraw(s, p);
      if (c) s.drew = { seat: p, card: c };
      if (c && c[0] === m.r) cbLog(s, '@' + p + ' asked @' + m.to + ' for ' + gfPlural(m.r) + ', went fishing and caught one. Go again.');
      else { cbLog(s, '@' + p + ' asked @' + m.to + ' for ' + gfPlural(m.r) + '. Go fish.'); s.turn = (p + 1) % s.n; }
      gfBooks(s, p);
    }
    gfSettle(s);
    return s;
  }
  var gofish = {
    id: 'gofish', cats: ['cards', 'young'], name: 'Go Fish', min: 2, max: 4, seats: [], ui: 'fish', aiDelay: 1800,
    blurb: 'Ask the others for the cards you need and collect sets of four. Guess wrong and you go fishing in the pool.',
    help: [
      'Two or three players get 7 cards each. Four players get 5. The rest make the pool.',
      'On your turn, pick a kind of card you hold, such as 7s, and ask one player for them. If they have any, they hand over all of them and you ask again.',
      'If they have none, you go fish: you draw one card from the pool. If it is the kind you asked for, you ask again. If not, your turn ends.',
      'Four of a kind is a book. Books are laid down for you as soon as you have them.',
      'If you run out of cards, you draw one from the pool while it lasts.',
      'The game ends when all 13 books are down. Most books wins.'
    ],
    init: function (n) {
      n = Math.max(2, Math.min(4, n || 2));
      var deck = [], i, j, t;
      for (i = 0; i < 13; i++) for (j = 0; j < 4; j++) deck.push(CB_RANKS[i] + CB_SUITS[j]);
      for (i = 51; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
      var s = { n: n, turn: Math.floor(Math.random() * n), over: 0, hands: [], books: [], seen: [], log: ['The cards are dealt.'] };
      for (i = 0; i < n; i++) { s.hands.push(cbStr(cbSort(deck.splice(0, n <= 3 ? 7 : 5)))); s.books.push('-'); s.seen.push('-'); }
      s.pool = cbStr(deck);
      for (i = 0; i < n; i++) gfBooks(s, i);
      gfSettle(s);
      return s;
    },
    moves: gfMoves,
    play: gfPlay,
    outcome: function (s) {
      if (!s.over) return null;
      var top = 0, who = [];
      s.books.forEach(function (b, k) { var v = b.length - 1; if (v > top) { top = v; who = [k]; } else if (v === top) who.push(k); });
      if (who.length > 1) return { winner: -1, reason: 'tied on ' + top + ' books' };
      return { winner: who[0], reason: 'collecting ' + top + ' books' };
    },
    hint: function () { return 'Pick a kind of card from your hand, then ask someone for it.'; },
    cards: cbList, cardName: cbName, plural: gfPlural,
    piece: function () { return null; },
    tally: function (s, seat) { return (s.books[seat].length - 1) + ' books'; },
    alert: function () { return -1; },
    ai: function (s, level) {
      var mv = gfMoves(s), best = -INF, pick = mv[0], hand = cbList(s.hands[s.turn]);
      if (!mv.length) return null;
      mv.forEach(function (m) {
        var v = Math.random() * (level === 0 ? 20 : 1);
        if (level > 0 && s.seen[m.to].indexOf(m.r) >= 0) v += 10;                 // they asked for it or were given it
        if (level === 2) v += hand.filter(function (c) { return c[0] === m.r; }).length * 1.5;
        if (v > best) { best = v; pick = m; }
      });
      return { to: pick.to, r: pick.r };
    }
  };

  /* ------------------------------------------------------------ Mystery Face */
  /* Each code is hair color, hair style (0 bald, 1 short, 2 long, 3 curly), hat, glasses, beard, skin tone, shirt color.
     The set was picked so that no two people share the same hair, hat, glasses and beard. */
  var MF_CODES = '0300021 3300134 0000011 3200021 0100130 4110022 3101104 3100030 3210022 0310002 1201134 0201024 4100011 1100024 1310103 2201133 3001033 3310032 1201011 1301023 0210002 4101023 2101023 2100122'.split(' ');
  var MF_HE = ['Ben', 'Dev', 'Finn', 'Gus', 'Ivan', 'Kai', 'Milo', 'Omar', 'Sam', 'Uri', 'Walt', 'Quinn'];
  var MF_SHE = ['Ada', 'Cleo', 'Elsa', 'Hana', 'Joy', 'Lena', 'Nora', 'Pia', 'Rosa', 'Tess', 'Vera', 'Zoe'];
  var MF_PEOPLE = (function () {
    var he = MF_HE.slice(), she = MF_SHE.slice();
    var out = MF_CODES.map(function (c) { return { name: '', hair: +c[0], style: +c[1], hat: c[2] === '1', glasses: c[3] === '1', beard: c[4] === '1', skin: +c[5], shirt: +c[6] }; });
    out.forEach(function (p) { if (p.beard) p.name = he.shift(); });
    out.forEach(function (p, i) { if (!p.name) p.name = (i % 2 && he.length) || !she.length ? he.shift() : she.shift(); });
    return out;
  })();
  var MF_NAMES = MF_PEOPLE.map(function (p) { return p.name; });
  var mystery = {
    id: 'mystery', cats: ['young'], name: 'Mystery Face', like: 'Guess Who?', min: 2, max: 2, seats: [], ui: 'faces', realtime: true, noAI: true,
    blurb: 'Each of you has a secret person. Ask yes or no questions out loud, flip down the faces that do not fit, and name the other player’s person first.',
    people: MF_PEOPLE,
    hairNames: ['black', 'brown', 'blond', 'red', 'white'],
    help: [
      'This one is for two people who can talk to each other, in the same room or on a call. The game does not carry the questions for you.',
      'You are each given a secret person, shown at the top of your own screen.',
      'Take turns asking one yes or no question out loud, such as "Does your person wear glasses?"',
      'Tap a face to flip it down when it cannot be the answer. Tap it again to stand it back up.',
      'When you think you know, press Make a guess and pick a face. A right guess wins. A wrong guess loses.'
    ],
    init: function () {
      var a = Math.floor(Math.random() * 24), b = Math.floor(Math.random() * 23);
      if (b >= a) b++;
      var z = '000000000000000000000000';
      return { n: 2, turn: -1, over: 0, won: -1, why: 'x', secret: [a, b], down: { s0: z, s1: z } };
    },
    moves: function () { return []; },
    play: function (s0, m) {
      var s = JSON.parse(JSON.stringify(s0));
      if (s.over || (m.seat !== 0 && m.seat !== 1) || !(m.guess >= 0 && m.guess < 24)) throw new Error('That move is not allowed');
      var real = s.secret[1 - m.seat];
      s.over = 1;
      if (m.guess === real) { s.won = m.seat; s.why = 'guessing ' + MF_NAMES[real] + ' correctly'; }
      else { s.won = 1 - m.seat; s.why = 'a wrong guess of ' + MF_NAMES[m.guess] + ', when it was ' + MF_NAMES[real]; }
      return s;
    },
    outcome: function (s) { return s.over ? { winner: s.won, reason: s.why } : null; },
    hint: function () { return 'Ask each other yes or no questions out loud. Tap a face to flip it down.'; },
    piece: function () { return null; },
    tally: function () { return ''; },
    alert: function () { return -1; },
    ai: function () { return null; }
  };

  /* ------------------------------------------------------------- Banner Clash */
  /* Two armies of 40 on a 10x10 field with two ponds. Ranks are hidden from the other side until a clash.
     Three strings of 100 describe the field: own (. empty, # pond, 0 or 1 owner), rk (rank), and
     seen / mv flags (1 when a piece has been revealed, or has moved). */
  /* Side 0 is the evil army (moves first), side 1 the good army. Same ranks and powers, different names. */
  var BC_NAMES = [
    { X: 'The Lich King', 9: 'The Black Dragon', 8: 'Vampire Lord', 7: 'Death Knight', 6: 'Troll', 5: 'Skeleton Archer', 4: 'Skeleton', 3: 'Grave Digger', 2: 'Bat Swarm', 1: 'Imp', B: 'Bone Trap', F: 'Black Banner' },
    { X: 'The King', 9: 'Court Wizard', 8: 'Paladin', 7: 'Knight', 6: 'Guard', 5: 'Archer', 4: 'Squire', 3: 'Digger', 2: 'Runner', 1: 'Trickster', B: 'Trap', F: 'Royal Banner' }
  ];
  var BC_COUNT = { X: 1, 9: 1, 8: 2, 7: 3, 6: 4, 5: 4, 4: 4, 3: 5, 2: 8, 1: 1, B: 6, F: 1 };
  var BC_ORDER = ['X', '9', '8', '7', '6', '5', '4', '3', '2', '1', 'B', 'F'];
  var BC_VAL = { X: 100, 9: 80, 8: 60, 7: 45, 6: 35, 5: 25, 4: 18, 3: 30, 2: 10, 1: 40, B: 20, F: 1000 };
  var BC_PONDS = [42, 43, 52, 53, 46, 47, 56, 57];
  function bcNum(r) { return r === 'X' ? 10 : +r; }
  function bcLabel(r, side) { var n = BC_NAMES[side === 1 ? 1 : 0][r]; return r === 'B' || r === 'F' ? n : n + ' (' + bcNum(r) + ')'; }
  /* What a piece is and does, for the portrait panel. */
  function bcAbout(r, side) {
    side = side === 1 ? 1 : 0;
    var mine = BC_NAMES[side], foe = BC_NAMES[1 - side], rule;
    if (r === 'X') rule = 'The strongest piece. Only an attacking ' + foe['1'] + ' or a trap can bring it down.';
    else if (r === '3') rule = 'The only piece that can clear a trap. Everything else that walks into one is removed.';
    else if (r === '2') rule = 'Moves any number of open squares in a straight line. Good for scouting.';
    else if (r === '1') rule = 'Defeats ' + foe.X + ' if it attacks first. Loses to everything else.';
    else if (r === 'B') rule = 'Never moves. Removes any attacker except a ' + foe['3'] + '.';
    else if (r === 'F') rule = 'Never moves. If the enemy captures it, you lose the game.';
    else rule = 'Defeats any lower power. Falls to any higher power. Equal powers remove each other.';
    return { name: mine[r], power: r === 'B' || r === 'F' ? '' : 'Power ' + bcNum(r), count: BC_COUNT[r], rule: rule };
  }
  function bcClash(a, d) {
    if (d === 'F') return 'flag';
    if (d === 'B') return a === '3' ? 'win' : 'lose';
    if (a === '1' && d === 'X') return 'win';
    return bcNum(a) > bcNum(d) ? 'win' : bcNum(a) === bcNum(d) ? 'tie' : 'lose';
  }
  /* A sensible random setup: banner in the back row with traps around it. Index 0-9 is the front row, 30-39 the back. */
  function bcSetup() {
    var cells = [], i, j, t, col = Math.floor(Math.random() * 10), flag = 30 + col, bag = [];
    for (i = 0; i < 40; i++) cells.push('');
    cells[flag] = 'F';
    var guard = [flag - 10]; if (col > 0) guard.push(flag - 1); if (col < 9) guard.push(flag + 1);
    guard.forEach(function (g) { cells[g] = 'B'; });
    BC_ORDER.forEach(function (r) { for (var k = 0; k < BC_COUNT[r]; k++) bag.push(r); });
    bag.splice(bag.indexOf('F'), 1);
    guard.forEach(function () { bag.splice(bag.indexOf('B'), 1); });
    for (i = bag.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
    for (i = 0; i < 40; i++) if (!cells[i]) cells[i] = bag.pop();
    for (i = 0; i < 10; i++) if (cells[i] === 'B') {             // traps do more good behind the front row
      for (j = 39; j >= 10; j--) if (cells[j] !== 'B' && cells[j] !== 'F') { t = cells[i]; cells[i] = cells[j]; cells[j] = t; break; }
    }
    return cells.join('');
  }
  function bcValidSetup(str) {
    if (typeof str !== 'string' || str.length !== 40) return false;
    var c = {};
    for (var i = 0; i < 40; i++) c[str[i]] = (c[str[i]] || 0) + 1;
    return BC_ORDER.every(function (r) { return c[r] === BC_COUNT[r]; });
  }
  function bcCell(seat, k) { var r = Math.floor(k / 10), c = k % 10; return seat === 0 ? (6 + r) * 10 + c : (3 - r) * 10 + (9 - c); }

  function bcMovesFor(s, seat) {
    var out = [], me = String(seat), i, d, steps = [-10, 10, -1, 1];
    for (i = 0; i < 100; i++) {
      if (s.own[i] !== me || s.rk[i] === 'B' || s.rk[i] === 'F') continue;
      var reach = s.rk[i] === '2' ? 9 : 1;
      for (d = 0; d < 4; d++) {
        var j = i;
        for (var n = 0; n < reach; n++) {
          if ((steps[d] === -1 && j % 10 === 0) || (steps[d] === 1 && j % 10 === 9)) break;
          j += steps[d];
          if (j < 0 || j > 99 || s.own[j] === '#' || s.own[j] === me) break;
          out.push({ from: i, to: j });
          if (s.own[j] !== '.') break;
        }
      }
    }
    var lm = s.lm[seat];                    // no shuttling: at most three moves in a row between the same two squares
    return out.filter(function (m) { return !(lm[2] >= 3 && m.from === lm[1] && m.to === lm[0]); });
  }

  function bcPlay(s0, m) {
    var s = JSON.parse(JSON.stringify(s0)), i, k, seat;
    if (s.over) throw new Error('The game is over');
    if (s.phase === 'setup') {
      if (!m.start || !s.ready.s0 || !s.ready.s1 || !bcValidSetup(s.setup.s0) || !bcValidSetup(s.setup.s1)) throw new Error('Both sides must be ready');
      var own = [], rk = [];
      for (i = 0; i < 100; i++) { own.push(BC_PONDS.indexOf(i) >= 0 ? '#' : '.'); rk.push('.'); }
      for (seat = 0; seat < 2; seat++) for (k = 0; k < 40; k++) { var c = bcCell(seat, k); own[c] = String(seat); rk[c] = s.setup['s' + seat][k]; }
      s.own = own.join(''); s.rk = rk.join('');
      s.seen = new Array(101).join('0'); s.mv = s.seen;
      s.phase = 'play'; s.turn = 0;
      return s;
    }
    var p = s.turn;
    if (!bcMovesFor(s, p).some(function (x) { return x.from === m.from && x.to === m.to; })) throw new Error('That move is not allowed');
    var O = s.own.split(''), R = s.rk.split(''), E = s.seen.split(''), M = s.mv.split('');
    var a = R[m.from], d = O[m.to] === '.' ? '' : R[m.to], res = d ? bcClash(a, d) : 'move';
    var lift = function (x) { O[x] = '.'; R[x] = '.'; E[x] = '0'; M[x] = '0'; };
    var eye = d ? '1' : E[m.from];
    lift(m.from);
    if (res === 'move' || res === 'win' || res === 'flag') { O[m.to] = String(p); R[m.to] = a; E[m.to] = eye; M[m.to] = '1'; }
    else if (res === 'tie') lift(m.to);
    else E[m.to] = '1';
    s.own = O.join(''); s.rk = R.join(''); s.seen = E.join(''); s.mv = M.join('');
    s.last = { seat: p, from: m.from, to: m.to, a: a, d: d || '-', res: res };
    s.mc = (s.mc || 0) + 1;
    if (d) s.fights = (s.fights || []).concat([p + a + d + res[0] + ':' + s.mc]).slice(-12);   // who attacked, with what, against what, how it went, on which move
    var lm = s.lm[p];
    s.lm[p] = (m.from === lm[1] && m.to === lm[0]) ? [m.from, m.to, lm[2] + 1] : [m.from, m.to, 1];
    s.quiet = d ? 0 : s.quiet + 1;
    if (res === 'flag') { s.over = 1; s.won = p; s.why = 'capturing the banner'; return s; }
    s.turn = 1 - p;
    if (!bcMovesFor(s, s.turn).length) {
      s.over = 1;
      if (bcMovesFor(s, p).length) { s.won = p; s.why = 'leaving the other side with nothing that can move'; }
      else { s.won = -1; s.why = 'neither side can move'; }
    } else if (s.quiet >= 200) { s.over = 1; s.won = -1; s.why = '100 moves each without a clash'; }
    return s;
  }

  /* The AI looks only at its own pieces and at enemy pieces that have been revealed. */
  function bcAI(s, level) {
    if (s.phase !== 'play') return null;
    var p = s.turn, me = String(p), foe = String(1 - p), mv = bcMovesFor(s, p), i;
    if (!mv.length) return null;
    var pool = {}, poolMoved = {}, nAll = 0, nMoved = 0;          // enemy ranks not yet revealed
    for (i = 0; i < 100; i++) if (s.own[i] === foe && s.seen[i] === '0') pool[s.rk[i]] = (pool[s.rk[i]] || 0) + 1;
    Object.keys(pool).forEach(function (r) { nAll += pool[r]; if (r !== 'B' && r !== 'F') { poolMoved[r] = pool[r]; nMoved += pool[r]; } });
    var worth = function (a, d) { var r = bcClash(a, d); return r === 'flag' ? 1000 : r === 'win' ? BC_VAL[d] : r === 'tie' ? BC_VAL[d] - BC_VAL[a] : -BC_VAL[a]; };
    var near = function (x) { var o = []; if (x >= 10) o.push(x - 10); if (x < 90) o.push(x + 10); if (x % 10) o.push(x - 1); if (x % 10 < 9) o.push(x + 1); return o; };
    var threat = function (x, a) {                                  // a revealed enemy next to x that would beat a
      return near(x).some(function (y) { return s.own[y] === foe && s.seen[y] === '1' && s.rk[y] !== 'B' && s.rk[y] !== 'F' && bcClash(s.rk[y], a) === 'win'; });
    };
    var best = -INF, pick = mv[0];
    mv.forEach(function (m) {
      var a = s.rk[m.from], v = 0;
      if (s.own[m.to] === foe) {
        if (s.seen[m.to] === '1') v = worth(a, s.rk[m.to]);
        else {
          var src = s.mv[m.to] === '1' ? poolMoved : pool, tot = s.mv[m.to] === '1' ? nMoved : nAll;
          Object.keys(src).forEach(function (r) { v += src[r] / (tot || 1) * worth(a, r); });
          if (level === 0) v = v * 0.3 + 5;
        }
      } else {
        var fwd = p === 0 ? Math.floor(m.from / 10) - Math.floor(m.to / 10) : Math.floor(m.to / 10) - Math.floor(m.from / 10);
        v = fwd * 1.2 + (a === '2' ? 0.6 : 0) - (a === 'X' || a === '1' ? 0.8 : 0);
        if (level > 0) {
          if (threat(m.to, a)) v -= BC_VAL[a] * 0.6;
          if (threat(m.from, a) && !threat(m.to, a)) v += BC_VAL[a] * 0.5;
          if (near(m.to).some(function (y) { return s.own[y] === foe && s.seen[y] === '1' && (bcClash(a, s.rk[y]) === 'win' || bcClash(a, s.rk[y]) === 'flag'); })) v += 4;
        }
        if (s.lm[p][0] === m.to && s.lm[p][1] === m.from) v -= 3;      // do not dither
      }
      v += Math.random() * [40, 4, 1.5][level];
      if (v > best) { best = v; pick = m; }
    });
    return { from: pick.from, to: pick.to };
  }

  var bannerclash = {
    id: 'bannerclash', cats: ['classic'], name: 'Banner Clash', like: 'Stratego', min: 2, max: 2, seats: ['Evil army', 'Good army'], firstLabel: 'I command the evil army, which moves first', ui: 'flag', aiDelay: 900,
    blurb: 'The Lich King\u2019s undead host against the King\u2019s army. Every rank is hidden until two pieces clash. Capture the enemy banner to win.',
    names: BC_NAMES, about: bcAbout, counts: BC_COUNT, order: BC_ORDER, label: bcLabel, rankNum: bcNum, newSetup: bcSetup, validSetup: bcValidSetup,
    help: [
      'Two armies of 40 face each other: the evil army of the Lich King, and the good army of the King. The two armies have different names but the same powers. You see your own pieces. The enemy sees only their backs.',
      'Before play, arrange your pieces on your four rows. Tap two pieces to swap them, or shuffle. Keep your banner well guarded. Press ready when you are happy.',
      'The evil army moves first. On your turn move one piece one square up, down, left or right. Not diagonally, not into a pond, not onto your own piece.',
      'Power 2 pieces (Bat Swarms and Runners, marked with a foot) may go any number of open squares in a straight line. Traps and banners never move.',
      'Move onto an enemy piece to clash. Both are revealed. The higher power wins and the lower is removed. Equal powers are both removed.',
      'A trap removes anything that walks into it, except a power 3 piece (Grave Diggers and Diggers, marked with crossed tools), which clears it.',
      'The power 1 piece (the Imp and the Trickster, marked with a dagger) defeats the enemy power 10, but only when it is the one attacking.',
      'You may not move a piece back and forth between the same two squares more than three times in a row.',
      'Capture the enemy banner to win. You also win if the enemy has no piece left that can move.'
    ],
    init: function () {
      return { n: 2, phase: 'setup', turn: -1, over: 0, won: -1, why: 'x', quiet: 0, setup: { s0: bcSetup(), s1: bcSetup() }, ready: { s0: 0, s1: 0 }, lm: [[-1, -1, 0], [-1, -1, 0]] };
    },
    moves: function (s) { return s.over || s.phase !== 'play' ? [] : bcMovesFor(s, s.turn); },
    play: bcPlay,
    outcome: function (s) { return s.over ? { winner: s.won, reason: s.why } : null; },
    hint: function (s) { return s.phase === 'setup' ? 'Arrange your pieces, then press ready.' : 'Your move. Tap a piece, tap where it goes, then confirm.'; },
    piece: function () { return null; },
    tally: function (s, seat) {
      if (s.phase !== 'play') return '40 pieces';
      var n = 0;
      for (var i = 0; i < 100; i++) if (s.own[i] === String(seat)) n++;
      return n + ' pieces';
    },
    alert: function () { return -1; },
    ai: bcAI
  };


  /* --------------------------------------------------------------- Iron Roads */
  /* A train-route game on an original map. Collect colored train cards, claim routes between towns,
     and connect the towns on your destination tickets. Lists that can be empty are strings starting with "-". */
  /* Maps. towns: name, x, y, label position (0-7). routes: from, to, length, color (x = any color), bend (long lines curve), twin (other half of a double route, or -1).
     tickets: from, to, points. land: state outlines drawn behind the routes (US Census shapes via us-atlas), empty for the invented map. */
  var RR_MAPS = {
    usa: { name: 'United States', w: 1000, h: 662, minY: 0, trains: 35, fs: 22,
      land: 'M657,510L657,510L657,510ZM651,404L697,399L710,446L717,459L714,468L719,487L670,492L675,504L672,508L668,508L662,499L661,508L656,507L651,473L653,406ZM164,426L168,426L167,411L175,397L181,394L176,376L178,352L191,352L194,334L281,349L264,475L226,469L161,431ZM294,260L376,269L409,271L408,294L404,361L387,360L281,349ZM820,610L820,610L820,610ZM819,611L819,611L819,611ZM813,614L813,614L813,614ZM800,620L807,613L811,616ZM796,621L796,621L796,621ZM793,621L793,621L793,621ZM784,575L784,575L784,575ZM777,621L777,621L777,621ZM728,513L728,513L728,513ZM719,487L722,493L773,489L776,493L777,483L787,484L793,503L802,518L811,528L813,539L826,561L828,570L829,590L825,602L813,605L807,594L798,591L793,580L784,573L773,558L778,550L769,551L770,537L769,527L753,516L748,508L735,505L721,518L703,506L689,503L672,508L675,504L670,492ZM697,399L720,397L742,394L739,401L748,405L755,416L778,433L788,452L792,453L789,461L787,484L777,483L776,493L773,489L722,493L719,487L714,468L717,459L710,446ZM650,253L661,250L694,247L694,248L701,306L702,313L691,316L692,320L685,332L670,335L664,340L656,336L649,341L647,339L656,319L654,305ZM408,294L522,297L529,301L525,308L534,317L534,364L404,361ZM943,140L943,140L943,140ZM941,141L941,141L941,141ZM940,137L940,137L940,137ZM936,141L936,141L936,141ZM937,150L937,150L937,150ZM935,144L935,144L935,144ZM934,141L934,141L934,141ZM914,174L908,169L895,128L904,112L903,93L910,74L916,79L925,72L933,76L942,106L948,106L949,113L955,114L960,120L953,131L940,139L941,145L934,135L932,150L922,156L917,163ZM931,210L931,210L931,210ZM922,212L922,212L922,212ZM876,192L888,189L907,185L913,179L918,183L913,190L924,201L934,201L917,210L914,206L914,206L909,200L903,202L876,208ZM492,97L523,97L522,88L527,90L530,102L542,105L543,107L555,104L574,113L576,116L586,111L589,114L606,116L592,123L570,144L571,146L567,147L567,160L561,165L559,172L560,190L575,199L585,209L587,217L503,219L503,178L497,172L501,164L498,148L497,127L493,116L494,104ZM854,268L855,267L856,264L866,254L855,244L855,237L860,227L875,232L874,239L874,240L871,244L877,246L878,260L876,268L867,281L868,276L855,272L854,269ZM869,350L869,350L869,350ZM868,370L868,370L868,370ZM762,355L787,352L864,337L864,344L853,353L868,350L870,358L865,365L848,364L859,367L856,376L864,374L861,383L852,383L844,390L839,404L828,406L804,388L784,391L779,385L756,387L742,394L720,397L720,391L729,383L734,382L754,366L758,366ZM391,92L492,97L494,104L493,116L497,127L498,148L501,164L386,159ZM387,360L404,361L534,364L534,376L538,400L538,440L524,433L507,435L504,439L493,433L489,438L467,428L465,430L437,418L439,374L386,371ZM763,232L774,224L775,230L846,216L860,227L855,237L855,244L866,254L856,264L850,267L789,279L771,282L768,262ZM384,180L386,159L501,164L497,172L503,178L503,219L500,236L503,241L489,233L477,235L470,229L380,224ZM386,371L439,374L437,418L465,430L467,428L489,438L493,433L504,439L507,435L524,433L538,440L546,441L546,441L546,453L547,476L557,494L553,513L552,528L534,535L535,526L529,529L535,536L522,546L501,558L495,557L482,580L482,599L487,611L482,613L474,608L466,608L448,599L441,586L441,576L426,557L419,539L404,523L389,520L382,523L372,539L352,528L346,522L343,508L338,498L331,493L312,470L311,465L378,472L385,371ZM384,180L380,224L376,269L294,260L261,255L264,233L273,178L275,167ZM876,208L903,202L906,217L890,223L879,231ZM514,284L534,284L581,282L587,287L588,301L600,312L601,319L611,320L608,334L623,345L624,354L631,360L627,372L625,372L624,372L622,383L610,384L615,378L614,373L534,376L534,364L534,317L525,308L529,301L522,297ZM741,316L745,315L748,301L751,304L756,292L761,291L766,283L768,262L771,282L789,279L791,290L801,279L806,281L810,276L820,282L819,287L809,281L809,288L803,298L800,297L797,308L790,308L783,326L783,330L768,339L760,341L754,334L748,332L741,323ZM587,287L594,270L592,263L603,259L606,247L597,238L644,235L643,240L650,253L654,305L656,319L647,339L649,341L648,348L642,351L642,358L634,355L631,360L624,354L623,345L608,334L611,320L601,319L600,312L588,301ZM281,349L387,360L386,371L385,371L378,472L311,465L312,470L281,467L280,477L264,475ZM534,376L614,373L615,378L610,384L622,383L623,386L615,397L617,403L613,406L609,419L600,430L602,434L600,452L546,453L546,441L546,441L538,440L538,400ZM98,394L98,394L98,394ZM95,404L95,404L95,404ZM89,392L89,392L89,392ZM86,379L86,379L86,379ZM79,394L79,394L79,394ZM77,375L77,375L77,375ZM71,375L71,375L71,375ZM68,374L68,374L68,374ZM54,184L120,203L120,203L104,268L132,310L153,343L176,376L181,394L175,397L167,411L168,426L164,426L119,421L117,402L102,382L90,377L86,370L70,365L67,361L71,349L63,335L56,314L61,308L53,296L54,283L60,292L57,279L54,282L48,276L50,271L42,252L45,232L40,221L53,197ZM854,268L854,269L854,268ZM850,267L856,264L855,267L855,272L866,285L868,292L858,294ZM831,289L833,292L831,289ZM503,219L587,217L590,234L597,238L606,247L603,259L592,263L594,270L587,287L581,282L534,284L514,284L511,264L503,241L500,236ZM631,360L634,355L642,358L642,351L648,348L649,341L656,336L664,340L670,335L685,332L692,320L691,316L702,313L701,306L707,305L712,311L728,314L734,310L741,316L741,323L748,332L754,334L742,346L736,355L727,359L676,364L654,367L651,370L627,372ZM625,372L624,372L625,372ZM855,307L854,307L855,307ZM852,303L852,303L852,303ZM844,290L844,290L844,290ZM789,279L850,267L858,294L868,292L867,302L860,305L847,296L851,293L844,288L845,277L842,281L843,296L846,304L840,303L833,296L833,292L831,289L820,282L810,276L806,281L801,279L791,290ZM686,156L686,156L686,156ZM674,159L674,159L674,159ZM672,158L672,158L672,158ZM671,163L671,163L671,163ZM670,160L670,160L670,160ZM668,167L668,167L668,167ZM665,174L665,174L665,174ZM664,177L664,177L664,177ZM655,164L655,164L655,164ZM661,250L669,234L668,221L661,208L661,199L664,192L664,184L672,172L674,181L676,170L683,166L679,163L684,157L705,164L709,171L710,187L702,201L707,204L713,195L718,192L723,196L729,214L729,223L724,223L716,245L694,248L694,247ZM611,118L611,118L611,118ZM596,148L610,141L628,126L635,126L628,132L628,138L637,139L642,145L654,146L661,140L679,136L678,143L690,140L694,149L701,148L702,152L683,156L672,152L670,155L649,160L642,177L637,172L637,172L638,165L632,160L600,153L597,148L597,148ZM654,511L654,511L654,511ZM649,510L649,510L649,510ZM644,511L644,511L644,511ZM641,511L641,511L641,511ZM600,452L602,434L600,430L609,419L613,406L651,404L653,406L651,473L656,507L646,507L634,513L627,503L629,495L593,497L595,485L605,466L601,464ZM216,66L391,92L386,159L384,180L275,167L273,178L269,171L266,176L254,173L242,173L242,166L232,143L226,147L224,140L231,122L223,115L219,105L214,101L215,95L211,88ZM890,136L895,128L908,169L914,174L913,179L907,185L888,189L885,170L886,153L892,147ZM903,219L903,219L903,219ZM902,223L902,223L902,223ZM901,221L901,221L901,221ZM874,240L871,244L874,240ZM821,178L821,178L821,178ZM820,178L820,178L820,178ZM774,224L787,210L781,200L790,196L815,193L825,185L825,176L821,171L826,166L833,154L840,148L862,143L866,155L866,164L872,174L876,192L876,208L879,231L895,227L899,223L904,225L888,237L876,242L874,239L875,232L860,227L846,216L775,230ZM728,246L728,246L728,246ZM726,245L726,245L726,245ZM694,248L716,245L733,250L745,246L756,236L763,232L768,262L766,283L761,291L756,292L751,304L748,301L745,315L741,316L734,310L728,314L712,311L707,305L701,306ZM91,96L100,106L99,112L106,117L118,116L123,120L155,121L158,120L189,128L194,138L176,164L180,167L177,175L168,214L120,203L120,203L120,203L54,184L54,164L65,148L78,118L86,96ZM622,383L624,372L625,372L627,372L651,370L654,367L676,364L727,359L762,355L758,366L754,366L734,382L729,383L720,391L720,397L697,399L651,404L613,406L617,403L615,397L623,386ZM216,224L264,233L261,255L294,260L281,349L194,334ZM855,309L855,309L855,309ZM860,305L867,302L863,310L861,323L858,322ZM855,307L854,307L855,307ZM754,334L760,341L768,339L783,330L783,326L790,308L797,308L800,297L803,298L809,288L809,281L819,287L820,282L831,289L833,292L833,296L832,303L843,305L851,309L850,320L854,327L851,332L860,329L864,337L787,352L762,355L727,359L736,355L742,346ZM113,77L113,77L113,77ZM119,51L119,51L119,51ZM119,47L119,47L119,47ZM118,50L118,50L118,50ZM115,58L115,58L115,58ZM116,45L116,45L116,45ZM114,46L114,46L114,46ZM115,40L115,40L115,40ZM111,48L118,49L116,53ZM111,46L111,46L111,46ZM202,62L189,118L189,128L158,120L155,121L123,120L118,116L106,117L99,112L100,106L91,96L84,94L90,85L87,83L88,59L86,51L89,46L97,54L110,60L115,60L116,69L111,80L116,78L118,68L122,64L122,48L120,41ZM651,171L651,171L651,171ZM645,175L645,175L645,175ZM594,138L594,138L594,138ZM594,141L594,141L594,141ZM592,140L592,140L592,140ZM590,142L590,142L590,142ZM590,139L590,139L590,139ZM590,138L590,138L590,138ZM590,143L590,143L590,143ZM586,139L586,139L586,139ZM571,146L587,140L596,148L597,148L597,148L600,153L632,160L638,165L637,172L637,172L642,177L637,190L650,177L645,189L645,197L640,219L644,235L597,238L590,234L587,217L585,209L575,199L560,190L559,172L561,165L567,160L567,147ZM380,224L470,229L477,235L489,233L503,241L511,264L514,284L522,297L408,294L409,271L376,269ZM742,394L756,387L779,385L784,391L804,388L828,406L820,416L817,427L807,438L798,443L792,453L788,452L778,433L755,416L748,405L739,401ZM189,128L189,118L202,62L216,66L211,88L215,95L214,101L219,105L223,115L231,122L224,140L226,147L232,143L242,166L242,173L254,173L266,176L269,171L273,178L264,233L216,224L168,214L177,175L180,167L176,164L194,138ZM120,203L120,203L168,214L216,224L194,334L191,352L178,352L176,376L153,343L132,310L104,268ZM862,143L890,136L892,147L886,153L885,170L888,189L876,192L872,174L866,164L866,155ZM647,515L647,515L647,515ZM638,515L638,515L638,515ZM633,527L633,527L633,527ZM619,538L619,538L619,538ZM616,538L616,538L616,538ZM612,539L612,539L612,539ZM587,529L587,529L587,529ZM546,453L600,452L601,464L605,466L595,485L593,497L629,495L627,503L634,513L636,531L642,531L643,539L629,532L622,538L618,532L611,540L601,535L595,525L589,523L581,530L565,525L552,528L553,513L557,494L547,476ZM914,206L917,210L914,206ZM912,207L912,207L912,207ZM912,212L912,212L912,212ZM911,219L911,219L911,219ZM906,217L903,202L909,200L914,206L912,214Z',
      near: 'M301,668L294,659L282,640L266,625L261,616L265,615L246,600L240,597L240,590L246,585L241,575L236,574L233,566L223,559L222,551L224,547L217,545L204,530L197,516L197,511L190,493L186,474L189,466L178,460L174,453L169,455L157,443L158,449L154,460L156,475L154,481L158,491L168,503L171,514L176,517L177,524L181,527L181,540L188,548L189,556L193,559L194,568L196,564L200,569L203,582L202,590L206,596L211,613L210,623L215,629L218,624L222,629L228,641L233,645L231,651L220,657L217,654L214,640L208,636L201,627L192,618L183,608L186,594L185,584L182,577L171,566L170,558L160,561L156,555L145,547L144,542L137,532L145,535L154,531L158,523L145,499L133,487L133,475L130,472L131,463L127,458L128,453L123,444L125,438L122,434L119,421L119,421L164,426L162,429L161,430L226,469L259,474L266,475L280,477L281,467L314,471L314,471L317,476L330,490L339,499L348,523L355,530L371,538L376,534L383,522L389,520L403,522L408,526L412,530L420,540L426,556L441,574L441,585L447,596L448,599L468,608L482,612L487,610L485,619L479,631L476,645L473,668L301,668ZM212,608L212,608L212,608ZM178,507L178,512L171,503L172,499ZM135,519L135,527L132,525ZM196,516L194,521L189,519L192,512ZM80,490L80,490L80,490ZM226,625L226,625L226,625ZM159,447L159,447L159,447ZM207,584L207,584L207,584ZM186,615L186,615L186,615ZM181,608L178,608L183,598ZM77,-6L90,2L90,2L91,4L92,10L93,14L94,17L94,18L94,18L98,26L102,29L104,32L104,33L105,34L105,35L105,38L107,47L108,45L108,45L109,45L109,46L109,47L109,51L104,52L97,48L94,45L90,42L88,40L86,38L85,36L85,35L92,28L92,28L91,30L89,32L81,31L81,31L80,30L79,28L77,26L78,26L79,26L80,25L79,23L78,22L77,23L76,22L78,20L78,19L76,20L76,19L76,18L73,18L73,18L71,16L71,16L69,16L70,13L71,12L72,12L77,13L74,12L73,11L72,10L71,10L70,5L69,4L68,4L68,4L67,4L67,4L66,4L65,4L64,3L65,0L65,-1L65,-2L65,-2L64,-2L64,-1L64,-1L63,-1L62,-2L62,-3L62,-4L59,-5L57,-4L57,-4L56,-5L56,-5L57,-6L77,-6ZM699,-6L699,-5L708,4L711,7L710,10L709,11L708,12L711,11L712,11L716,13L719,14L721,15L725,18L726,19L727,21L729,24L730,26L730,26L730,28L728,30L726,33L726,33L728,31L730,28L735,28L738,29L740,30L743,33L746,35L748,37L747,36L746,34L743,32L742,31L741,29L741,28L741,26L741,24L742,23L743,22L743,21L743,20L745,19L746,20L747,20L748,20L749,21L750,21L750,22L751,23L752,26L753,27L752,25L753,23L753,22L754,20L754,19L753,19L749,16L749,15L750,14L750,13L750,11L751,10L752,8L753,6L754,3L755,3L754,3L750,-4L749,-5L749,-6L956,-6L956,-6L953,-4L948,-3L947,-3L941,0L938,0L936,3L934,3L933,4L930,6L929,9L926,11L925,20L925,24L924,26L922,27L915,31L914,34L913,35L911,36L910,37L909,39L903,50L902,55L900,59L896,61L888,59L878,60L880,60L881,61L884,61L886,60L892,61L898,63L897,71L894,77L892,80L890,87L884,96L879,100L877,101L875,101L874,103L871,105L871,107L866,113L862,116L862,118L857,128L853,129L852,130L851,133L849,135L845,135L846,136L850,136L851,138L849,139L846,142L842,148L835,152L827,163L819,174L815,185L785,191L779,196L781,199L782,203L784,210L766,223L750,229L733,244L729,244L720,238L721,231L727,225L729,214L732,201L720,163L702,154L703,150L700,148L695,149L693,145L691,140L685,142L680,133L642,116L624,107L611,115L603,115L598,113L589,114L584,113L577,116L567,110L555,105L549,105L544,107L539,104L531,102L529,100L527,91L522,88L522,97L494,97L487,97L431,95L393,92L387,91L305,82L299,81L250,73L243,71L219,66L213,65L206,64L200,62L119,41L118,39L117,39L116,40L115,40L116,37L115,37L115,37L115,36L115,35L115,34L116,34L117,34L119,34L120,34L119,34L118,34L116,32L115,32L115,31L118,25L113,29L112,30L107,26L106,22L107,21L109,25L113,24L111,24L110,23L109,23L109,21L109,20L110,16L111,15L112,14L112,14L112,13L112,12L111,12L111,12L109,16L109,16L107,18L105,19L103,19L102,18L99,13L98,12L98,10L97,6L98,5L97,4L101,-3L102,-6L100,-5L100,-4L99,-1L97,0L95,0L91,-1L91,-2L91,-3L90,-2L89,-2L87,-3L87,-3L81,-6L699,-6ZM1006,109L1006,109L1005,110L1006,111L1005,113L1004,111L1002,112L1002,115L1003,115L1004,117L1003,118L1003,118L1002,121L1001,122L1000,126L999,128L999,130L994,135L993,136L993,139L993,139L992,140L990,140L989,141L987,141L985,137L983,136L982,137L982,137L982,138L980,137L977,132L977,120L975,124L976,121L977,119L979,118L981,117L982,115L982,114L981,115L980,117L980,115L989,103L996,97L996,98L996,98L999,100L1001,102L999,99L1000,97L1005,94L1006,93L1006,109ZM1006,91L991,96L990,97L990,98L988,98L987,98L992,88L992,87L992,85L991,86L983,95L981,98L978,102L974,106L969,105L970,104L970,103L970,103L969,104L968,105L970,107L966,112L965,111L960,114L955,113L955,113L950,113L948,105L942,105L933,76L927,73L924,72L917,78L914,77L913,76L909,74L903,93L902,104L903,111L898,128L896,127L895,129L892,129L890,136L865,142L859,144L842,148L844,147L847,142L854,136L857,135L857,134L857,131L857,130L858,127L859,124L862,118L865,115L868,111L870,109L873,105L875,102L879,101L884,97L895,86L896,82L898,79L898,77L900,73L902,68L905,62L908,56L910,53L911,52L913,50L915,48L917,45L921,41L925,37L942,24L953,19L961,18L965,18L971,21L972,22L970,23L968,24L970,24L974,28L973,32L970,34L969,36L969,38L968,38L967,40L966,41L963,44L962,45L960,45L956,45L952,44L952,45L951,46L948,47L948,48L945,48L942,51L944,51L946,49L950,49L956,49L957,50L960,53L961,53L962,52L964,50L965,49L968,47L968,48L970,47L973,48L972,52L973,56L971,60L969,64L971,64L973,63L974,62L976,62L977,68L979,70L980,70L982,73L983,75L984,76L986,78L991,77L992,77L996,76L997,77L995,80L998,81L1001,82L1004,81L1006,81L1006,91ZM1004,5L993,8L989,8L986,8L977,7L975,5L973,4L971,4L962,3L965,-1L978,-2L981,-3L984,-2L988,-2L997,0L998,0L1002,1L1004,2L1004,4ZM1006,71L1006,71L1005,72L1006,72L1006,73L1006,73L1005,74L1001,74L999,74L998,73L996,72L996,71L996,71L995,71L993,72L991,72L990,69L988,68L985,69L986,64L986,63L987,61L988,58L989,60L989,61L989,65L993,67L995,70L995,70L996,70L996,69L1001,67L1001,67L1003,67L1005,67L1006,67L1006,71ZM720,-6L721,-6L722,-3L722,-2L722,-2L718,-2L716,-2L713,-3L706,-4L703,-5L703,-6L703,-6L720,-6ZM75,19L75,22L74,18L75,19ZM100,20L99,20L98,18L101,19L102,21ZM69,12L69,12L67,10L66,8L66,7L67,7L67,7L67,6L69,5L70,6L70,7L70,9L70,11ZM93,8L92,9L92,7L92,3L92,2L93,1L94,1L95,2L95,3L95,4L95,5L95,6L94,7ZM109,44L108,44L108,44L108,43L108,40L109,41L109,43L109,44ZM975,44L975,45L974,47L974,47L973,47L973,46L973,45L974,44L974,44ZM975,42L973,43L975,42ZM974,128L974,129L974,128ZM962,124L963,119L964,120L964,121ZM857,134L856,134L851,135L851,136L854,132L856,129L857,128L857,132ZM854,132L852,133L852,132L853,130L855,129ZM887,94L886,94L886,94L887,92L888,91L889,90L888,92ZM742,12L740,12L739,11L743,9L744,9L744,9L744,11L744,12ZM110,41L110,42L109,39L107,36L109,39L111,41ZM95,10L95,8L96,7L96,7Z',
      lakes: 'M720,232L721,232L724,237L731,235L740,229L747,220L752,218L762,219L765,214L772,211L783,209L782,203L786,209L775,223L770,227L766,230L758,235L745,246L733,250L724,250L726,248L716,244L716,244ZM784,206L784,206L784,206ZM729,242L729,242L729,242ZM483,24L483,24L483,24ZM501,50L501,50L501,50ZM484,-6L485,-4L491,10L496,27L500,38L506,48L504,51L506,61L506,61L502,59L502,65L497,65L497,51L501,45L496,47L500,41L495,38L493,43L492,34L489,28L486,28L482,33L479,25L471,15L470,11L475,9L469,8L465,5L469,-6L484,-6ZM828,163L821,173L825,174L825,184L815,193L804,195L795,194L782,199L779,201L770,200L773,193L779,187L800,179L808,181L815,172L827,163ZM815,173L815,173L815,173ZM822,175L822,175L822,175ZM822,170L822,170L822,170ZM824,168L824,168L824,168ZM454,-6L452,-5L457,4L462,2L464,6L464,6L461,8L455,7L443,-2L451,-4L450,-6L454,-6ZM245,252L238,258L231,241L231,236L235,236L239,246L240,242ZM242,255L242,255L242,255ZM684,157L680,162L683,166L677,169L675,180L673,180L673,172L663,184L664,190L661,198L661,208L668,224L668,235L661,250L657,253L650,252L649,251L644,239L643,234L640,219L646,185L642,183L637,190L636,187L641,178L642,176L650,158L650,162L656,158L655,164L660,157L669,155L672,152L678,152L684,156ZM673,159L673,159L673,159ZM666,174L666,174L666,174ZM652,169L652,169L652,169ZM650,172L645,181L647,183ZM688,140L688,141L678,142L678,137L661,140L653,146L643,145L635,138L629,137L625,140L622,131L611,140L606,141L597,147L595,148L587,147L590,141L587,140L579,144L570,145L588,126L606,116L607,115L610,112L611,105L617,102L625,101L627,97L624,93L628,92L640,96L652,95L659,108L663,111L677,110L675,117L682,123L681,131L687,133L684,135L686,142ZM590,139L590,139L590,139ZM592,142L592,142L592,142ZM593,140L593,140L593,140ZM595,137L595,137L595,137ZM628,95L628,95L628,95ZM616,116L622,111L612,117ZM634,126L633,125L625,128L622,132L625,136ZM633,97L633,97L633,97ZM666,116L666,116L666,116ZM688,140L697,144L710,145L720,144L744,145L753,156L758,157L758,162L766,168L759,169L761,175L747,171L740,167L739,162L733,163L739,168L742,176L736,189L739,202L737,207L729,214L722,196L717,192L711,196L707,203L703,201L703,196L707,193L710,186L710,179L706,166L695,162L684,157L684,156L685,152L696,152L691,147L688,141ZM705,150L705,150L705,150ZM702,150L702,150L702,150ZM697,148L697,148L697,148ZM693,145L693,145L693,145ZM692,144L692,144L692,144ZM689,156L689,156L689,156ZM712,153L727,157L730,152L727,148ZM732,157L732,157L732,157ZM758,169L758,169L758,169ZM529,100L525,97L521,99L522,93L530,83L523,86L522,83L531,81L530,75L534,84L537,85L529,88L533,92L538,93ZM529,92L529,92L529,92ZM626,71L624,72L625,82L621,84L614,81L613,70L617,65L624,67ZM618,70L618,70L618,70ZM621,78L621,78L621,78Z',
      towns: [['Seattle', 118, 73, 2], ['Portland', 100, 116, 3], ['Boise', 189, 182, 1], ['Helena', 265, 129, 2], ['San Francisco', 56, 284, 0], ['Los Angeles', 107, 383, 3], ['Las Vegas', 172, 349, 2], ['Phoenix', 215, 419, 3], ['Salt Lake', 246, 258, 2], ['Denver', 358, 296, 2], ['Albuquerque', 318, 397, 2], ['El Paso', 313, 471, 3], ['Dallas', 495, 459, 3], ['Houston', 522, 526, 3], ['Okla. City', 483, 399, 3], ['Kansas City', 534, 317, 2], ['Omaha', 511, 269, 9], ['Fargo', 498, 143, 2], ['Minneapolis', 553, 185, 3], ['Chicago', 647, 249, 1], ['St. Louis', 610, 325, 0], ['Memphis', 617, 403, 3], ['New Orleans', 624, 519, 2], ['Nashville', 674, 375, 1], ['Atlanta', 723, 424, 3], ['Miami', 828, 589, 3], ['Tampa', 776, 548, 1], ['Charlotte', 782, 382, 2], ['Washington', 833, 289, 3], ['New York', 874, 239, 3], ['Boston', 913, 191, 2], ['Pittsburgh', 777, 265, 7], ['Detroit', 721, 230, 2], ['Billings', 317, 155, 3], ['Bismarck', 437, 143, 3], ['Rapid City', 395, 201, 3], ['Wichita', 487, 349, 5], ['Amarillo', 405, 401, 2], ['Jacksonville', 784, 493, 0], ['Buffalo', 786, 207, 2]],
      routes: [[0,1,1,'o',0,-1], [14,36,1,'x',0,-1], [15,16,2,'b',0,-1], [26,38,2,'x',0,-1], [15,36,2,'y',0,90], [3,33,2,'p',0,-1], [31,39,2,'g',0,-1], [28,31,2,'r',0,-1], [17,34,2,'x',0,-1], [12,14,2,'w',0,-1], [29,30,2,'x',0,-1], [21,23,2,'p',0,-1], [28,29,2,'r',0,-1], [25,26,2,'g',0,-1], [17,18,2,'o',0,91], [23,24,2,'k',0,-1], [34,35,2,'r',0,-1], [12,13,2,'g',0,-1], [24,27,2,'x',0,-1], [5,6,2,'b',0,-1], [10,11,2,'p',0,-1], [19,32,2,'y',0,89], [15,20,2,'x',0,-1], [14,37,2,'x',0,-1], [20,21,2,'b',0,-1], [20,23,2,'y',0,-1], [6,7,2,'x',0,-1], [16,36,2,'y',0,-1], [19,20,2,'p',0,-1], [10,37,2,'g',0,86], [33,35,3,'b',0,-1], [24,38,3,'w',0,88], [2,3,3,'k',0,-1], [29,39,3,'g',0,-1], [16,18,3,'x',0,-1], [28,39,3,'x',0,-1], [2,8,3,'b',0,-1], [36,37,3,'p',0,-1], [9,35,3,'w',0,-1], [13,22,3,'r',0,-1], [7,10,3,'x',0,-1], [25,38,3,'k',0,-1], [27,28,3,'x',0,-1], [12,37,3,'o',0,-1], [21,24,3,'o',0,-1], [23,27,3,'y',0,-1], [9,10,3,'k',0,-1], [1,2,3,'p',0,-1], [7,11,3,'w',0,-1], [27,38,3,'p',0,-1], [4,5,3,'y',0,-1], [18,19,3,'y',0,-1], [5,7,3,'x',0,-1], [9,37,3,'x',0,-1], [11,37,3,'x',0,-1], [21,22,3,'y',0,-1], [27,31,3,'o',0,-1], [6,8,3,'o',0,-1], [8,9,3,'r',0,-1], [15,21,3,'p',0,-1], [33,34,3,'k',0,87], [8,33,4,'w',0,-1], [16,17,4,'k',0,-1], [30,39,4,'x',0,-1], [19,23,4,'x',0,-1], [3,8,4,'r',0,-1], [15,19,4,'g',0,-1], [4,6,4,'x',0,-1], [14,21,4,'o',0,85], [16,35,4,'b',0,-1], [22,24,4,'x',0,-1], [9,36,4,'k',0,-1], [12,22,4,'g',0,-1], [16,34,4,'x',0,-1], [9,33,4,'x',0,-1], [23,31,4,'b',0,-1], [6,10,4,'x',0,-1], [8,10,4,'x',0,-1], [0,3,4,'x',0,-1], [2,4,5,'x',0,-1], [2,6,5,'w',0,-1], [1,4,5,'o',0,-1], [35,36,5,'w',0,-1], [11,12,5,'r',0,-1], [31,32,2,'b',0,-1], [14,21,4,'p',0,68], [10,37,2,'y',0,29], [33,34,3,'y',0,60], [24,38,3,'g',0,31], [19,32,2,'g',0,21], [15,36,2,'k',0,4], [17,18,2,'r',0,14]],
      tickets: [[8,10,4], [0,33,6], [24,31,5], [20,27,5], [6,37,6], [11,12,5], [14,21,4], [17,19,5], [28,30,4], [9,34,5], [13,16,7], [5,36,11], [15,26,11], [1,35,10], [25,39,11], [22,38,7], [23,29,8], [3,7,9], [2,10,7], [18,21,7], [4,8,7], [5,32,19], [0,13,18], [6,26,20], [30,35,19], [28,33,16], [9,31,14], [16,39,12], [4,34,13], [15,29,12]] },
    midwest: { name: 'The Midwest', w: 1000, h: 784, minY: 0, trains: 35, fs: 22,
      land: 'M683,443L695,447L710,439L788,433L788,437L794,509L799,571L796,574L800,587L787,593L775,593L777,602L767,615L761,617L758,630L744,629L741,624L734,631L735,637L723,634L710,646L699,638L690,637L676,642L673,647L670,642L679,622L692,597L691,586L685,575L689,565ZM111,513L378,534L383,539L395,543L386,558L396,575L405,580L401,690L170,676L94,668ZM331,63L402,67L403,47L414,52L419,81L433,86L447,88L448,94L459,92L463,88L476,88L492,98L497,110L501,103L520,111L525,119L536,117L548,108L553,116L575,115L584,121L594,120L581,129L561,136L541,152L528,167L507,184L509,189L499,191L499,221L484,231L478,247L486,254L482,262L480,289L490,300L498,301L501,306L513,312L514,318L531,329L537,337L539,355L342,351L347,257L339,251L333,241L344,230L345,224L345,204L339,186L339,137L331,109L332,87L334,80ZM98,40L331,63L334,80L332,87L331,109L339,137L339,186L345,204L345,224L76,197ZM69,246L76,197L345,224L344,230L333,241L339,251L347,257L342,351L338,365L339,374L334,391L340,403L334,402L331,394L308,381L288,380L281,385L264,372L146,361L55,349ZM362,503L408,505L457,506L520,504L533,517L529,524L530,534L535,550L561,576L564,591L571,590L586,595L584,608L576,622L577,628L592,641L612,655L616,670L612,676L622,691L629,691L628,707L618,717L615,717L613,717L613,728L605,743L578,744L590,729L587,717L400,716L401,690L405,580L396,575L386,558L395,543L383,539L378,534L372,521L367,517ZM533,517L535,505L544,501L550,488L551,479L544,472L547,463L562,460L574,453L580,442L580,426L572,421L562,406L670,403L669,413L676,425L683,443L689,565L685,575L691,586L692,597L679,622L670,642L673,647L668,654L671,664L655,669L657,685L637,678L631,681L629,691L622,691L612,676L616,670L612,655L592,641L577,628L576,622L584,608L586,595L571,590L564,591L561,576L535,550L530,534L529,524ZM342,351L539,355L540,363L545,368L541,374L546,394L559,399L562,406L572,421L580,426L580,442L574,453L562,460L547,463L544,472L551,479L550,488L544,501L535,505L533,517L520,504L457,506L408,505L362,503L357,495L361,486L357,466L357,457L351,453L353,439L345,426L340,403L334,391L339,374L338,365ZM775,221L786,225L781,227ZM749,227L749,227L749,227ZM744,225L744,225L744,225ZM741,237L743,229L746,236ZM738,231L738,231L738,231ZM732,246L732,246L732,246ZM727,262L727,262L727,262ZM724,269L724,269L724,269ZM703,239L703,239L703,239ZM710,439L717,432L729,402L730,388L728,373L714,340L718,333L714,320L722,304L721,286L728,283L728,276L737,271L743,259L745,280L752,271L752,254L768,246L760,237L771,225L783,231L792,231L799,238L819,243L829,260L824,264L831,276L831,295L824,301L823,311L814,315L811,328L822,335L835,314L848,307L859,318L867,349L872,360L871,381L859,381L858,394L852,398L848,415L840,430L788,437L788,433ZM606,126L626,112L634,109L626,118L610,128ZM566,195L580,189L588,182L601,180L631,158L644,146L658,145L661,149L643,160L636,172L636,183L643,174L664,178L675,193L689,193L691,196L704,195L719,183L742,181L761,175L759,190L775,192L787,185L795,207L803,212L804,206L813,206L814,215L794,213L785,216L774,211L769,221L762,214L743,211L738,218L730,222L719,220L714,229L701,237L708,227L698,227L693,236L690,228L671,268L665,263L669,255L661,256L661,256L663,238L650,231L651,226L636,222L626,222L615,216L577,207L569,197L569,197ZM868,434L868,434L868,434ZM864,432L864,432L864,432ZM788,437L840,430L861,439L864,435L879,444L897,435L907,435L917,424L933,413L951,404L960,473L955,477L959,490L955,503L954,522L941,541L931,541L921,554L917,571L911,563L905,576L908,585L902,595L892,597L881,589L878,581L862,591L853,587L847,591L839,586L824,584L814,569L799,571L794,509ZM694,253L694,253L694,253ZM679,262L679,262L679,262ZM564,173L564,173L564,173ZM562,179L562,179L562,179ZM558,177L558,177L558,177ZM554,181L554,181L554,181ZM555,175L555,175L555,175ZM553,172L553,172L553,172ZM553,184L553,184L553,184ZM546,174L546,174L546,174ZM509,189L527,186L546,176L554,179L547,194L555,189L566,195L569,197L569,197L577,207L615,216L626,222L636,222L651,226L650,231L663,238L661,256L661,256L669,255L665,263L671,268L658,288L659,298L666,292L671,281L679,278L684,264L690,257L691,267L686,274L677,296L676,315L672,319L669,331L671,342L664,365L670,403L562,406L559,399L546,394L541,374L545,368L540,363L539,355L537,337L531,329L514,318L513,312L501,306L498,301L490,300L480,289L482,262L486,254L478,247L484,231L499,221L499,191ZM55,349L146,361L264,372L281,385L288,380L308,381L331,394L334,402L340,403L345,426L353,439L351,453L357,457L357,466L361,486L357,495L362,503L367,517L372,521L378,534L111,513L118,461L40,451Z',
      near: 'M-6,443L40,451L118,461L111,513L94,668L54,663L-6,654L-6,443ZM784,790L783,787L783,787L838,782L889,777L881,788L881,790L784,790ZM1006,772L989,774L989,768L976,759L923,762L889,777L838,782L838,770L849,765L849,759L858,750L870,749L880,739L890,736L904,719L905,724L920,712L928,713L939,697L940,688L940,688L998,682L1006,681L1006,772ZM167,790L176,702L51,688L54,663L54,663L94,668L170,676L401,690L400,716L406,774L406,790L167,790ZM1006,514L966,520L960,473L951,404L951,404L977,385L980,399L1006,395L1006,514ZM36,790L49,688L51,688L51,688L176,702L167,790L36,790ZM-6,232L69,246L69,246L55,349L40,451L-6,443L-6,232ZM1006,587L1001,596L999,606L990,623L991,633L982,635L967,647L955,652L948,647L936,656L925,649L922,640L908,635L891,612L892,597L892,597L902,595L908,585L905,576L911,563L917,571L921,554L931,541L941,541L954,522L955,503L959,490L955,477L960,473L966,520L1006,514L1006,587ZM-6,654L54,663L51,688L49,688L36,790L-6,790ZM406,790L406,774L400,716L400,716L587,717L590,729L578,744L605,743L609,749L596,757L601,762L588,773L592,788L590,790L406,790ZM629,691L631,681L637,678L657,685L655,669L671,664L668,654L673,647L676,642L690,637L699,638L710,646L723,634L735,637L734,631L741,624L744,629L758,630L761,617L767,615L777,602L775,593L787,593L800,587L796,574L799,571L814,569L824,584L839,586L847,591L853,587L862,591L878,581L881,589L892,597L891,612L908,635L922,640L908,656L894,665L889,678L879,686L857,696L857,697L782,702L736,703L683,707L674,705L675,714L618,717L628,707ZM615,717L613,717L615,717ZM-6,17L98,40L76,197L69,246L-6,232L-6,17ZM1006,351L1000,344L996,330L1006,326L1006,351ZM1006,395L980,399L977,385L977,385L999,367L1006,356L1006,395ZM590,790L592,788L588,773L601,762L596,757L609,749L605,743L605,743L613,728L613,717L615,717L618,717L675,714L674,705L683,707L736,703L782,702L857,697L857,696L940,688L939,697L928,713L920,712L905,724L904,719L890,736L880,739L870,749L858,750L849,759L849,765L838,770L838,782L783,787L718,790L590,790ZM1006,681L998,682L940,688L857,696L879,686L889,678L894,665L908,656L922,640L922,640L925,649L936,656L948,647L955,652L967,647L982,635L991,633L990,623L999,606L1001,596L1006,587L1006,681ZM881,790L881,788L889,777L889,777L923,762L976,759L989,768L989,774L1006,772L1006,790ZM1006,310L1006,310L991,321L996,330L997,338L1004,346L1001,354L958,383L920,396L879,429L869,430L855,423L850,416L849,408L851,399L859,394L866,384L870,380L872,360L872,357L879,330L854,240L814,220L817,210L809,204L798,207L793,197L788,184L776,190L767,181L763,168L677,124L635,103L627,105L605,119L588,119L580,120L576,114L554,115L550,110L543,111L531,118L527,118L504,104L495,107L493,98L475,89L462,89L451,93L439,86L420,81L417,75L414,67L412,54L410,49L402,48L402,68L335,64L320,63L189,52L103,41L88,39L-6,22L-6,-6L1006,-6Z',
      lakes: 'M1001,344L1001,344L1001,344ZM871,426L871,426L871,426ZM1006,354L996,367L980,383L966,393L957,400L938,410L917,425L908,434L898,435L879,443L873,440L857,442L870,438L862,438L840,430L840,428L849,413L850,400L850,400L851,401L851,411L858,414L871,411L875,416L876,409L881,404L891,397L897,396L902,386L913,375L927,371L949,373L963,373L949,371L956,362L973,355L1000,351L1004,348L997,338L1004,339L1006,349L1006,354ZM1006,325L997,329L991,332L987,335L972,335L969,331L978,314L984,310L992,301L1006,295L1006,325ZM851,401L850,400L858,394L860,379L864,377L866,384L876,388L876,393L870,396L859,397ZM772,225L765,228L761,235L762,243L767,245L754,251L751,255L752,266L749,276L747,268L743,277L745,258L735,271L727,276L726,283L721,286L722,299L719,310L714,318L718,333L714,341L724,362L729,378L729,392L728,404L719,427L711,437L701,444L688,446L683,443L682,440L675,424L672,421L670,411L670,400L670,387L665,376L664,364L671,338L669,333L671,322L676,316L677,298L681,287L678,279L671,281L667,289L660,296L657,290L663,276L671,269L671,265L678,254L683,241L688,234L691,224L692,234L695,234L699,227L707,225L703,232L704,239L717,221L728,221L737,217L745,211L758,213L771,221ZM745,229L742,237L745,236ZM727,261L727,261L727,261ZM695,250L695,250L695,250ZM691,256L683,265L678,276L682,281L691,266ZM783,185L783,187L777,191L771,189L759,189L759,177L754,175L744,180L719,182L701,196L687,192L676,193L665,178L660,175L644,173L635,179L635,170L628,159L618,169L611,172L604,178L592,180L569,193L564,194L555,189L548,193L554,178L547,176L538,179L528,185L510,189L506,186L508,182L531,162L550,142L559,137L580,129L593,120L596,119L603,112L607,96L621,89L618,102L623,99L629,84L629,78L634,74L636,81L628,91L629,96L633,89L640,87L644,78L638,68L646,66L674,76L688,76L692,73L701,75L708,86L712,99L718,108L727,115L738,116L759,113L755,130L758,135L771,145L766,162L772,166L781,167L774,172L775,178L779,176L775,184L778,188ZM554,175L554,175L554,175ZM558,182L558,182L558,182ZM562,177L562,177L562,177ZM566,170L566,170L566,170ZM645,74L646,81L654,78L654,73ZM618,123L627,117L632,110L623,113L607,124L609,128ZM658,148L655,144L647,146L637,150L630,160L636,164L636,170L643,159L652,151ZM658,78L658,78L658,78ZM733,126L728,123L725,128ZM783,185L791,184L792,192L802,196L832,199L856,196L862,198L886,198L884,204L889,202L902,203L913,202L927,219L929,216L933,227L945,229L943,234L947,237L945,241L955,249L962,257L956,257L950,254L946,257L951,264L951,271L944,273L930,268L927,264L917,270L917,261L909,263L910,256L903,251L900,240L885,242L899,254L904,263L904,273L897,285L891,303L896,333L892,344L881,355L872,360L870,356L858,317L853,311L846,308L831,317L829,327L822,334L811,328L812,316L822,311L825,299L831,293L831,277L828,268L824,263L824,258L829,259L823,246L816,243L798,238L791,231L779,229L772,225L771,221L773,212L799,214L801,210L796,205L788,202L789,197L783,187ZM822,210L817,215L823,216ZM815,209L809,205L804,213L813,213ZM803,203L803,198L793,197L798,206ZM793,197L793,197L793,197ZM792,195L791,185L786,187ZM784,223L784,223L784,223ZM836,216L860,222L871,227L878,219L877,227L881,224L886,213L881,208L878,217L873,206L866,211L860,207L850,211L852,217L843,214L840,208L827,214ZM883,227L883,227L883,227ZM944,257L944,257L944,257ZM417,75L407,69L397,73L396,68L401,58L408,57L407,48L420,35L415,36L404,43L403,35L414,35L414,32L422,30L420,18L422,16L427,29L432,32L429,39L436,42L441,50L439,56L433,43L426,43L417,46L426,56L430,54L439,60L430,64ZM418,57L417,63L423,66L426,59ZM644,16L640,19L641,29L640,42L631,46L627,38L625,45L619,41L625,33L620,34L616,40L613,25L614,13L618,3L622,0L639,7ZM626,13L623,12L620,21ZM632,33L632,33L632,33ZM924,183L934,182L937,177L951,175L960,180L955,184L948,183L940,186L939,183L929,185ZM974,279L973,283L968,275L975,261L983,270L983,274ZM462,89L461,77L465,72L469,82L468,86L483,86L480,88L487,90L495,101L478,99L474,94L483,97L486,94L473,90ZM-6,87L2,85L3,80L10,78L13,89L13,101L8,85L3,91L-6,91L-6,87ZM101,91L109,86L112,91L128,87L136,90L142,95L141,107L148,109L147,102L151,104L154,120L163,124L187,122L190,125L180,129L174,128L161,129L151,121L144,122L149,117L149,112L141,110L140,96L131,91L126,90L112,94L108,89Z',
      towns: [['Minneapolis', 463, 278, 2], ['Duluth', 506, 184, 3], ['Fargo', 340, 175, 3], ['Bismarck', 198, 167, 3], ['Rapid City', 93, 297, 3], ['Sioux Falls', 332, 347, 3], ['Omaha', 356, 467, 2], ['North Platte', 168, 461, 3], ['Des Moines', 447, 453, 3], ['Kansas City', 406, 581, 3], ['Wichita', 290, 649, 3], ['Dodge City', 181, 638, 2], ['St. Louis', 583, 607, 3], ['Springfield MO', 456, 681, 3], ['Chicago', 678, 435, 3], ['Milwaukee', 665, 375, 2], ['Madison', 608, 376, 3], ['Green Bay', 657, 299, 2], ['Marquette', 674, 192, 3], ['La Crosse', 538, 339, 2], ['Springfield IL', 604, 545, 3], ['Indianapolis', 742, 540, 2], ['Fort Wayne', 778, 470, 2], ['Detroit', 852, 398, 2], ['Grand Rapids', 750, 374, 3], ['Traverse City', 745, 281, 0], ['Sault Ste. Marie', 783, 187, 2], ['Cleveland', 909, 434, 3], ['Columbus', 867, 520, 0], ['Cincinnati', 811, 570, 0], ['Louisville', 764, 618, 3]],
      routes: [[15,16,1,'x',0,-1], [12,20,2,'y',0,63], [29,30,2,'y',0,-1], [28,29,2,'r',0,-1], [21,29,2,'x',0,-1], [15,17,2,'g',0,-1], [21,22,2,'x',0,-1], [16,19,2,'y',0,-1], [21,30,2,'r',0,-1], [16,17,2,'p',0,-1], [14,16,2,'b',0,61], [6,8,2,'o',0,65], [24,25,2,'p',0,-1], [27,28,2,'w',0,-1], [0,19,2,'g',0,64], [22,24,2,'b',0,62], [22,28,2,'y',0,-1], [22,23,2,'r',0,-1], [0,1,2,'x',0,-1], [23,24,3,'x',0,-1], [22,29,3,'r',0,-1], [14,22,3,'g',0,-1], [17,18,3,'k',0,-1], [10,11,3,'p',0,-1], [9,13,3,'b',0,-1], [5,6,3,'x',0,-1], [23,28,3,'p',0,-1], [14,21,3,'r',0,-1], [6,9,3,'r',0,-1], [17,19,3,'w',0,-1], [14,20,3,'k',0,-1], [8,9,3,'y',0,-1], [9,10,3,'o',0,66], [20,21,3,'b',0,-1], [2,3,3,'b',0,67], [8,19,4,'k',0,-1], [12,13,4,'x',0,-1], [0,5,4,'k',0,-1], [5,8,4,'w',0,-1], [1,19,4,'w',0,-1], [23,25,4,'x',0,-1], [0,2,4,'w',0,-1], [1,2,4,'x',0,-1], [3,4,4,'o',0,-1], [16,20,4,'x',0,-1], [10,13,4,'x',0,-1], [2,5,4,'x',0,-1], [0,8,4,'p',0,-1], [20,30,4,'x',0,-1], [7,11,4,'x',0,-1], [8,16,4,'x',0,-1], [9,12,4,'x',0,-1], [4,7,4,'x',0,-1], [6,7,5,'o',0,-1], [1,17,5,'b',0,-1], [6,10,5,'g',0,-1], [5,7,5,'x',0,-1], [23,26,5,'x',0,-1], [1,18,4,'g',0,-1], [25,26,2,'x',0,-1], [23,27,2,'y',-50,-1], [14,16,2,'g',0,10], [22,24,2,'r',0,15], [12,20,2,'g',0,1], [0,19,2,'o',0,14], [6,8,2,'p',0,11], [9,10,3,'y',0,32], [2,3,3,'k',0,34]],
      tickets: [[8,16,4], [22,30,4], [1,5,6], [21,27,6], [0,2,4], [24,29,5], [12,13,4], [14,23,5], [18,19,6], [6,10,5], [15,28,8], [20,26,11], [4,11,8], [7,9,8], [17,25,11], [0,3,7], [3,18,11], [16,27,9], [19,23,9], [8,11,9], [12,15,7], [5,28,15], [7,25,20], [4,22,20], [1,26,17], [10,21,12], [9,24,13], [2,13,13], [6,29,13], [3,17,12]] },
    california: { name: 'California', w: 860, h: 989, minY: 0, trains: 33, fs: 22,
      land: 'M468,861L487,868L491,878L479,876L477,867ZM468,904L489,924L478,922ZM432,860L432,860L432,860ZM402,809L402,809L402,809ZM390,881L402,885L393,885ZM364,804L377,806L392,812L379,816L367,814ZM338,811L354,808L359,817L348,822ZM322,808L328,804L333,809ZM62,40L101,42L138,42L145,43L183,44L288,48L361,49L361,49L361,168L361,232L359,313L360,335L445,410L523,480L558,512L646,590L714,650L777,706L777,718L784,728L791,733L803,758L816,767L820,775L797,793L797,798L790,808L794,830L792,831L790,846L783,858L777,859L778,868L782,872L780,889L785,894L796,894L801,905L797,920L781,924L662,940L588,949L587,941L582,935L578,937L577,917L571,894L556,874L546,865L539,862L533,854L522,848L509,837L502,834L495,839L483,836L485,826L477,812L473,808L456,808L452,811L419,798L414,786L392,772L379,774L367,773L357,768L346,766L320,769L316,761L307,756L311,744L308,739L310,729L305,725L308,704L298,700L288,692L291,681L287,673L280,671L268,655L261,652L255,640L245,630L242,619L237,617L226,600L214,591L210,573L210,558L215,561L220,554L222,542L217,530L211,525L198,527L191,521L176,503L177,488L174,476L169,472L171,458L170,447L178,445L181,466L188,468L201,480L195,458L189,450L183,448L186,442L177,430L189,423L187,417L180,413L172,416L171,424L175,428L171,433L173,443L169,444L159,435L156,436L147,426L139,422L133,425L138,411L137,402L126,382L111,370L102,356L88,342L82,332L86,322L79,302L78,293L83,274L78,248L64,229L60,221L55,218L43,205L43,194L40,188L47,172L59,150L64,133L62,122L66,114L70,94L69,84L64,65L58,60L61,55Z',
      near: 'M866,974L775,946L775,935L781,924L781,924L797,920L801,905L796,894L785,894L780,889L782,872L778,868L777,859L783,858L790,846L792,831L794,830L790,808L797,798L797,793L820,775L816,767L803,758L791,733L784,728L777,718L777,706L781,693L778,673L772,664L772,648L769,645L767,630L770,623L764,613L762,603L776,597L792,597L802,608L809,607L816,590L811,514L866,510L866,974ZM571,-6L573,46L454,49L361,49L361,49L361,49L288,48L183,44L145,43L138,42L101,42L62,40L53,31L49,15L48,-3L49,-6L571,-6ZM866,510L811,514L804,380L803,354L795,218L790,132L785,38L785,38L800,37L866,32L866,510ZM866,32L800,37L785,38L620,45L573,46L571,-6L866,-6ZM361,49L361,49L454,49L573,46L620,45L785,38L790,132L795,218L803,354L804,380L811,514L816,590L809,607L802,608L792,597L776,597L762,603L764,613L770,623L767,630L769,645L772,648L772,664L778,673L781,693L777,706L714,650L646,590L558,512L523,480L445,410L360,335L359,313L361,232L361,168ZM610,995L607,981L597,971L588,950L588,950L611,947L634,944L657,941L726,933L749,929L781,925L777,939L772,945L812,957L851,969L866,974L866,995Z',
      lakes: 'M866,93L865,92L860,71L866,68L866,93ZM364,332L363,339L358,340L354,338L350,321L356,313L365,310L366,315ZM707,875L708,880L701,888L694,888L684,873L671,861L671,854L680,852L685,859L703,870ZM850,623L847,622L837,607L828,601L821,593L818,593L812,606L805,609L799,607L792,600L786,603L782,601L771,601L763,611L758,605L758,600L780,592L786,588L789,564L792,561L793,568L791,591L804,605L809,602L817,585L820,585L831,597L838,603L851,620ZM338,49L333,68L329,69L327,61L328,42L333,38L337,42ZM402,249L398,251L387,236L383,225L391,219L395,222L398,242Z',
      towns: [['San Diego', 585, 932, 3], ['Los Angeles', 496, 806, 2], ['Riverside', 563, 815, 7], ['Palm Springs', 631, 824, 3], ['El Centro', 713, 921, 3], ['Barstow', 591, 723, 3], ['Needles', 780, 721, 3], ['Las Vegas', 732, 597, 2], ['Death Valley', 598, 574, 3], ['Bakersfield', 434, 681, 2], ['Santa Barbara', 381, 772, 3], ['San Luis Obispo', 306, 689, 3], ['Fresno', 375, 550, 3], ['Monterey', 214, 561, 3], ['San Jose', 216, 491, 3], ['San Francisco', 177, 449, 3], ['Santa Rosa', 157, 384, 7], ['Sacramento', 248, 373, 2], ['Stockton', 262, 433, 2], ['Yosemite', 390, 454, 3], ['Lake Tahoe', 361, 340, 3], ['Reno', 374, 284, 3], ['Chico', 225, 263, 3], ['Redding', 187, 180, 3], ['Eureka', 60, 155, 3], ['Ukiah', 122, 315, 3], ['Susanville', 313, 199, 3]],
      routes: [[17,18,1,'w',0,-1], [1,2,2,'r',0,55], [15,16,2,'w',0,-1], [2,3,2,'x',0,-1], [14,18,2,'b',0,-1], [16,25,2,'x',0,-1], [15,18,2,'k',0,-1], [22,23,2,'p',0,-1], [16,17,2,'x',0,-1], [2,5,2,'k',0,-1], [12,19,2,'x',0,-1], [15,17,2,'w',0,-1], [21,26,2,'w',0,-1], [9,10,2,'g',0,-1], [3,5,3,'k',0,56], [22,26,3,'x',0,-1], [10,11,3,'y',0,-1], [17,22,3,'b',0,54], [22,25,3,'x',0,-1], [0,3,3,'r',0,-1], [19,20,3,'g',0,-1], [17,20,3,'y',0,-1], [0,2,3,'k',0,-1], [1,10,3,'r',0,-1], [1,5,3,'k',0,-1], [3,4,3,'x',0,-1], [23,26,3,'p',0,-1], [9,11,3,'w',0,-1], [0,4,3,'o',0,-1], [23,24,3,'w',0,-1], [18,19,3,'b',0,57], [6,7,3,'x',0,-1], [18,20,3,'x',0,-1], [7,8,3,'o',0,59], [17,25,3,'x',0,-1], [1,9,3,'x',0,-1], [9,12,3,'p',0,53], [5,8,4,'b',0,-1], [23,25,4,'o',0,-1], [21,22,4,'g',0,-1], [11,12,4,'o',0,-1], [11,13,4,'w',0,-1], [12,13,4,'y',0,-1], [5,9,4,'g',0,-1], [12,18,4,'x',0,-1], [12,14,4,'x',0,-1], [24,25,4,'r',0,58], [3,6,4,'k',0,-1], [5,6,4,'p',0,-1], [8,9,5,'x',0,-1], [4,6,5,'x',0,-1], [6,8,6,'r',0,-1], [8,19,6,'y',0,-1], [9,12,3,'g',0,36], [17,22,3,'o',0,17], [1,2,2,'o',0,1], [3,5,3,'b',0,14], [18,19,3,'y',0,30], [24,25,4,'p',0,46], [7,8,3,'b',0,33]],
      tickets: [[17,19,4], [12,20,5], [16,24,6], [2,4,5], [23,25,4], [5,10,6], [14,22,6], [8,9,5], [1,11,6], [3,6,4], [15,21,9], [0,7,10], [18,26,7], [9,13,7], [19,23,9], [15,26,8], [6,10,10], [11,17,9], [5,12,7], [20,24,10], [1,4,7], [0,13,15], [2,21,20], [3,18,14], [7,22,16], [8,25,13], [4,14,17], [10,16,12], [6,15,17], [8,21,17]] },
    storybook: { name: 'Storybook Lands', w: 1000, h: 712, minY: -12, trains: 35, fs: 25,
      land: '',
      near: '',
      lakes: '',
      towns: [['Frostport', 90, 80, 3], ['Pinewick', 270, 60, 3], ['Harrowgate', 460, 90, 3], ['Northmere', 650, 60, 3], ['Icehaven', 860, 90, 3], ['Saltmarsh', 70, 240, 6], ['Elderford', 230, 210, 3], ['Copperhill', 390, 230, 3], ['Kingsbridge', 560, 215, 3], ['Thornbury', 720, 200, 3], ['Eastwatch', 900, 240, 3], ['Gullhaven', 150, 370, 3], ['Millbrook', 300, 350, 3], ['Crossroads', 470, 370, 3], ['Larkspur', 640, 350, 3], ['Ravenrock', 800, 355, 3], ['Sunreach', 950, 390, 7], ['Driftwood', 70, 500, 4], ['Amberfield', 230, 505, 3], ['Stonehollow', 400, 500, 3], ['Willowmere', 570, 500, 3], ['Ironvale', 740, 495, 3], ['Brightwater', 900, 520, 3], ['Coralbay', 160, 630, 3], ['Dunmore', 340, 640, 2], ['Southgate', 520, 640, 3], ['Marrowdale', 700, 635, 2], ['Cinderpeak', 870, 640, 3]],
      routes: [[0,1,4,'x',0,-1], [1,2,4,'k',0,-1], [2,3,4,'b',0,-1], [3,4,4,'b',0,-1], [5,6,3,'r',0,-1], [6,7,3,'y',0,-1], [7,8,3,'r',0,7], [7,8,3,'b',0,6], [8,9,3,'x',0,-1], [9,10,4,'o',0,-1], [11,12,2,'x',0,-1], [12,13,3,'w',0,12], [12,13,3,'g',0,11], [13,14,3,'b',0,14], [13,14,3,'o',0,13], [14,15,3,'p',0,-1], [15,16,2,'o',0,-1], [17,18,3,'x',0,-1], [18,19,3,'y',0,-1], [19,20,3,'w',0,20], [19,20,3,'b',0,19], [20,21,3,'x',0,-1], [21,22,3,'w',0,-1], [23,24,4,'k',0,-1], [24,25,4,'y',0,-1], [25,26,4,'w',0,-1], [26,27,3,'g',0,-1], [0,5,3,'k',0,-1], [0,6,4,'b',0,-1], [1,6,2,'x',0,-1], [1,7,4,'r',0,-1], [2,7,2,'x',0,-1], [2,8,3,'y',0,33], [2,8,3,'r',0,32], [3,8,3,'k',0,-1], [3,9,2,'x',0,-1], [4,9,3,'w',0,-1], [4,10,2,'x',0,-1], [5,11,2,'x',0,-1], [6,11,3,'p',0,-1], [6,12,2,'p',0,-1], [7,12,2,'x',0,-1], [7,13,3,'x',0,-1], [8,13,4,'o',0,44], [8,13,4,'g',0,43], [8,14,2,'w',0,-1], [9,14,3,'p',0,-1], [9,15,3,'o',0,-1], [10,15,2,'x',0,-1], [10,16,2,'p',0,-1], [11,17,2,'k',0,-1], [11,18,2,'x',0,-1], [12,18,3,'x',0,-1], [12,19,4,'r',0,-1], [13,19,1,'k',0,-1], [13,20,3,'y',0,-1], [14,20,3,'g',0,57], [14,20,3,'p',0,56], [14,21,3,'w',0,-1], [15,21,2,'y',0,-1], [15,22,4,'r',0,-1], [16,22,1,'w',0,-1], [17,23,2,'r',0,-1], [18,23,1,'w',0,-1], [18,24,3,'x',0,-1], [19,24,2,'o',0,-1], [19,25,4,'x',0,-1], [20,25,2,'g',0,-1], [20,26,4,'y',0,-1], [21,26,1,'x',0,-1], [21,27,4,'o',0,-1], [22,27,1,'x',0,-1], [0,17,6,'g',-50,-1], [4,16,5,'k',70,-1], [23,27,6,'x',-55,-1], [1,3,5,'p',50,-1]],
      tickets: [[0,17,6], [4,21,6], [11,24,5], [18,25,7], [20,27,7], [8,16,7], [10,14,5], [1,9,7], [5,7,6], [3,13,7], [23,26,9], [19,22,9], [12,15,9], [6,25,10], [2,26,9], [16,18,9], [11,21,11], [6,27,12], [13,22,9], [5,15,13], [4,24,12], [1,14,9], [0,10,15], [4,17,14], [0,27,14], [5,26,14], [0,15,14], [5,10,15], [1,27,14], [0,25,14]] }
  };
  var RR_MAP_ORDER = ['usa', 'midwest', 'california', 'storybook'];
  function rrMap(s) { return RR_MAPS[s && s.map] || RR_MAPS.storybook; }
  var RR_CARDS = 'roygbpkwA';                        // eight colors, then A for the any-color locomotive
  var RR_COLOR = { r: 'Red', o: 'Orange', y: 'Yellow', g: 'Green', b: 'Blue', p: 'Purple', k: 'Black', w: 'White', A: 'Locomotive', x: 'Any color' };
  var RR_PTS = [0, 1, 2, 4, 7, 10, 15];
  function rrL(str) { return str.slice(1).split(''); }
  function rrS(arr) { return '-' + arr.join(''); }
  function rrShuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function rrTid(i) { return i.toString(36); }
  function rrTix(str) { return rrL(str).map(function (c) { return parseInt(c, 36); }); }

  function rrDraw(s) {
    var deck = rrL(s.deck);
    if (!deck.length) { deck = rrShuffle(rrL(s.disc)); s.disc = '-'; }
    var c = deck.shift();
    s.deck = rrS(deck);
    return c || null;
  }
  /* Fill empty face-up slots. Three locomotives face up means the row is cleared and dealt again. */
  function rrRefill(s) {
    for (var tries = 0; tries < 4; tries++) {
      var up = s.up.split('');
      for (var i = 0; i < 5; i++) if (up[i] === '.') up[i] = rrDraw(s) || '.';
      s.up = up.join('');
      var wild = up.filter(function (c) { return c === 'A'; }).length;
      if (wild < 3 || tries === 3) return;
      if (rrL(s.deck).length + rrL(s.disc).length < 5) return;
      s.disc = rrS(rrL(s.disc).concat(up.filter(function (c) { return c !== '.'; })));
      s.up = '.....';
    }
  }
  function rrBlocked(s, r, seat) {
    var tw = rrMap(s).routes[r][5];
    if (tw < 0 || s.own[tw] === '.') return false;
    return s.own[tw] === String(seat) || s.n <= 3;
  }
  /* Ways to pay for a route: one entry per color that can be used, with how many locomotives it takes. */
  function rrPay(s, r, seat) {
    var R = rrMap(s).routes[r], h = s.hands[seat], wild = h[8], out = [];
    var cols = R[3] === 'x' ? 'roygbpkw'.split('') : [R[3]];
    cols.forEach(function (c) {
      var have = h[RR_CARDS.indexOf(c)];
      if (have > 0 && have + wild >= R[2]) out.push({ x: c, color: Math.min(have, R[2]), wild: R[2] - Math.min(have, R[2]) });
    });
    if (wild >= R[2]) out.push({ x: 'A', color: 0, wild: R[2] });     // all locomotives
    return out;
  }
  function rrClaimable(s, seat) {
    var out = [];
    for (var r = 0; r < rrMap(s).routes.length; r++) {
      if (s.own[r] !== '.' || rrMap(s).routes[r][2] > s.trains[seat] || rrBlocked(s, r, seat)) continue;
      rrPay(s, r, seat).forEach(function (p) { out.push({ k: 'claim', r: r, x: p.x }); });
    }
    return out;
  }
  function rrMoves(s) {
    if (s.over) return [];
    var p = s.turn, out = [], i;
    if (s.step === 'keep') {
      var offer = rrL(s.offer), min = s.phase === 'start' ? Math.min(2, offer.length) : 1;
      for (var mask = 1; mask < (1 << offer.length); mask++) {
        var keep = offer.filter(function (c, k) { return mask & (1 << k); });
        if (keep.length >= min) out.push({ k: 'keep', t: keep.join('') });
      }
      return out;
    }
    var canBlind = s.deck.length > 1 || s.disc.length > 1;
    for (i = 0; i < 5; i++) if (s.up[i] !== '.' && !(s.step === 'second' && s.up[i] === 'A')) out.push({ k: 'card', i: i });
    if (canBlind) out.push({ k: 'card', i: -1 });
    if (s.step === 'second') return out;
    if (s.tdeck.length > 1) out.push({ k: 'tickets' });
    out = out.concat(rrClaimable(s, p));
    if (!out.length) out.push({ k: 'pass' });
    return out;
  }
  function rrSame(a, b) { return a.k === b.k && a.i === b.i && a.r === b.r && a.x === b.x && a.t === b.t; }

  function rrEndTurn(s, p) {
    if (s.phase === 'start') {
      s.step = 'go';
      if (p === s.n - 1) { s.phase = 'play'; s.turn = 0; }
      else { s.turn = p + 1; rrOffer(s); }
      return;
    }
    s.step = 'go';
    if (s.final > 0) s.final--;
    else if (s.final < 0 && s.trains[p] <= 2) { s.final = s.n; rrLog(s, '@' + p + ' has 2 or fewer trains left. Everyone gets one last turn.'); }
    if (s.final === 0 || s.passes >= s.n * 2) { rrFinish(s); return; }
    s.turn = (p + 1) % s.n;
  }
  function rrOffer(s) {
    var td = rrL(s.tdeck), offer = td.splice(0, 3);
    s.tdeck = rrS(td); s.offer = rrS(offer); s.step = 'keep';
  }
  function rrLog(s, t) { s.log.push(t); while (s.log.length > 6) s.log.shift(); }

  function rrPlay(s0, m) {
    if (!rrMoves(s0).some(function (x) { return rrSame(x, m); })) throw new Error('That move is not allowed');
    var s = JSON.parse(JSON.stringify(s0)), p = s.turn, h = s.hands[p];
    if (m.k !== 'pass') s.passes = 0;
    if (m.k === 'keep') {
      var offer = rrL(s.offer), keep = m.t.split('');
      s.tix[p] = rrS(rrL(s.tix[p]).concat(keep));
      s.tdeck = rrS(rrL(s.tdeck).concat(offer.filter(function (c) { return keep.indexOf(c) < 0; })));
      s.offer = '-';
      s.last = { seat: p, k: 'tickets', n: keep.length, r: -1 };
      rrLog(s, '@' + p + ' kept ' + keep.length + (keep.length === 1 ? ' destination ticket.' : ' destination tickets.'));
      rrEndTurn(s, p);
      return s;
    }
    if (m.k === 'tickets') { rrOffer(s); return s; }
    if (m.k === 'pass') { s.passes++; s.last = { seat: p, k: 'pass', r: -1 }; rrLog(s, '@' + p + ' could not do anything and passed.'); rrEndTurn(s, p); return s; }
    if (m.k === 'card') {
      var c;
      if (m.i < 0) c = rrDraw(s);
      else { var up = s.up.split(''); c = up[m.i]; up[m.i] = '.'; s.up = up.join(''); rrRefill(s); }
      if (c) h[RR_CARDS.indexOf(c)]++;
      var took = m.i < 0 ? '?' : c;
      var first = s.step !== 'second';
      s.last = { seat: p, k: 'cards', r: -1, c: (first ? '' : (s.last && s.last.seat === p && s.last.k === 'cards' ? s.last.c : '')) + took };
      var more = first && !(m.i >= 0 && c === 'A');
      if (more) {
        s.step = 'second';
        var any = s.deck.length > 1 || s.disc.length > 1 || s.up.split('').some(function (x) { return x !== '.' && x !== 'A'; });
        if (any) return s;
      }
      var cs = s.last.c.split(''), seen = cs.filter(function (x) { return x !== '?'; }).map(function (x) { return RR_COLOR[x].toLowerCase(); });
      rrLog(s, '@' + p + ' took ' + (cs.length === 1 ? 'a card' : '2 cards') + (seen.length ? ' (' + seen.join(' and ') + (cs.indexOf('?') >= 0 ? ' and one from the deck' : '') + ')' : ' from the deck') + '.');
      rrEndTurn(s, p);
      return s;
    }
    var R = rrMap(s).routes[m.r], pay = rrPay(s, m.r, p).filter(function (q) { return q.x === m.x; })[0];
    var disc = rrL(s.disc), k;
    if (pay.color) { h[RR_CARDS.indexOf(m.x)] -= pay.color; for (k = 0; k < pay.color; k++) disc.push(m.x); }
    h[8] -= pay.wild; for (k = 0; k < pay.wild; k++) disc.push('A');
    s.disc = rrS(disc);
    s.own = s.own.substr(0, m.r) + p + s.own.substr(m.r + 1);
    s.trains[p] -= R[2]; s.pts[p] += RR_PTS[R[2]];
    s.last = { seat: p, k: 'claim', r: m.r };
    rrLog(s, '@' + p + ' claimed ' + rrMap(s).towns[R[0]][0] + ' to ' + rrMap(s).towns[R[1]][0] + ' (' + R[2] + (R[2] === 1 ? ' train' : ' trains') + ', +' + RR_PTS[R[2]] + ').');
    rrEndTurn(s, p);
    return s;
  }

  /* Connected towns, longest line, and the final count. */
  function rrRoots(s, seat) {
    var par = rrMap(s).towns.map(function (t, i) { return i; });
    var f = function (x) { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    for (var r = 0; r < rrMap(s).routes.length; r++) if (s.own[r] === String(seat)) par[f(rrMap(s).routes[r][0])] = f(rrMap(s).routes[r][1]);
    return f;
  }
  function rrTicketDone(s, seat, t) { var f = rrRoots(s, seat), T = rrMap(s).tickets[t]; return f(T[0]) === f(T[1]); }
  function rrLongest(s, seat) {
    var mine = [], best = 0, adj = {};
    for (var r = 0; r < rrMap(s).routes.length; r++) if (s.own[r] === String(seat)) mine.push(r);
    mine.forEach(function (r) { var R = rrMap(s).routes[r]; (adj[R[0]] = adj[R[0]] || []).push(r); (adj[R[1]] = adj[R[1]] || []).push(r); });
    var used = {};
    var walk = function (town, len) {
      if (len > best) best = len;
      (adj[town] || []).forEach(function (r) {
        if (used[r]) return;
        used[r] = 1;
        var R = rrMap(s).routes[r];
        walk(R[0] === town ? R[1] : R[0], len + R[2]);
        used[r] = 0;
      });
    };
    Object.keys(adj).forEach(function (t) { walk(+t, 0); });
    return best;
  }
  function rrFinish(s) {
    var longest = [], top = 0, i;
    for (i = 0; i < s.n; i++) { longest.push(rrLongest(s, i)); if (longest[i] > top) top = longest[i]; }
    s.res = [];
    for (i = 0; i < s.n; i++) {
      var plus = 0, minus = 0, done = 0;
      rrTix(s.tix[i]).forEach(function (t) { if (rrTicketDone(s, i, t)) { plus += rrMap(s).tickets[t][2]; done++; } else minus += rrMap(s).tickets[t][2]; });
      var bonus = top > 0 && longest[i] === top ? 10 : 0;
      s.res.push([s.pts[i], plus, minus, bonus, s.pts[i] + plus - minus + bonus, done, longest[i]]);
    }
    s.over = 1; s.step = 'go';
  }

  /* ---- AI ---- */
  function rrPath(s, seat, a, b) {
    var dist = {}, prev = {}, done = {}, n = rrMap(s).towns.length;
    dist[a] = 0;
    for (var it = 0; it < n; it++) {
      var u = -1;
      for (var v = 0; v < n; v++) if (!done[v] && dist[v] !== undefined && (u < 0 || dist[v] < dist[u])) u = v;
      if (u < 0) break;
      done[u] = 1;
      if (u === b) break;
      for (var r = 0; r < rrMap(s).routes.length; r++) {
        var R = rrMap(s).routes[r], w;
        if (R[0] !== u && R[1] !== u) continue;
        if (s.own[r] === String(seat)) w = 0;
        else if (s.own[r] === '.' && !rrBlocked(s, r, seat)) w = R[2];
        else continue;
        var o = R[0] === u ? R[1] : R[0];
        if (dist[o] === undefined || dist[u] + w < dist[o]) { dist[o] = dist[u] + w; prev[o] = r; }
      }
    }
    if (dist[b] === undefined) return null;
    var path = [], x = b;
    while (x !== a) { var pr = prev[x]; if (s.own[pr] === '.') path.push(pr); x = rrMap(s).routes[pr][0] === x ? rrMap(s).routes[pr][1] : rrMap(s).routes[pr][0]; }
    return { cost: dist[b], routes: path };
  }
  function rrNeeds(s, seat) {
    var need = {}, cost = 0;
    rrTix(s.tix[seat]).forEach(function (t) {
      if (rrTicketDone(s, seat, t)) return;
      var T = rrMap(s).tickets[t], path = rrPath(s, seat, T[0], T[1]);
      if (!path || path.cost > s.trains[seat]) return;
      cost += path.cost;
      path.routes.forEach(function (r) { need[r] = (need[r] || 0) + T[2]; });
    });
    return { need: need, cost: cost };
  }
  function rrAI(s, level) {
    var mv = rrMoves(s), p = s.turn, h = s.hands[p];
    if (!mv.length) return null;
    var pick = function (list) { return list[Math.floor(Math.random() * list.length)]; };
    if (s.step === 'keep') {
      if (level === 0) return pick(mv);
      var best = null, bv = -1e9;
      mv.forEach(function (m) {
        var sim = JSON.parse(JSON.stringify(s));
        sim.tix[p] = rrS(rrL(sim.tix[p]).concat(m.t.split('')));
        var plan = rrNeeds(sim, p), pts = 0, lost = 0;
        m.t.split('').forEach(function (c) {
          var T = rrMap(s).tickets[parseInt(c, 36)], path = rrPath(sim, p, T[0], T[1]);
          if (path && path.cost <= s.trains[p]) pts += T[2]; else lost += T[2];
        });
        var load = Object.keys(plan.need).reduce(function (t, r) { return t + rrMap(s).routes[r][2]; }, 0);
        var v = pts - lost * 2 - Math.max(0, load - s.trains[p] * 0.65) * 3 - m.t.length * 2;
        if (v > bv) { bv = v; best = m; }
      });
      return best;
    }
    var claims = mv.filter(function (m) { return m.k === 'claim'; });
    var draws = mv.filter(function (m) { return m.k === 'card'; });
    if (level === 0 && s.step !== 'second') {
      if (claims.length && Math.random() < 0.55) return pick(claims);
      if (draws.length) return pick(draws);
      return mv[0];
    }
    var plan = rrNeeds(s, p), need = plan.need, endgame = s.final >= 0 || s.trains[p] <= 6;
    var score = function (m) {
      var R = rrMap(s).routes[m.r], pay = rrPay(s, m.r, p).filter(function (q) { return q.x === m.x; })[0];
      return (need[m.r] ? 100 + need[m.r] : 0) + RR_PTS[R[2]] * 2 - pay.wild * 1.5;
    };
    if (s.step !== 'second') {
      var useful = claims.filter(function (m) { return need[m.r] || endgame; });
      if (!useful.length && !Object.keys(need).length) useful = claims.filter(function (m) { return rrMap(s).routes[m.r][2] >= 3 || s.trains[p] < 10; });
      if (level === 2) useful.forEach(function (m) {
        if (!need[m.r]) return;
        var R = rrMap(s).routes[m.r], sim = JSON.parse(JSON.stringify(s));
        sim.own = sim.own.substr(0, m.r) + '9' + sim.own.substr(m.r + 1);
        if (R[5] >= 0) sim.own = sim.own.substr(0, R[5]) + '9' + sim.own.substr(R[5] + 1);
        var alt = rrPath(sim, p, R[0], R[1]);
        m.risk = alt ? Math.max(0, alt.cost - R[2]) : 20;
      });
      if (useful.length) { useful.sort(function (a, b) { return score(b) + (b.risk || 0) * 3 - score(a) - (a.risk || 0) * 3; }); var u = useful[0]; return { k: u.k, r: u.r, x: u.x }; }
      if (level === 2 && !Object.keys(need).length && !endgame && s.trains[p] >= 14 && mv.some(function (m) { return m.k === 'tickets'; }) && rrTix(s.tix[p]).length < 4) return { k: 'tickets' };
    }
    if (!draws.length) return claims[0] || mv[0];
    var want = {};
    Object.keys(need).forEach(function (r) {
      var R = rrMap(s).routes[r];
      if (R[3] === 'x') return;
      var gap = R[2] - h[RR_CARDS.indexOf(R[3])];
      if (gap > 0) want[R[3]] = Math.max(want[R[3]] || 0, gap + need[r] / 10);
    });
    var bestUp = null, bw = 0;
    draws.forEach(function (m) { if (m.i >= 0 && want[s.up[m.i]] > bw) { bw = want[s.up[m.i]]; bestUp = m; } });
    if (bestUp && (level === 2 || Math.random() < 0.3)) return bestUp;
    var blind = draws.filter(function (m) { return m.i < 0; })[0];
    return blind || draws[0];
  }

  var ironroads = {
    id: 'ironroads', cats: ['modern'], name: 'Iron Roads', like: 'Ticket to Ride', min: 2, max: 4, seats: [], ui: 'rails', aiDelay: 1300,
    blurb: 'Collect train cards, claim railway routes between cities, and link up the destinations on your secret tickets. Play across the United States, the Midwest, California or an invented land.',
    options: [{ key: 'map', label: 'Map', choices: RR_MAP_ORDER.map(function (id) { return [id, RR_MAPS[id].name]; }) }],
    mapOf: rrMap, cards: RR_CARDS, colors: RR_COLOR, points: RR_PTS,
    list: rrL, ticketIds: rrTix, pay: rrPay, blocked: rrBlocked, ticketDone: rrTicketDone, longest: rrLongest,
    help: [
      'Each player has a set number of trains (35 on the invented map, fewer on the smaller real maps), 4 train cards and secret destination tickets. At the start, pick at least 2 of the 3 tickets you are offered.',
      'On your turn do one thing: take train cards, claim a route, or take more destination tickets.',
      'Taking cards: take 2, from the 5 face up or from the top of the deck. A face-up locomotive counts as both of your cards. You cannot take a face-up locomotive as your second card.',
      'Claiming a route: pay cards of the route’s color, one per train. Grey routes take any one color. Locomotives stand in for any color. Your trains then sit on the route.',
      'Routes score 1, 2, 4, 7, 10 or 15 points for 1 to 6 trains. Some towns are joined by two routes. With 2 or 3 players only one of the pair can be used, and nobody may take both.',
      'Taking tickets: draw 3 and keep at least 1. A ticket you complete by the end scores its points. One you do not complete costs them.',
      'When anyone is down to 2 trains or fewer, everyone, including them, gets one last turn.',
      'At the end, tickets are revealed and the longest continuous line earns 10 more points.'
    ],
    init: function (n, opts) {
      n = Math.max(2, Math.min(4, n || 2));
      var deck = [], i;
      'roygbpkw'.split('').forEach(function (c) { for (var k = 0; k < 12; k++) deck.push(c); });
      for (i = 0; i < 14; i++) deck.push('A');
      rrShuffle(deck);
      var map = RR_MAPS[opts && opts.map] ? opts.map : RR_MAP_ORDER[0], M = RR_MAPS[map];
      var s = { n: n, map: map, opts: { map: map }, phase: 'start', turn: 0, step: 'go', over: 0, final: -1, passes: 0, deck: '-', disc: '-', up: '.....',
        hands: [], tix: [], trains: [], pts: [], own: new Array(M.routes.length + 1).join('.'), log: ['The cards are dealt. Everyone picks their first tickets.'] };
      for (i = 0; i < n; i++) {
        var hh = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        deck.splice(0, 4).forEach(function (c) { hh[RR_CARDS.indexOf(c)]++; });
        s.hands.push(hh); s.tix.push('-'); s.trains.push(M.trains); s.pts.push(0);
      }
      s.deck = rrS(deck);
      rrRefill(s);
      s.tdeck = rrS(rrShuffle(M.tickets.map(function (t, k) { return rrTid(k); })));
      rrOffer(s);
      return s;
    },
    moves: rrMoves,
    play: rrPlay,
    outcome: function (s) {
      if (!s.over) return null;
      var best = -1e9, who = [];
      s.res.forEach(function (r, i) {
        var key = r[4] * 1000 + r[5] * 10 + (r[3] ? 1 : 0);
        if (key > best) { best = key; who = [i]; } else if (key === best) who.push(i);
      });
      if (who.length > 1) return { winner: -1, reason: 'a tie on ' + s.res[who[0]][4] + ' points' };
      return { winner: who[0], reason: 'scoring ' + s.res[who[0]][4] + ' points' };
    },
    hint: function (s) {
      if (s.step === 'keep') return s.phase === 'start' ? 'Pick at least 2 destination tickets to keep.' : 'Pick at least 1 destination ticket to keep.';
      if (s.step === 'second') return 'Take your second card.';
      return 'Your turn: take cards, claim a route, or take tickets.';
    },
    piece: function () { return null; },
    tally: function (s, seat) { return s.pts[seat] + ' pts'; },
    alert: function () { return -1; },
    ai: rrAI
  };

  return { checkers: checkers, chess: chess, bannerclash: bannerclash, tileyard: tileyard, ironroads: ironroads, cribbage: cribbage, gofish: gofish, pondsnap: pondsnap, mystery: mystery };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GAMES;

/* When loaded as a Web Worker, think about AI moves off the main thread. */
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = function (e) {
    var d = e.data, move = null;
    try { move = GAMES[d.type].ai(d.state, d.level); } catch (err) { move = null; }
    self.postMessage({ id: d.id, move: move });
  };
}
