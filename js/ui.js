/*
 * Oberfläche für Schieber: Einstellungen, Tisch, Trumpfwahl, Wertung.
 */
(function () {
  'use strict';

  var R = window.JassRules;
  var G = window.JassGame;

  var SEAT_NAMES = ['Du', 'Max', 'Anna', 'Leo']; // 0 unten (Du), 1 rechts, 2 oben, 3 links
  var curNames = SEAT_NAMES;   // Namen der aktuellen Sicht (Online: echte Namen)
  var curTeams = null;         // Teamnamen der aktuellen Sicht
  var SEAT_POS = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  var SUIT_LABEL = { R: 'Rosen', S: 'Schellen', L: 'Schilten', E: 'Eichel' };
  var RANK_LONG = { U: 'Under', O: 'Ober', K: 'König', A: 'Ass' };

  var ICON = {
    R: '<img class="suit-img" src="assets/suits/R.svg" alt="">',
    S: '<img class="suit-img" src="assets/suits/S.svg" alt="">',
    L: '<img class="suit-img" src="assets/suits/L.svg" alt="">',
    E: '<img class="suit-img" src="assets/suits/E.svg" alt="">'
  };

  var FACE_CODE = { '6': '6', '7': '7', '8': '8', '9': '9', '10': 'B', 'U': 'U', 'O': 'O', 'K': 'K', 'A': 'A' };
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
    // Gespielte Karten im Stich sind nur Anzeige, keine Schaltfläche.
    var el = document.createElement(opts.static ? 'div' : 'button');
    if (!opts.static) el.type = 'button';
    el.className = 'card suit-' + card.s + (opts.dim ? ' dim' : '') + (opts.small ? ' small' : '');
    el.dataset.id = card.id;
    var label = (RANK_LONG[card.r] || card.r) + ' ' + SUIT_LABEL[card.s];
    el.title = label;
    el.setAttribute('aria-label', label);
    // Karte als fertiges Bild (assets/cards/<Farbe><Rang>.svg). Zehn heisst "B" (Banner).
    el.innerHTML = '<img class="face" src="assets/cards/' + card.s + FACE_CODE[card.r] + '.svg" alt="">';
    if (opts.disabled) el.disabled = true;
    return el;
  }

  function teamName(t) { return curTeams ? curTeams[t] : (t === 0 ? 'Du & Anna' : 'Max & Leo'); }

  // Weis-Karten während der Pause nach dem ersten Stich (am Platz des Gewinners)
  function weisBlockHtml(w) {
    var cards = (w.cards || []).map(function (c) {
      return '<img class="mini-face" src="assets/cards/' + c.s + FACE_CODE[c.r] + '.svg" alt="">';
    }).join('');
    return '<div class="seat-weis"><div class="sw-title">Weis von ' + esc(curNames[w.seat]) + ': ' + esc(w.label) + ' (' + w.pts + ')</div>' +
      '<div class="weis-cards">' + cards + '</div>' +
      '<button type="button" class="btn small" id="weis-weiter">Weiter</button></div>';
  }

  function renderSeats(st) {
    [0, 1, 2, 3].forEach(function (seat) {
      var box = $('seat-' + seat);
      var active = st.turnSeat === seat || (st.phase === 'trump' && st.chooser === seat);
      var wins = st.trickWins[seat];
      var label = '';
      box.className = 'seat seat-' + SEAT_POS[seat] + (active ? ' active' : '') + ' team' + (seat % 2);
      var chip = '<div class="chip"><span class="dot"></span><span class="name">' + esc(curNames[seat]) + '</span>' +
        '<small>' + wins + ' Stich' + (wins === 1 ? '' : 'e') + '</small>' + label + '</div>';
      var hand = '';
      if (seat !== 0) {
        var n = st.hands[seat].length;
        hand = '<div class="backs">';
        for (var i = 0; i < n; i++) hand += '<span class="mini-back" style="--i:' + i + '"></span>';
        hand += '</div>';
      }
      box.innerHTML = chip + hand;
      if (st.weisHold && st.weisRes && st.weisRes.seat === seat) box.innerHTML += weisBlockHtml(st.weisRes);
    });
    var wb = document.getElementById('weis-weiter');
    if (wb) wb.addEventListener('click', function () { if (game) game.releaseHold(); });
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
    var hand = st.hands[0] || [];
    var legal = st.legal || [];
    var canPlay = st.phase === 'play' && st.turnSeat === 0;
    var dealing = st.phase === 'deal';
    var weisIds = st.humanWeisIds || [];
    sortHand(hand).forEach(function (card, idx) {
      var ok = canPlay && legal.indexOf(card.id) >= 0;
      var el = cardNode(card, { dim: canPlay && !ok, disabled: !ok });
      el.style.setProperty('--i', idx);
      if (weisIds.indexOf(card.id) >= 0) el.classList.add('weis-card');
      if (dealing) el.classList.add('dealt');
      if (ok) el.addEventListener('click', function () { game.humanPlay(card.id); });
      box.appendChild(el);
    });
    box.classList.toggle('turn', canPlay);
  }

  // Stich-Karten. Gewinnt ein Spieler den Stich, fliegen die Karten zu ihm.
  function renderTrick(st) {
    var box = $('trick');
    var prev = Array.prototype.filter.call(box.children, function (c) { return !c.classList.contains('flying'); });
    var trickChanged = box.dataset.trick !== undefined && +box.dataset.trick !== st.trickNo;
    Array.prototype.forEach.call(box.children, function (c) {
      if (!c.classList.contains('flying')) box.removeChild(c);
    });
    if (trickChanged && st.plays.length === 0 && prev.length) {
      window.JassFX.fly(box, prev, SEAT_POS[st.leader]);
    }
    box.dataset.trick = st.trickNo;
    st.plays.forEach(function (p, idx) {
      var slot = document.createElement('div');
      slot.className = 'play play-' + SEAT_POS[p.seat] + (idx === st.plays.length - 1 ? ' fresh' : '');
      slot.appendChild(cardNode(p.card, { small: true, static: true }));
      box.appendChild(slot);
    });
  }

  // Meldungen: Weis, Stöck, Trumpf (jede nur einmal)
  var seen = null;
  function checkToasts(st) {
    var FX = window.JassFX;
    if (!seen || seen.round !== st.history.length) {
      seen = { round: st.history.length, weis: 0, stoeck: '', trump: '' };
    }
    if (st.weisAnn.length < seen.weis) seen.weis = 0;
    st.weisAnn.slice(seen.weis).forEach(function (a) {
      FX.toast(curNames[a.seat] + ' sagt Weis an: ' + a.label + ' (' + a.pts + ')', 'weis');
    });
    seen.weis = st.weisAnn.length;
    var ev = st.lastEvent;
    if (ev && ev.type === 'stoeck') {
      var key = ev.seat + '-' + st.trickNo + '-' + st.plays.length;
      if (key !== seen.stoeck) { seen.stoeck = key; FX.toast('Stöck: +' + R.STOECK_PTS + ' für ' + teamName(ev.seat % 2), 'stoeck'); }
    }
    if (ev && ev.type === 'trump') {
      var tkey = st.history.length + '-' + ev.suit;
      if (tkey !== seen.trump) { seen.trump = tkey; FX.toast((ev.seat === 0 ? 'Du wählst' : curNames[ev.seat] + ' wählt') + ' Trumpf: ' + SUIT_LABEL[ev.suit], 'trump'); }
    }
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
        msg = (s7 ? 'Schellen-7! ' : '') + curNames[st.chooser] + ' wählt den Trumpf …';
        if (ev && ev.type === 'schieben') msg = curNames[ev.seat] + ' schiebt an ' + curNames[st.chooser] + ' …';
      }
    } else if (st.phase === 'play') {
      if (st.turnSeat === null) msg = '';
      else if (st.turnSeat === 0) msg = 'Du bist dran';
      else if (st.plays.length === 0) msg = curNames[st.turnSeat] + ' spielt aus';
      else msg = curNames[st.turnSeat] + ' ist dran';
      if (ev && ev.type === 'stoeck') msg = 'Stöck: +' + R.STOECK_PTS + ' für ' + teamName(ev.seat % 2);
    }

    // Weis-Schaltfläche: nur im ersten Stich, auf dem eigenen Zug.
    if (st.phase === 'play' && st.humanBest && st.turnSeat === 0 && st.trickNo === 0 && settings.weis) {
      picker = '<button type="button" class="schieben" id="btn-weis">Weis ansagen: ' + esc(st.humanBest.label) + ' (' + st.humanBest.pts + ')</button>';
    }

    // Weisen-Anzeige: alle Ansagen. Nach dem ersten Stich gilt nur der Gewinner.
    var weis = '';
    if (settings.weis && st.phase === 'play' && st.weisAnn.length && st.trickNo === 0) {
      var rows = st.weisAnn.map(function (a) {
        return '<span>' + esc(curNames[a.seat]) + ': ' + esc(a.label) + ' (' + a.pts + ')</span>';
      });
      weis = '<div class="weis"><b>Weis angesagt</b>' + rows.join('') + '</div>';
    }

    $('felt-msg').textContent = msg;
    $('picker').innerHTML = picker;
    $('weis').innerHTML = weis;
    var bw = $('btn-weis');
    if (bw) bw.addEventListener('click', function () { game.humanAnnounce(); });
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
    $('history').innerHTML = rows ? '<table><thead><tr><th>Runde</th><th>Trumpf</th><th>' + esc(teamName(0)) + '</th><th>' + esc(teamName(1)) + '</th><th>Stand</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted">Noch keine Runde gespielt.</p>';
  }

  // Karten des Gewinner-Weis (zwischen den Runden)
  function weisCardsHtml(cards) {
    return cards.map(function (c) {
      return '<img class="mini-face" src="assets/cards/' + c.s + FACE_CODE[c.r] + '.svg" alt="">';
    }).join('');
  }

  function weisBlockSchieber(sc) {
    return (sc.weisCards && sc.weisCards.length)
      ? '<div class="modal-weis"><b>Weis von ' + esc(curNames[sc.weisSeat]) + ' (' + sc.weisPts + ')</b>' +
        '<div class="weis-cards">' + weisCardsHtml(sc.weisCards) + '</div>' +
        '<span class="muted">' + esc(sc.weisLabel) + '</span></div>'
      : '';
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
      '<div class="row head"><span></span><span>' + esc(teamName(0)) + '</span><span>' + esc(teamName(1)) + '</span></div>' +
      '<div class="row"><span>Kartenpunkte</span><span>' + sc.card[0] + '</span><span>' + sc.card[1] + '</span></div>' +
      extra +
      '<div class="row sum"><span>Runde</span><span>' + sc.total[0] + '</span><span>' + sc.total[1] + '</span></div>' +
      '<div class="row"><span>Stand</span><span>' + st.totals[0] + '</span><span>' + st.totals[1] + '</span></div>' +
      '</div>' + weisBlockSchieber(sc) + dbl +
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
    if (!st) return;
    curNames = st.names || SEAT_NAMES;
    curTeams = st.teamNames || null;
    var settings = lastSettings;
    renderSeats(st);
    renderHand(st);
    renderTrick(st);
    renderCenter(st, settings);
    renderScore(st);
    renderModal(st);
    checkToasts(st);
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
    if (game) game.stop();
    lastSettings = settings;
    $('setup').hidden = true;
    $('table').hidden = false;
    $('modal').hidden = true;
    var delays = window.JassTempo.scaled(G.DEFAULT_DELAYS);
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
    if (game && game.stop) game.stop();
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
    var reset = $('btn-reset');
    if (reset) reset.addEventListener('click', function () {
      // Neu beginnen mit den gleichen Einstellungen (oder den Einstellungen der Startseite).
      startGame(game && lastSettings ? lastSettings : readSettings());
    });
    setupTabs();
    var params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') startGame(readSettings());
  }

  window.addEventListener('jass-tempo', function () {
    if (!game) return;
    var d = window.JassTempo.scaled(G.DEFAULT_DELAYS);
    Object.keys(d).forEach(function (k) { game.delays[k] = d[k]; });
  });
  document.addEventListener('DOMContentLoaded', init);
  // Online: Tisch mit einem fertigen Adapter (Host oder Mitspieler) öffnen.
  function attachOnline(adapter, settings) {
    game = adapter;
    lastSettings = settings || readSettings();
    $('setup').hidden = true;
    $('table').hidden = false;
    $('modal').hidden = true;
  }
  window.JassUI = { startGame: startGame, showSetup: showSetup, attachOnline: attachOnline, readSettings: readSettings, render: function (g) { render(g); } };
})();
