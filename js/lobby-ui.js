/*
 * Lobby-Oberfläche für Online-Spiele. Sitzt auf der Einstellungsseite (#setup) jedes Spiels.
 * Der Spieltyp kommt von <body data-game="schieber|molotov">.
 */
(function () {
  'use strict';

  var GAME = document.body.getAttribute('data-game') || 'schieber';
  var UI = window.JassUI || window.JassMolotovUI;
  var LEVELS = [['leicht', 'leicht'], ['mittel', 'mittel'], ['schwer', 'schwer']];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function build() {
    var setup = $('setup');
    if (!setup || $('online-panel')) return;
    var playersField = GAME === 'molotov'
      ? '<div class="field"><span class="label">Spieler</span><select id="on-players" class="select">' +
        '<option value="3">3 Spieler</option><option value="4" selected>4 Spieler</option></select></div>'
      : '';
    var html =
      '<section class="panel online-panel" id="online-panel">' +
      '<h2>Online spielen</h2>' +
      '<div class="field"><span class="label">Dein Name</span><input id="on-name" class="text" maxlength="16" placeholder="Name"></div>' +
      playersField +
      '<button type="button" class="btn primary wide" id="on-create">Lobby erstellen</button>' +
      '<div class="join-row"><input id="on-code" class="text" maxlength="12" placeholder="Code eingeben">' +
      '<button type="button" class="btn" id="on-join">Beitreten</button></div>' +
      '<div id="on-lobby" hidden>' +
      '<p class="lobby-code">Code: <b id="on-code-show"></b></p>' +
      '<ul class="seat-list" id="on-seats"></ul>' +
      '<div id="on-host" hidden>' +
      '<p class="small muted">Freie Plätze werden mit Computer-Spielern gefüllt.</p>' +
      '<button type="button" class="btn primary wide" id="on-start">Spiel starten</button></div>' +
      '<button type="button" class="btn ghost small" id="on-leave">Lobby verlassen</button>' +
      '</div>' +
      '<p class="small muted" id="on-status"></p>' +
      '</section>';
    var first = setup.querySelector('section.panel');
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    setup.insertBefore(wrap.firstChild, first || null);
    var saved = localStorage.getItem('jasstisch-name');
    if (saved) $('on-name').value = saved;
    $('on-create').addEventListener('click', function () {
      var name = $('on-name').value; localStorage.setItem('jasstisch-name', name);
      var players = GAME === 'molotov' ? parseInt($('on-players').value, 10) : 4;
      window.JassOnline.createLobby(GAME, players, name);
    });
    $('on-join').addEventListener('click', function () {
      var name = $('on-name').value; localStorage.setItem('jasstisch-name', name);
      window.JassOnline.joinLobby($('on-code').value, name);
    });
    $('on-leave').addEventListener('click', function () { window.JassOnline.leave(); });
    $('on-start').addEventListener('click', function () { window.JassOnline.hostStart(UI.readSettings()); });
    if (GAME === 'molotov') {
      $('on-players').addEventListener('change', function () { window.JassOnline.hostSetPlayers(parseInt($('on-players').value, 10)); });
    }
  }

  function renderLobby(lobby) {
    var box = $('on-lobby');
    if (!lobby) { box.hidden = true; $('on-create').hidden = false; $('on-join').parentNode.hidden = false; return; }
    box.hidden = false;
    $('on-create').hidden = true;
    $('on-join').parentNode.hidden = true;
    $('on-code-show').textContent = lobby.code;
    var isHost = window.JassOnline.state.role === 'host';
    var me = window.JassOnline.state.mySeat;
    var ul = $('on-seats');
    ul.innerHTML = '';
    lobby.seats.forEach(function (s, i) {
      var li = document.createElement('li');
      var label;
      if (s.kind === 'human') label = esc(s.name) + (s.connected ? '' : ' (getrennt, Computer spielt)') + (i === 0 ? ' · Host' : '');
      else if (s.kind === 'ai') label = 'Computer';
      else label = '<i>frei</i>';
      var level = '';
      if (isHost && s.kind !== 'human' && !lobby.started) {
        level = '<select class="select small" data-seat="' + i + '">' + LEVELS.map(function (l) {
          return '<option value="' + l[0] + '"' + (s.level === l[0] ? ' selected' : '') + '>' + l[1] + '</option>';
        }).join('') + '</select>';
      } else if (s.kind !== 'human') {
        level = '<span class="muted small">' + esc(s.level) + '</span>';
      }
      li.innerHTML = '<span class="dot ' + (s.kind === 'human' && s.connected ? 'ok' : '') + '"></span> ' + (i + 1) + '. ' + label + ' ' + level +
        (i === me ? ' <b>(du)</b>' : '');
      ul.appendChild(li);
    });
    ul.querySelectorAll('select[data-seat]').forEach(function (sel) {
      sel.addEventListener('change', function () { window.JassOnline.hostSetLevel(parseInt(sel.getAttribute('data-seat'), 10), sel.value); });
    });
    $('on-host').hidden = !isHost || lobby.started;
    if (GAME === 'molotov' && $('on-players')) $('on-players').value = String(lobby.players);
  }

  function showStatus(text) { $('on-status').textContent = text || ''; }

  document.addEventListener('DOMContentLoaded', function () {
    build();
    window.JassOnline.setHandlers({
      onLobby: renderLobby,
      onStart: function (adapter) { UI.attachOnline(adapter); },
      onRender: function (adapter) { UI.render(adapter); },
      onStatus: showStatus
    });
  });
})();
