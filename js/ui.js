/*
 * Oberfläche für Schieber: Einstellungen, Tisch, Trumpfwahl, Wertung.
 */
(function () {
  'use strict';

  var R = window.JassRules;
  var G = window.JassGame;

  var SEAT_NAMES = ['Du', 'Max', 'Anna', 'Leo']; // 0 unten (Du), 1 rechts, 2 oben, 3 links
  var SEAT_POS = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  var SUIT_LABEL = { R: 'Rosen', S: 'Schellen', L: 'Schilten', E: 'Eichel' };
  var RANK_LONG = { U: 'Under', O: 'Ober', K: 'König', A: 'Ass' };

  var ICON = {
    // Rosen: fünf Blütenblätter
    R: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="12" cy="6.5" r="4"/><circle cx="17.4" cy="10.4" r="4"/><circle cx="15.3" cy="16.8" r="4"/><circle cx="8.7" cy="16.8" r="4"/><circle cx="6.6" cy="10.4" r="4"/></g><circle cx="12" cy="12" r="2.4" fill="#fffdf7"/></svg>',
    // Schellen: Glocke
    S: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5c-3.3 0-5.6 2.5-5.6 6.1v4.1L4.2 16.6h15.6l-2.2-3.9V8.6c0-3.6-2.3-6.1-5.6-6.1z"/><circle cx="12" cy="19.4" r="2.2" fill="currentColor"/></svg>',
    // Schilten: Schild
    L: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5l7.6 2.8v5.9c0 4.9-3.2 8.9-7.6 10.3-4.4-1.4-7.6-5.4-7.6-10.3V5.3z"/><path d="M12 7.5v9M8.5 11h7" stroke="#fffdf7" stroke-width="1.5" fill="none"/></svg>',
    // Eichel: Nuss mit Hut
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
    // Gespielte Karten im Stich sind nur Anzeige, keine Schaltfläche.
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

  function teamName(t) { return t === 0 ? 'Du & Anna' : 'Max & Leo'; }

  function renderSeats(st) {
    [0, 1, 2, 3].forEach(function (seat) {
      var box = $('seat-' + seat);
      var active = st.turnSeat === seat || (st.phase === 'trump' && st.chooser === seat);
      var wins = st.trickWins[seat];
      var label = '';
      box.className = 'seat seat-' + SEAT_POS[seat] + (active ? ' active' : '') + ' team' + (seat % 2);
      var chip = '<div class="chip"><span class="dot"></span><span class="name">' + esc(SEAT_NAMES[seat]) + '</span>' +
        '<small>' + wins + ' Stich' + (wins === 1 ? '' : 'e') + '</small>' + label + '</div>';
      var hand = '';
      if (seat !== 0) {
        var n = st.hands[seat].length;
        hand = '<div class="backs">';
        for (var i = 0; i < n; i++) hand += '<span class="mini-back" style="--i:' + i + '"></span>';
        hand += '</div>';
      }
      box.innerHTML = chip + hand;
    });
  }

  function renderHand(st) {
    var box = $('hand');
    box.innerHTML = '';
    var hand = st.hands[0] || [];
    var legal = st.legal || [];
    var canPlay = st.phase === 'play' && st.turnSeat === 0;
    var dealing = st.phase === 'deal';
    hand.forEach(function (card, idx) {
      var ok = canPlay && legal.indexOf(card.id) >= 0;
      var el = cardNode(card, { dim: canPlay && !ok, disabled: !ok });
      el.style.setProperty('--i', idx);
      if (dealing) el.classList.add('dealt');
      if (ok) el.addEventListener('click', function () { game.humanPlay(card.id); });
      box.appendChild(el);
    });
    box.classList.toggle('turn', canPlay);
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

  function trumpLabel(s) { return s ? SUIT_LABEL[s] : '–'; }

  function renderCenter(st, settings) {
    var msg = '';
    var picker = '';
    var ev = st.lastEvent;

    if (st.phase === 'deal') {
      msg = 'Karten werden gemischt …';
    } else if (st.phase === 'trump') {
      var s7 = st.schellen7Holder >= 0 && !(ev && ev.type === 'schieben');
      if (st.chooser === 0) {
        msg = (s7 ? 'Schellen-7! ' : '') + 'Du wählst den Trumpf';
        picker = '<div class="picker">' +
          ['R', 'S', 'L', 'E'].map(function (s) {
            return '<button type="button" class="suit-btn suit-' + s + '" data-suit="' + s + '">' + ICON[s] + '<span>' + SUIT_LABEL[s] + '</span></button>';
          }).join('') +
          (st.canSchieben ? '<button type="button" class="schieben" id="btn-schieben">Schieben</button>' : '') +
          '</div>';
      } else {
        msg = (s7 ? 'Schellen-7! ' : '') + SEAT_NAMES[st.chooser] + ' wählt den Trumpf …';
        if (ev && ev.type === 'schieben') msg = SEAT_NAMES[ev.seat] + ' schiebt an ' + SEAT_NAMES[st.chooser] + ' …';
      }
    } else if (st.phase === 'play') {
      if (st.turnSeat === 0) msg = 'Du bist dran';
      else if (st.plays.length === 0) msg = SEAT_NAMES[st.turnSeat] + ' spielt aus';
      else msg = SEAT_NAMES[st.turnSeat] + ' ist dran';
      if (ev && ev.type === 'stoeck') msg = 'Stöck: +' + R.STOECK_PTS + ' für ' + teamName(ev.seat % 2);
    }

    var weis = '';
    if (st.phase === 'play' && st.trickNo === 0 && st.weisRes && settings.weis) {
      var best = st.weisRes;
      weis = '<div class="weis"><b>Weisen</b>' +
        [0, 1].map(function (t) {
          var pts = best.total[t];
          var counted = best.pts[t] > 0;
          var cls = counted ? 'won' : (pts > 0 ? 'lost' : '');
          return '<span class="' + cls + '">' + esc(teamName(t)) + ': ' + (pts ? pts : '0') + (pts && !counted ? ' (nicht gezählt)' : '') + '</span>';
        }).join('') + '</div>';
    }

    $('felt-msg').textContent = msg;
    $('picker').innerHTML = picker;
    $('weis').innerHTML = weis;
    $('trumpbadge').innerHTML = st.trump ? '<span class="suit-' + st.trump + '">' + ICON[st.trump] + '</span> ' + trumpLabel(st.trump) : 'Kein Trumpf';
    $('trumpbadge').className = 'trumpbadge' + (st.trump ? ' suit-' + st.trump : '');

    var sb = $('btn-schieben');
    if (sb) sb.addEventListener('click', function () { game.humanSchieben(); });
    Array.prototype.forEach.call(document.querySelectorAll('#picker [data-suit]'), function (b) {
      b.addEventListener('click', function () { game.humanChooseTrump(b.getAttribute('data-suit')); });
    });
  }

  function renderScore(st) {
    var tg = st.target;
    [0, 1].forEach(function (t) {
      var v = st.totals[t];
      $('score-' + t).innerHTML = '<div class="row"><span class="dot"></span><span class="name">' + esc(teamName(t)) +
        '</span><b>' + v + '</b></div><div class="bar"><i style="width:' + Math.min(100, (v / tg) * 100) + '%"></i></div>';
    });
    $('target').textContent = 'Ziel: ' + tg;
    renderChalk(st);
    renderHistory(st);
  }

  // Kreidetafel: je 100 Punkte ein Bündel aus fünf Strichen.
  function tallyGroup(n) {
    var s = '<svg class="group" viewBox="0 0 60 30" aria-hidden="true">';
    for (var i = 0; i < 4; i++) s += '<line x1="' + (6 + i * 12) + '" y1="3" x2="' + (6 + i * 12) + '" y2="27"/>';
    s += '<line x1="2" y1="22" x2="54" y2="8"/>';
    return s + '</svg>';
  }

  function renderChalk(st) {
    var html = '';
    [0, 1].forEach(function (t) {
      var v = st.totals[t];
      var full = Math.floor(v / 100);
      var rest = v - full * 100;
      var marks = '';
      for (var g = 0; g < full; g++) marks += tallyGroup(g);
      html += '<div class="chalk-col"><div class="chalk-name">' + esc(teamName(t)) + '</div>' +
        '<div class="chalk-marks">' + marks + '</div>' +
        '<div class="chalk-num">' + v + (rest ? '' : '') + '</div></div>';
    });
    $('chalk').innerHTML = html;
  }

  function renderHistory(st) {
    var rows = st.history.map(function (h) {
      return '<tr><td>' + h.round + '</td><td>' + (h.trump ? '<span class="suit-' + h.trump + '">' + ICON[h.trump] + '</span>' : '–') + '</td>' +
        '<td>' + h.score.total[0] + '</td><td>' + h.score.total[1] + '</td><td>' + h.totals[0] + ' : ' + h.totals[1] + '</td></tr>';
    }).join('');
    $('history').innerHTML = rows ? '<table><thead><tr><th>Runde</th><th>Trumpf</th><th>Du &amp; Anna</th><th>Max &amp; Leo</th><th>Stand</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted">Noch keine Runde gespielt.</p>';
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
    function row(label, a, b) {
      return '<div class="row"><span>' + label + '</span><span>' + a + '</span><span>' + b + '</span></div>';
    }
    var extra = '';
    if (sc.match[0] || sc.match[1]) extra += row('Match-Bonus', sc.match[0], sc.match[1]);
    if (sc.weis[0] || sc.weis[1]) extra += row('Weisen', sc.weis[0], sc.weis[1]);
    if (sc.stoeck[0] || sc.stoeck[1]) extra += row('Stöck', sc.stoeck[0], sc.stoeck[1]);
    var dbl = sc.factor === 2 ? '<p class="muted">Schilten doppelt: alle Punkte ×2</p>' : '';
    var title = over ? (teamName(st.gameWinner) + ' gewinnen das Spiel!') : 'Runde beendet';
    m.querySelector('.sheet').innerHTML =
      '<h2>' + esc(title) + '</h2>' +
      '<div class="pill">Trumpf: ' + esc(trumpLabel(st.trump)) + '</div>' +
      '<div class="table-score">' +
      '<div class="row head"><span></span><span>Du &amp; Anna</span><span>Max &amp; Leo</span></div>' +
      '<div class="row"><span>Kartenpunkte</span><span>' + sc.card[0] + '</span><span>' + sc.card[1] + '</span></div>' +
      extra +
      '<div class="row sum"><span>Runde</span><span>' + sc.total[0] + '</span><span>' + sc.total[1] + '</span></div>' +
      '<div class="row"><span>Stand</span><span>' + st.totals[0] + '</span><span>' + st.totals[1] + '</span></div>' +
      '</div>' + dbl +
      (over
        ? '<button type="button" class="btn primary" id="btn-again">Neues Spiel</button>' +
          '<button type="button" class="btn ghost" id="btn-menu-end">Zum Menü</button>'
        : '<button type="button" class="btn primary" id="btn-next">Weiter</button>');
    m.hidden = false;
    var sheet = m.querySelector('.sheet');
    sheet.setAttribute('aria-labelledby', 'modal-title');
    sheet.querySelector('h2').id = 'modal-title';
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
    if (!g || g !== game) return; // alte Spiele (z. B. nach "Menü") nicht mehr zeichnen
    var st = g.stateForUI();
    var settings = lastSettings;
    renderSeats(st);
    renderHand(st);
    renderTrick(st);
    renderCenter(st, settings);
    renderScore(st);
    renderModal(st);
  }

  function readSettings() {
    var target = document.querySelector('input[name="target"]:checked');
    return {
      target: target ? parseInt(target.value, 10) : 1000,
      weis: $('opt-weis').checked,
      stoeck: $('opt-stoeck').checked,
      matchBonus: $('opt-match').checked,
      schilten2: $('opt-schilten').checked,
      schellen7: $('opt-schellen7').checked
    };
  }

  function startGame(settings) {
    lastSettings = settings;
    $('setup').hidden = true;
    $('table').hidden = false;
    $('modal').hidden = true;
    var speed = parseFloat(new URLSearchParams(window.location.search).get('speed')) || 1;
    var delays = {};
    Object.keys(G.DEFAULT_DELAYS).forEach(function (k) { delays[k] = Math.round(G.DEFAULT_DELAYS[k] / speed); });
    game = new G.Game({
      delays: delays,
      target: settings.target,
      weis: settings.weis,
      stoeck: settings.stoeck,
      matchBonus: settings.matchBonus,
      schilten2: settings.schilten2,
      schellen7: settings.schellen7,
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
    var params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') startGame(readSettings());
  }

  document.addEventListener('DOMContentLoaded', init);
  window.JassUI = { startGame: startGame, showSetup: showSetup };
})();
