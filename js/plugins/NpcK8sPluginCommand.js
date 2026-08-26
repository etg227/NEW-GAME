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
  const wrapTextLength = 55;
  const urlParams = new URLSearchParams(window.location.search);
  const baseUrl = urlParams.get('baseUrl');
  const apiKey = urlParams.get('apiKey');
  const game = urlParams.get('game');
  const legacyMode = Boolean(baseUrl && apiKey && game);
  let lastResponse = null;
  let callCount = 0;

  const popitup = (url) => {
    window.open(url, 'name', 'scrollbars=1,resizable=1,width=1000,height=800');
    window.focus();
    return false;
  };

  const wrapText = (text) => {
    const words = String(text || '').split(' ');
    let wrappedText = '';
    let currentLine = '';

    for (const word of words) {
      const potentialLine = currentLine + (currentLine ? ' ' : '') + word;
      if (potentialLine.length <= wrapTextLength) {
        currentLine = potentialLine;
      } else {
        wrappedText += (wrappedText ? '\n' : '') + currentLine;
        currentLine = word;
      }
    }

    if (currentLine) {
      wrappedText += (wrappedText ? '\n' : '') + currentLine;
    }
    return wrappedText;
  };

  const callLocalQuest = (npcName) => {
    if (window.K8sQuestEngine) {
      window.K8sQuestEngine.interact(npcName);
      return;
    }
    $gameMessage.add('Quest engine is not available.');
  };

  const callLegacyApi = (npcName) => {
    if (callCount === 0) {
      $gameMessage.add('Hello!');
    }
    if (callCount > 0) {
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
      $gameMessage.add(message);
      return;
    }
    callCount++;

    let url = `${baseUrl}/game-task?game=${encodeURIComponent(game)}&npc=${encodeURIComponent(npcName)}`;
    if (lastResponse?.next_game_phrase) {
      url = `${baseUrl}/grader?game=${encodeURIComponent(game)}&phrase=${encodeURIComponent(lastResponse.next_game_phrase)}&npc=${encodeURIComponent(npcName)}`;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.setRequestHeader('x-api-key', apiKey);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      callCount = 0;

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

  const _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
  Game_Interpreter.prototype.pluginCommand = function (command, args) {
    _Game_Interpreter_pluginCommand.call(this, command, args);
    if (command === 'NpcK8sPluginCommand') {
      const npcName = args[0] || 'Quest NPC';
      console.log('NpcK8sPluginCommand Called by ' + npcName);
      callApi(npcName);
    }
  };
})();
