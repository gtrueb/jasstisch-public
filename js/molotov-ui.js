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
    R: '<img class="suit-img" src="assets/suits/R.svg" alt="">',
    S: '<img class="suit-img" src="assets/suits/S.svg" alt="">',
    L: '<img class="suit-img" src="assets/suits/L.svg" alt="">',
    E: '<img class="suit-img" src="assets/suits/E.svg" alt="">'
  };

  var COURT = { U: true, O: true, K: true }; // Hofkarten: eigene Bilder aus assets/cards/
  var $ = function (id) { return document.getElementById(id); };
  var game = null;
  var lastSettings = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function cardNode(card, opts) {
    opts = opts || {};
    if (opts.back) {
      var b = document.createElement('div');
      b.className = 'card back' + (opts.small ? ' small' : '');
      b.innerHTML = '<img class="back-img" src="assets/cards/back.svg" alt="">';
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
      (COURT[card.r] ? '<span class="center court"><img src="assets/cards/' + card.s + card.r + '.svg" alt=""></span>' : '<span class="center"><b>' + esc(card.r) + '</b>' + ICON[card.s] + '</span>') +
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

  // Sortierung: erst nach Farbe (Rosen, Schellen, Schilten, Eichel), dann nach Rang von klein nach gross.
  var SUIT_ORDER = { R: 0, S: 1, L: 2, E: 3 };
  function sortHand(hand) {
    return hand.slice().sort(function (a, b) {
      if (SUIT_ORDER[a.s] !== SUIT_ORDER[b.s]) return SUIT_ORDER[a.s] - SUIT_ORDER[b.s];
      return R.ORDER_PLAIN[a.r] - R.ORDER_PLAIN[b.r];
    });
  }

  function renderHand(st) {
    var box = $('hand');
    box.innerHTML = '';
    var legal = st.legal || [];
    var canPlay = st.phase === 'play' && st.turnSeat === 0;
    var dealing = st.phase === 'deal';
    var weisIds = st.humanWeisIds || [];
    sortHand(st.hands[0] || []).forEach(function (card, idx) {
      var ok = canPlay && legal.indexOf(card.id) >= 0;
      var el = cardNode(card, { dim: canPlay && !ok, disabled: !ok });
      el.style.setProperty('--i', idx);
      if (weisIds.indexOf(card.id) >= 0) el.classList.add('weis-card');
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
    var delays = window.JassTempo.scaled(M.DEFAULT_DELAYS);
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

  window.addEventListener('jass-tempo', function () {
    if (!game) return;
    var d = window.JassTempo.scaled(M.DEFAULT_DELAYS);
    Object.keys(d).forEach(function (k) { game.delays[k] = d[k]; });
  });
  document.addEventListener('DOMContentLoaded', init);
  window.JassMolotovUI = { startGame: startGame, showSetup: showSetup };
})();
