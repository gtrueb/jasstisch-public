/*
 * Oberfläche für Molotov: jeder für sich, Striche statt Team-Punkte.
 */
(function () {
  'use strict';

  var R = window.JassRules;
  var M = window.JassMolotov;

  var SEAT_NAMES = ['Du', 'Max', 'Anna', 'Leo'];
  var SEAT_POS = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  var SUIT_LABEL = { R: 'Rosen', S: 'Schellen', L: 'Schilten', E: 'Eichel' };
  var RANK_LONG = { U: 'Under', O: 'Ober', K: 'König', A: 'Ass' };

  var ICON = {
    R: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="12" cy="6.5" r="4"/><circle cx="17.4" cy="10.4" r="4"/><circle cx="15.3" cy="16.8" r="4"/><circle cx="8.7" cy="16.8" r="4"/><circle cx="6.6" cy="10.4" r="4"/></g><circle cx="12" cy="12" r="2.4" fill="#fffdf7"/></svg>',
    S: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5c-3.3 0-5.6 2.5-5.6 6.1v4.1L4.2 16.6h15.6l-2.2-3.9V8.6c0-3.6-2.3-6.1-5.6-6.1z"/><circle cx="12" cy="19.4" r="2.2" fill="currentColor"/></svg>',
    L: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5l7.6 2.8v5.9c0 4.9-3.2 8.9-7.6 10.3-4.4-1.4-7.6-5.4-7.6-10.3V5.3z"/><path d="M12 7.5v9M8.5 11h7" stroke="#fffdf7" stroke-width="1.5" fill="none"/></svg>',
    E: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="14.6" rx="5.1" ry="6.2" fill="currentColor"/><path d="M6.7 10.6c0-3 2.4-4.7 5.3-4.7s5.3 1.7 5.3 4.7z" fill="currentColor" opacity=".75"/><path d="M12 3.4v3" stroke="currentColor" stroke-width="1.6"/></svg>'
  };

  var $ = function (id) { return document.getElementById(id); };
  var game = null;
  var lastSettings = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function cardNode(card, opts) {
    opts = opts || {};
    if (opts.back) {
      var b = document.createElement('div');
      b.className = 'card back' + (opts.small ? ' small' : '');
      return b;
    }
    var el = document.createElement(opts.static ? 'div' : 'button');
    if (!opts.static) el.type = 'button';
    el.className = 'card suit-' + card.s + (opts.dim ? ' dim' : '') + (opts.small ? ' small' : '');
    el.dataset.id = card.id;
    var label = (RANK_LONG[card.r] || card.r) + ' ' + SUIT_LABEL[card.s];
    el.title = label;
    el.setAttribute('aria-label', label);
    el.innerHTML =
      '<span class="corner tl"><b>' + esc(card.r) + '</b><i>' + ICON[card.s] + '</i></span>' +
      '<span class="center"><b>' + esc(card.r) + '</b>' + ICON[card.s] + '</span>' +
      '<span class="corner br"><b>' + esc(card.r) + '</b><i>' + ICON[card.s] + '</i></span>';
    if (opts.disabled) el.disabled = true;
    return el;
  }

  function renderSeats(st) {
    [0, 1, 2, 3].forEach(function (seat) {
      var box = $('seat-' + seat);
      var active = st.turnSeat === seat;
      var wins = st.trickWins[seat];
      box.className = 'seat seat-' + SEAT_POS[seat] + (active ? ' active' : '') + ' p' + seat;
      var chip = '<div class="chip"><span class="dot"></span><span class="name">' + esc(SEAT_NAMES[seat]) + '</span>' +
        '<small>' + wins + ' Stich' + (wins === 1 ? '' : 'e') + '</small></div>';
      var backs = '';
      if (seat !== 0) {
        var n = st.hands[seat].length;
        backs = '<div class="backs">';
        for (var i = 0; i < n; i++) backs += '<span class="mini-back" style="--i:' + i + '"></span>';
        backs += '</div>';
      }
      box.innerHTML = chip + backs;
    });
  }

  function renderHand(st) {
    var box = $('hand');
    box.innerHTML = '';
    var legal = st.legal || [];
    var canPlay = st.phase === 'play' && st.turnSeat === 0;
    var dealing = st.phase === 'deal';
    (st.hands[0] || []).forEach(function (card, idx) {
      var ok = canPlay && legal.indexOf(card.id) >= 0;
      var el = cardNode(card, { dim: canPlay && !ok, disabled: !ok });
      el.style.setProperty('--i', idx);
      if (dealing) el.classList.add('dealt');
      if (ok) el.addEventListener('click', function () { game.humanPlay(card.id); });
      box.appendChild(el);
    });
  }

  function renderTrick(st) {
    var box = $('trick');
    box.innerHTML = '';
    st.plays.forEach(function (p, idx) {
      var slot = document.createElement('div');
      slot.className = 'play play-' + SEAT_POS[p.seat] + (idx === st.plays.length - 1 ? ' fresh' : '');
      slot.appendChild(cardNode(p.card, { small: true, static: true }));
      box.appendChild(slot);
    });
  }

  function renderCenter(st) {
    var msg = '';
    var ev = st.lastEvent;
    if (st.phase === 'deal') {
      msg = 'Karten werden gemischt …';
    } else if (st.phase === 'play') {
      if (st.turnSeat === null) msg = '';
      else if (st.turnSeat === 0) msg = 'Du bist dran';
      else if (st.plays.length === 0) msg = SEAT_NAMES[st.turnSeat] + ' spielt aus';
      else msg = SEAT_NAMES[st.turnSeat] + ' ist dran';
      if (ev && ev.type === 'trump') msg = (ev.seat === 0 ? 'Du bestimmst' : SEAT_NAMES[ev.seat] + ' bestimmt') + ' den Trumpf: ' + SUIT_LABEL[ev.suit];
      if (ev && ev.type === 'stoeck') msg = 'Stöck: +' + R.STOECK_PTS + ' für ' + SEAT_NAMES[ev.seat];
    }
    $('felt-msg').textContent = msg;

    if (st.phase === 'play' && st.humanBest && st.turnSeat === 0 && st.trickNo === 0 && st.cfg.weis) {
      $('picker').innerHTML = '<button type="button" class="schieben" id="btn-weis">Weis ansagen: ' + esc(st.humanBest.label) + ' (' + st.humanBest.pts + ')</button>';
    } else {
      $('picker').innerHTML = '';
    }
    var weis = '';
    if (st.phase === 'play' && st.cfg.weis && st.trickNo <= 1) {
      var rows = st.weisAnn.map(function (a) {
        var won = st.weisRes && st.weisRes.seat === a.seat;
        var cls = st.trickNo === 0 ? '' : (won ? 'won' : 'lost');
        return '<span class="' + cls + '">' + esc(SEAT_NAMES[a.seat]) + ': ' + esc(a.label) + ' (' + a.pts + ')</span>';
      });
      weis = '<div class="weis"><b>Weisen (Minus)</b>' + (rows.length ? rows.join('') : '<span class="lost">Keine</span>') + '</div>';
    }
    $('weis').innerHTML = weis;
    var bw = $('btn-weis');
    if (bw) bw.addEventListener('click', function () { game.humanAnnounce(); });

    var badge = $('trumpbadge');
    badge.innerHTML = st.trump
      ? '<span class="suit-' + st.trump + '">' + ICON[st.trump] + '</span> ' + SUIT_LABEL[st.trump]
      : 'Obenabe';
    badge.className = 'trumpbadge' + (st.trump ? ' suit-' + st.trump : '');
  }

  function renderScore(st) {
    var max = Math.max.apply(null, st.totals.concat([1]));
    var tg = st.cfg.end === 'limit' ? st.cfg.limit : null;
    [0, 1, 2, 3].forEach(function (s) {
      var v = st.totals[s];
      var pct = Math.max(0, tg ? Math.min(100, (v / tg) * 100) : Math.min(100, (v / Math.max(max, 1)) * 100));
      $('score-' + s).innerHTML = '<div class="row"><span class="dot"></span><span class="name">' + esc(SEAT_NAMES[s]) +
        '</span><b>' + v + '</b></div><div class="bar"><i style="width:' + pct + '%"></i></div>';
    });
    $('target').textContent = st.cfg.end === 'limit'
      ? 'Limit: ' + st.cfg.limit + ' Striche'
      : 'Runde ' + Math.min(st.history.length + 1, st.cfg.rounds) + ' von ' + st.cfg.rounds;
    renderChalk(st);
    renderHistory(st);
  }

  // Striche auf der Kreidetafel: Bündel aus fünf, Rest als einzelne Striche.
  function strokeGroup() {
    var s = '<svg class="group" viewBox="0 0 60 30" aria-hidden="true">';
    for (var i = 0; i < 4; i++) s += '<line x1="' + (6 + i * 12) + '" y1="3" x2="' + (6 + i * 12) + '" y2="27"/>';
    s += '<line x1="2" y1="22" x2="54" y2="8"/></svg>';
    return s;
  }
  function strokeSingle() {
    return '<svg class="group single" viewBox="0 0 12 30" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="27"/></svg>';
  }

  function renderChalk(st) {
    var html = '';
    [0, 1, 2, 3].forEach(function (s) {
      var t = st.totals[s];
      var marks = '';
      for (var g = 0; g < Math.floor(t / 5); g++) marks += strokeGroup();
      for (var k = 0; k < t % 5; k++) marks += strokeSingle();
      html += '<div class="chalk-col"><div class="chalk-name">' + esc(SEAT_NAMES[s]) + '</div>' +
        '<div class="chalk-marks">' + marks + '</div>' +
        '<div class="chalk-num">' + t + '</div></div>';
    });
    $('chalk').innerHTML = html;
  }

  function renderHistory(st) {
    var rows = st.history.map(function (h) {
      return '<tr><td>' + h.round + '</td><td>' + (h.trump ? '<span class="suit-' + h.trump + '">' + ICON[h.trump] + '</span>' : '–') + '</td>' +
        h.tallies.map(function (t) { return '<td>' + t + '</td>'; }).join('') + '</tr>';
    }).join('');
    $('history').innerHTML = rows
      ? '<table><thead><tr><th>Runde</th><th>Trumpf</th>' + SEAT_NAMES.map(function (n) { return '<th>' + esc(n) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + rows + '</tbody></table>'
      : '<p class="muted">Noch keine Runde gespielt.</p>';
  }

  function renderModal(st) {
    var m = $('modal');
    if (st.phase !== 'roundEnd' && st.phase !== 'gameEnd') {
      m.hidden = true;
      m.querySelector('.sheet').innerHTML = '';
      return;
    }
    var sc = st.lastScore;
    var over = st.phase === 'gameEnd';
    var title;
    if (over) {
      var names = st.gameWinners.map(function (s) { return SEAT_NAMES[s]; });
      title = names.length === 1
        ? (names[0] === 'Du' ? 'Du gewinnst das Spiel!' : names[0] + ' gewinnt das Spiel!')
        : 'Unentschieden: ' + names.join(' & ');
    } else {
      title = 'Runde ' + sc.round + ' beendet';
    }
    function row(label, vals, cls) {
      return '<div class="row' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span>' +
        vals.map(function (v) { return '<span>' + v + '</span>'; }).join('') + '</div>';
    }
    var head = '<div class="row head"><span></span>' + SEAT_NAMES.map(function (n) { return '<span>' + esc(n) + '</span>'; }).join('') + '</div>';
    var extra = '';
    if (sc.bonus.some(Boolean)) extra += row('Letzter Stich', sc.bonus);
    if (sc.tisch.some(Boolean)) extra += row('Tischweis', sc.tisch);
    if (sc.weis.some(Boolean)) extra += row('Weisen (Minus)', sc.weis);
    if (sc.stoeck.some(Boolean)) extra += row('Stöck (Minus)', sc.stoeck);
    var pillText = sc.trump ? 'Trumpf: ' + SUIT_LABEL[sc.trump] : 'Obenabe (kein Trumpf)';
    var rule = over ? '' : '<p class="muted">Striche = Punkte auf 10 gerundet, durch 10 geteilt</p>';
    m.querySelector('.sheet').innerHTML =
      '<h2 id="modal-title">' + esc(title) + '</h2>' +
      '<div class="pill">' + esc(pillText) + '</div>' +
      '<div class="table-score four">' + head +
      row('Kartenpunkte', sc.card) +
      extra +
      row('Punkte', sc.raw, 'sum') +
      row('Striche', sc.tallies, 'sum') +
      row('Stand', st.totals) +
      '</div>' + rule +
      (over
        ? '<button type="button" class="btn primary" id="btn-again">Neues Spiel</button>' +
          '<button type="button" class="btn ghost" id="btn-menu-end">Zum Menü</button>'
        : '<button type="button" class="btn primary" id="btn-next">Weiter</button>');
    m.hidden = false;
    var sheet = m.querySelector('.sheet');
    sheet.setAttribute('aria-labelledby', 'modal-title');
    var first = sheet.querySelector('.btn.primary');
    if (first) first.focus();
    var nx = $('btn-next');
    if (nx) nx.addEventListener('click', function () { game.nextRound(); });
    var ag = $('btn-again');
    if (ag) ag.addEventListener('click', function () { startGame(lastSettings); });
    var me = $('btn-menu-end');
    if (me) me.addEventListener('click', showSetup);
  }

  function render(g) {
    if (!g || g !== game) return;
    var st = g.stateForUI();
    renderSeats(st);
    renderHand(st);
    renderTrick(st);
    renderCenter(st);
    renderScore(st);
    renderModal(st);
  }

  function readSettings() {
    var end = document.querySelector('input[name="end"]:checked');
    var e = end ? end.value : 'limit';
    return {
      end: e === 'limit' ? 'limit' : 'rounds',
      limit: 50,
      rounds: e === 'rounds12' ? 12 : 8,
      weis: $('opt-weis').checked,
      stoeck: $('opt-stoeck').checked,
      lastTrick: $('opt-last').checked
    };
  }

  function startGame(settings) {
    lastSettings = settings;
    $('setup').hidden = true;
    $('table').hidden = false;
    $('modal').hidden = true;
    var speed = parseFloat(new URLSearchParams(window.location.search).get('speed')) || 1;
    var delays = {};
    Object.keys(M.DEFAULT_DELAYS).forEach(function (k) { delays[k] = Math.round(M.DEFAULT_DELAYS[k] / speed); });
    game = new M.Game({
      delays: delays,
      end: settings.end,
      limit: settings.limit,
      rounds: settings.rounds,
      weis: settings.weis,
      stoeck: settings.stoeck,
      lastTrick: settings.lastTrick,
      onUpdate: render
    });
    game.humanSeat = 0;
    game.startRound();
  }

  function showSetup() {
    game = null;
    $('table').hidden = true;
    $('setup').hidden = false;
    $('modal').hidden = true;
  }

  function setupTabs() {
    var btns = document.querySelectorAll('[data-tab]');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(btns, function (x) { x.classList.toggle('on', x === b); });
        var t = b.getAttribute('data-tab');
        $('tab-chalk').hidden = t !== 'chalk';
        $('tab-history').hidden = t !== 'history';
      });
    });
  }

  function init() {
    var start = $('btn-start');
    if (start) start.addEventListener('click', function () { startGame(readSettings()); });
    var leave = $('btn-leave');
    if (leave) leave.addEventListener('click', showSetup);
    setupTabs();
    if (new URLSearchParams(window.location.search).get('autostart') === '1') startGame(readSettings());
  }

  document.addEventListener('DOMContentLoaded', init);
  window.JassMolotovUI = { startGame: startGame, showSetup: showSetup };
})();
