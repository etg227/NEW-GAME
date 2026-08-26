/*:
 * @plugindesc K8s API / local quest bridge for RPG Maker MV/MZ
 * @author Cyrus Wong, etg227
 *
 * @help
 * Legacy mode: provide baseUrl, apiKey and game in the page query string.
 * Independent mode: when those values are absent, NPC interactions are routed
 * to K8sQuestEngine and no supervisor backend is required for game dialogue.
 */

(function () {
  'use strict';
  const wrapTextWidth = 55; // in half-width character units; CJK counts as 2
  const requestTimeoutMs = 15000;
  const urlParams = new URLSearchParams(window.location.search);
  const baseUrl = urlParams.get('baseUrl');
  const apiKey = urlParams.get('apiKey');
  const game = urlParams.get('game');
  const legacyMode = Boolean(baseUrl && apiKey && game);
  let lastResponse = null;
  let requestInFlight = false;

  const popitup = (url) => {
    window.open(url, 'name', 'scrollbars=1,resizable=1,width=1000,height=800');
    window.focus();
    return false;
  };

  const CJK_RE =
    /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

  const unitWidth = (unit) => {
    let width = 0;
    for (const ch of unit) width += CJK_RE.test(ch) ? 2 : 1;
    return width;
  };

  // Wraps by display width: CJK characters count as two units and may break
  // anywhere, while runs of non-CJK text only break at spaces.
  const wrapText = (text) => {
    const units = [];
    for (const segment of String(text || '').split(/\s+/)) {
      if (!segment) continue;
      let run = '';
      for (const ch of segment) {
        if (CJK_RE.test(ch)) {
          if (run) {
            units.push({ text: run, spaceAfter: false });
            run = '';
          }
          units.push({ text: ch, spaceAfter: false });
        } else {
          run += ch;
        }
      }
      if (run) units.push({ text: run, spaceAfter: false });
      if (units.length) units[units.length - 1].spaceAfter = true;
    }

    const lines = [];
    let line = '';
    let lineWidth = 0;
    let pendingSpace = false;

    for (const unit of units) {
      const width = unitWidth(unit.text);
      const spaceWidth = pendingSpace ? 1 : 0;
      if (line && lineWidth + spaceWidth + width > wrapTextWidth) {
        lines.push(line);
        line = unit.text;
        lineWidth = width;
      } else {
        line += (pendingSpace ? ' ' : '') + unit.text;
        lineWidth += spaceWidth + width;
      }
      pendingSpace = unit.spaceAfter;
    }
    if (line) lines.push(line);
    return lines.join('\n');
  };

  const callLocalQuest = (npcName) => {
    if (window.K8sQuestEngine) {
      window.K8sQuestEngine.interact(npcName);
      return;
    }
    $gameMessage.add('Quest engine is not available.');
  };

  const legacyBusyMessage = () => {
    let message = 'I am working on it now!';
    if (lastResponse?.next_game_phrase) {
      switch (lastResponse.next_game_phrase) {
        case 'SETUP':
          message = 'I am setting it up for you!';
          break;
        case 'READY':
          message = 'I am making sure it is ready for the challenge!';
          break;
        case 'CHALLENGE':
          message = 'I am running the challenge now!';
          break;
        case 'CHECK':
          message = 'I am checking the game now!';
          break;
      }
    }
    return message;
  };

  const callLegacyApi = (npcName) => {
    if (requestInFlight) {
      $gameMessage.add(legacyBusyMessage());
      return;
    }
    $gameMessage.add('Hello!');
    requestInFlight = true;

    let url = `${baseUrl}/game-task?game=${encodeURIComponent(game)}&npc=${encodeURIComponent(npcName)}`;
    if (lastResponse?.next_game_phrase) {
      url = `${baseUrl}/grader?game=${encodeURIComponent(game)}&phrase=${encodeURIComponent(lastResponse.next_game_phrase)}&npc=${encodeURIComponent(npcName)}`;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = requestTimeoutMs;
    xhr.setRequestHeader('x-api-key', apiKey);
    xhr.onerror = function () {
      requestInFlight = false;
      $gameMessage.add('Sorry, I cannot connect to the legacy server.');
    };
    xhr.ontimeout = function () {
      requestInFlight = false;
      $gameMessage.add(
        'The legacy server took too long to answer. Please try again.',
      );
    };
    xhr.onload = function () {
      requestInFlight = false;

      if (xhr.status !== 200) {
        $gameMessage.add('Sorry, I cannot connect to the legacy server.');
        return;
      }

      let json;
      try {
        json = JSON.parse(xhr.responseText);
      } catch (error) {
        console.error('NpcK8sPluginCommand: invalid JSON response', error);
        $gameMessage.add('The legacy server returned an invalid response.');
        return;
      }

      console.log(json);
      if (json.status !== 'OK' && json.report_url) popitup(json.report_url);
      if (json.message) $gameMessage.add(wrapText(json.message));
      if (json.status === 'OK') lastResponse = json;

      if (json.quest_validation && window.K8sQuestEngine) {
        window.K8sQuestEngine.applyValidationResult(json.quest_validation);
      }
    };
    xhr.send();
  };

  const callApi = (npcName) => {
    if (!legacyMode) {
      callLocalQuest(npcName);
      return;
    }
    callLegacyApi(npcName);
  };

  const _Game_Interpreter_pluginCommand =
    Game_Interpreter.prototype.pluginCommand;
  Game_Interpreter.prototype.pluginCommand = function (command, args) {
    _Game_Interpreter_pluginCommand.call(this, command, args);
    if (command === 'NpcK8sPluginCommand') {
      const npcName = args[0] || 'Quest NPC';
      console.log('NpcK8sPluginCommand Called by ' + npcName);
      callApi(npcName);
    }
  };

  // Exposed for unit tests.
  window.NpcK8sBridge = { wrapText: wrapText, isLegacyMode: () => legacyMode };
})();
