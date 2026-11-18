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
  var RR_TOWNS = [
    ['Frostport', 90, 80],
    ['Pinewick', 270, 60],
    ['Harrowgate', 460, 90],
    ['Northmere', 650, 60],
    ['Icehaven', 860, 90],
    ['Saltmarsh', 70, 240],
    ['Elderford', 230, 210],
    ['Copperhill', 390, 230],
    ['Kingsbridge', 560, 215],
    ['Thornbury', 720, 200],
    ['Eastwatch', 900, 240],
    ['Gullhaven', 150, 370],
    ['Millbrook', 300, 350],
    ['Crossroads', 470, 370],
    ['Larkspur', 640, 350],
    ['Ravenrock', 800, 355],
    ['Sunreach', 950, 390],
    ['Driftwood', 70, 500],
    ['Amberfield', 230, 505],
    ['Stonehollow', 400, 500],
    ['Willowmere', 570, 500],
    ['Ironvale', 740, 495],
    ['Brightwater', 900, 520],
    ['Coralbay', 160, 630],
    ['Dunmore', 340, 640],
    ['Southgate', 520, 640],
    ['Marrowdale', 700, 635],
    ['Cinderpeak', 870, 640]
  ];
  /* from, to, length, color (x = any color), bend (long lines curve away from the map), twin (the other half of a double route, or -1) */
  var RR_ROUTES = [[0,1,4,'x',0,-1], [1,2,4,'k',0,-1], [2,3,4,'b',0,-1], [3,4,4,'b',0,-1], [5,6,3,'r',0,-1], [6,7,3,'y',0,-1], [7,8,3,'r',0,7], [7,8,3,'b',0,6], [8,9,3,'x',0,-1], [9,10,4,'o',0,-1], [11,12,2,'x',0,-1], [12,13,3,'w',0,12], [12,13,3,'g',0,11], [13,14,3,'b',0,14], [13,14,3,'o',0,13], [14,15,3,'p',0,-1], [15,16,2,'o',0,-1], [17,18,3,'x',0,-1], [18,19,3,'y',0,-1], [19,20,3,'w',0,20], [19,20,3,'b',0,19], [20,21,3,'x',0,-1], [21,22,3,'w',0,-1], [23,24,4,'k',0,-1], [24,25,4,'y',0,-1], [25,26,4,'w',0,-1], [26,27,3,'g',0,-1], [0,5,3,'k',0,-1], [0,6,4,'b',0,-1], [1,6,2,'x',0,-1], [1,7,4,'r',0,-1], [2,7,2,'x',0,-1], [2,8,3,'y',0,33], [2,8,3,'r',0,32], [3,8,3,'k',0,-1], [3,9,2,'x',0,-1], [4,9,3,'w',0,-1], [4,10,2,'x',0,-1], [5,11,2,'x',0,-1], [6,11,3,'p',0,-1], [6,12,2,'p',0,-1], [7,12,2,'x',0,-1], [7,13,3,'x',0,-1], [8,13,4,'o',0,44], [8,13,4,'g',0,43], [8,14,2,'w',0,-1], [9,14,3,'p',0,-1], [9,15,3,'o',0,-1], [10,15,2,'x',0,-1], [10,16,2,'p',0,-1], [11,17,2,'k',0,-1], [11,18,2,'x',0,-1], [12,18,3,'x',0,-1], [12,19,4,'r',0,-1], [13,19,1,'k',0,-1], [13,20,3,'y',0,-1], [14,20,3,'g',0,57], [14,20,3,'p',0,56], [14,21,3,'w',0,-1], [15,21,2,'y',0,-1], [15,22,4,'r',0,-1], [16,22,1,'w',0,-1], [17,23,2,'r',0,-1], [18,23,1,'w',0,-1], [18,24,3,'x',0,-1], [19,24,2,'o',0,-1], [19,25,4,'x',0,-1], [20,25,2,'g',0,-1], [20,26,4,'y',0,-1], [21,26,1,'x',0,-1], [21,27,4,'o',0,-1], [22,27,1,'x',0,-1], [0,17,6,'g',-50,-1], [4,16,5,'k',70,-1], [23,27,6,'x',-55,-1], [1,3,5,'p',50,-1]];
  var RR_TICKETS = [[0,17,6], [4,21,6], [11,24,5], [18,25,7], [20,27,7], [8,16,7], [10,14,5], [1,9,7], [5,7,6], [3,13,7], [23,26,9], [19,22,9], [12,15,9], [6,25,10], [2,26,9], [16,18,9], [11,21,11], [6,27,12], [13,22,9], [5,15,13], [4,24,12], [1,14,9], [0,10,15], [4,17,14], [0,27,14], [5,26,14], [0,15,14], [5,10,15], [1,27,14], [0,25,14]];
  var RR_CARDS = 'roygbpkwA';                        // eight colors, then A for the any-color locomotive
  var RR_COLOR = { r: 'Red', o: 'Orange', y: 'Yellow', g: 'Green', b: 'Blue', p: 'Purple', k: 'Black', w: 'White', A: 'Locomotive', x: 'Any color' };
  var RR_PTS = [0, 1, 2, 4, 7, 10, 15];
  var RR_TRAINS = 35;
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
    var tw = RR_ROUTES[r][5];
    if (tw < 0 || s.own[tw] === '.') return false;
    return s.own[tw] === String(seat) || s.n <= 3;
  }
  /* Ways to pay for a route: one entry per color that can be used, with how many locomotives it takes. */
  function rrPay(s, r, seat) {
    var R = RR_ROUTES[r], h = s.hands[seat], wild = h[8], out = [];
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
    for (var r = 0; r < RR_ROUTES.length; r++) {
      if (s.own[r] !== '.' || RR_ROUTES[r][2] > s.trains[seat] || rrBlocked(s, r, seat)) continue;
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
    var R = RR_ROUTES[m.r], pay = rrPay(s, m.r, p).filter(function (q) { return q.x === m.x; })[0];
    var disc = rrL(s.disc), k;
    if (pay.color) { h[RR_CARDS.indexOf(m.x)] -= pay.color; for (k = 0; k < pay.color; k++) disc.push(m.x); }
    h[8] -= pay.wild; for (k = 0; k < pay.wild; k++) disc.push('A');
    s.disc = rrS(disc);
    s.own = s.own.substr(0, m.r) + p + s.own.substr(m.r + 1);
    s.trains[p] -= R[2]; s.pts[p] += RR_PTS[R[2]];
    s.last = { seat: p, k: 'claim', r: m.r };
    rrLog(s, '@' + p + ' claimed ' + RR_TOWNS[R[0]][0] + ' to ' + RR_TOWNS[R[1]][0] + ' (' + R[2] + (R[2] === 1 ? ' train' : ' trains') + ', +' + RR_PTS[R[2]] + ').');
    rrEndTurn(s, p);
    return s;
  }

  /* Connected towns, longest line, and the final count. */
  function rrRoots(s, seat) {
    var par = RR_TOWNS.map(function (t, i) { return i; });
    var f = function (x) { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    for (var r = 0; r < RR_ROUTES.length; r++) if (s.own[r] === String(seat)) par[f(RR_ROUTES[r][0])] = f(RR_ROUTES[r][1]);
    return f;
  }
  function rrTicketDone(s, seat, t) { var f = rrRoots(s, seat), T = RR_TICKETS[t]; return f(T[0]) === f(T[1]); }
  function rrLongest(s, seat) {
    var mine = [], best = 0, adj = {};
    for (var r = 0; r < RR_ROUTES.length; r++) if (s.own[r] === String(seat)) mine.push(r);
    mine.forEach(function (r) { var R = RR_ROUTES[r]; (adj[R[0]] = adj[R[0]] || []).push(r); (adj[R[1]] = adj[R[1]] || []).push(r); });
    var used = {};
    var walk = function (town, len) {
      if (len > best) best = len;
      (adj[town] || []).forEach(function (r) {
        if (used[r]) return;
        used[r] = 1;
        var R = RR_ROUTES[r];
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
      rrTix(s.tix[i]).forEach(function (t) { if (rrTicketDone(s, i, t)) { plus += RR_TICKETS[t][2]; done++; } else minus += RR_TICKETS[t][2]; });
      var bonus = top > 0 && longest[i] === top ? 10 : 0;
      s.res.push([s.pts[i], plus, minus, bonus, s.pts[i] + plus - minus + bonus, done, longest[i]]);
    }
    s.over = 1; s.step = 'go';
  }

  /* ---- AI ---- */
  function rrPath(s, seat, a, b) {
    var dist = {}, prev = {}, done = {}, n = RR_TOWNS.length;
    dist[a] = 0;
    for (var it = 0; it < n; it++) {
      var u = -1;
      for (var v = 0; v < n; v++) if (!done[v] && dist[v] !== undefined && (u < 0 || dist[v] < dist[u])) u = v;
      if (u < 0) break;
      done[u] = 1;
      if (u === b) break;
      for (var r = 0; r < RR_ROUTES.length; r++) {
        var R = RR_ROUTES[r], w;
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
    while (x !== a) { var pr = prev[x]; if (s.own[pr] === '.') path.push(pr); x = RR_ROUTES[pr][0] === x ? RR_ROUTES[pr][1] : RR_ROUTES[pr][0]; }
    return { cost: dist[b], routes: path };
  }
  function rrNeeds(s, seat) {
    var need = {}, cost = 0;
    rrTix(s.tix[seat]).forEach(function (t) {
      if (rrTicketDone(s, seat, t)) return;
      var T = RR_TICKETS[t], path = rrPath(s, seat, T[0], T[1]);
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
          var T = RR_TICKETS[parseInt(c, 36)], path = rrPath(sim, p, T[0], T[1]);
          if (path && path.cost <= s.trains[p]) pts += T[2]; else lost += T[2];
        });
        var load = Object.keys(plan.need).reduce(function (t, r) { return t + RR_ROUTES[r][2]; }, 0);
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
      var R = RR_ROUTES[m.r], pay = rrPay(s, m.r, p).filter(function (q) { return q.x === m.x; })[0];
      return (need[m.r] ? 100 + need[m.r] : 0) + RR_PTS[R[2]] * 2 - pay.wild * 1.5;
    };
    if (s.step !== 'second') {
      var useful = claims.filter(function (m) { return need[m.r] || endgame; });
      if (!useful.length && !Object.keys(need).length) useful = claims.filter(function (m) { return RR_ROUTES[m.r][2] >= 3 || s.trains[p] < 10; });
      if (level === 2) useful.forEach(function (m) {
        if (!need[m.r]) return;
        var R = RR_ROUTES[m.r], sim = JSON.parse(JSON.stringify(s));
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
      var R = RR_ROUTES[r];
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
    blurb: 'Collect train cards, claim railway routes between towns, and link up the destinations on your secret tickets. Longest line earns a bonus.',
    towns: RR_TOWNS, routes: RR_ROUTES, tickets: RR_TICKETS, cards: RR_CARDS, colors: RR_COLOR, points: RR_PTS,
    list: rrL, ticketIds: rrTix, pay: rrPay, blocked: rrBlocked, ticketDone: rrTicketDone, longest: rrLongest,
    help: [
      'Each player has 35 trains, 4 train cards and secret destination tickets. At the start, pick at least 2 of the 3 tickets you are offered.',
      'On your turn do one thing: take train cards, claim a route, or take more destination tickets.',
      'Taking cards: take 2, from the 5 face up or from the top of the deck. A face-up locomotive counts as both of your cards. You cannot take a face-up locomotive as your second card.',
      'Claiming a route: pay cards of the route’s color, one per train. Grey routes take any one color. Locomotives stand in for any color. Your trains then sit on the route.',
      'Routes score 1, 2, 4, 7, 10 or 15 points for 1 to 6 trains. Some towns are joined by two routes. With 2 or 3 players only one of the pair can be used, and nobody may take both.',
      'Taking tickets: draw 3 and keep at least 1. A ticket you complete by the end scores its points. One you do not complete costs them.',
      'When anyone is down to 2 trains or fewer, everyone, including them, gets one last turn.',
      'At the end, tickets are revealed and the longest continuous line earns 10 more points.'
    ],
    init: function (n) {
      n = Math.max(2, Math.min(4, n || 2));
      var deck = [], i;
      'roygbpkw'.split('').forEach(function (c) { for (var k = 0; k < 12; k++) deck.push(c); });
      for (i = 0; i < 14; i++) deck.push('A');
      rrShuffle(deck);
      var s = { n: n, phase: 'start', turn: 0, step: 'go', over: 0, final: -1, passes: 0, deck: '-', disc: '-', up: '.....',
        hands: [], tix: [], trains: [], pts: [], own: new Array(RR_ROUTES.length + 1).join('.'), log: ['The cards are dealt. Everyone picks their first tickets.'] };
      for (i = 0; i < n; i++) {
        var hh = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        deck.splice(0, 4).forEach(function (c) { hh[RR_CARDS.indexOf(c)]++; });
        s.hands.push(hh); s.tix.push('-'); s.trains.push(RR_TRAINS); s.pts.push(0);
      }
      s.deck = rrS(deck);
      rrRefill(s);
      s.tdeck = rrS(rrShuffle(RR_TICKETS.map(function (t, k) { return rrTid(k); })));
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
