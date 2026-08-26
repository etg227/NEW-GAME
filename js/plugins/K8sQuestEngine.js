/*:
 * @plugindesc Independent quest/progression engine for Kubernetes Isekai.
 * @author etg227
 *
 * @help
 * Loads game-side quest definitions from data/K8sQuests.json and keeps
 * quest progress in the normal RPG Maker save file.
 *
 * Each quest may declare an "npc" (and optional "role") in K8sQuests.json.
 * A bound NPC gives, tracks and closes its own quest; every other NPC
 * points the player towards the current quest giver.
 *
 * Plugin commands:
 *   K8sQuest status
 *   K8sQuest check                # ask the Kubernetes validator to re-check
 *   K8sQuest start <questId>
 *   K8sQuest complete [questId]   # dev mode only (?questDev=1)
 *   K8sQuest reset                # dev mode only (?questDev=1)
 *
 * A Kubernetes validator (see validator/server.js) reports results with:
 *   K8sQuestEngine.applyValidationResult({
 *     questId: 'village-01-namespace',
 *     completed: true,
 *     objectives: [{ id: 'namespace', passed: true }]
 *   });
 * Results are only accepted for the quest that is currently active, so an
 * external component cannot complete the story out of order.
 */

(function () {
  'use strict';

  var DATA_NAME = '$dataK8sQuests';
  var DATA_FILE = 'K8sQuests.json';
  var STATE_VERSION = 1;
  var urlParams = new URLSearchParams(window.location.search);
  var devMode = urlParams.get('questDev') === '1';

  DataManager._databaseFiles.push({ name: DATA_NAME, src: DATA_FILE });

  var _Game_System_initialize = Game_System.prototype.initialize;
  Game_System.prototype.initialize = function () {
    _Game_System_initialize.call(this);
    this._k8sQuestState = {
      version: STATE_VERSION,
      currentQuestId: null,
      startedQuestIds: [],
      completedQuestIds: [],
      objectiveResults: {},
    };
  };

  function questList() {
    if (!window[DATA_NAME] || !Array.isArray(window[DATA_NAME].quests)) {
      return [];
    }
    return window[DATA_NAME].quests;
  }

  function findQuest(questId) {
    return questList().find(function (quest) {
      return quest.id === questId;
    });
  }

  function questForNpc(npcName) {
    if (!npcName) return null;
    var target = String(npcName).trim().toLowerCase();
    return (
      questList().find(function (quest) {
        return quest.npc && String(quest.npc).trim().toLowerCase() === target;
      }) || null
    );
  }

  function firstQuestId() {
    var quests = questList();
    return quests.length > 0 ? quests[0].id : null;
  }

  function ensureState() {
    if (!$gameSystem) return null;

    if (!$gameSystem._k8sQuestState) {
      $gameSystem._k8sQuestState = {
        version: STATE_VERSION,
        currentQuestId: null,
        startedQuestIds: [],
        completedQuestIds: [],
        objectiveResults: {},
      };
    }

    var state = $gameSystem._k8sQuestState;
    state.startedQuestIds = state.startedQuestIds || [];
    state.completedQuestIds = state.completedQuestIds || [];
    state.objectiveResults = state.objectiveResults || {};

    if (!state.currentQuestId && firstQuestId()) {
      state.currentQuestId = firstQuestId();
    }

    return state;
  }

  function currentQuest() {
    var state = ensureState();
    return state ? findQuest(state.currentQuestId) : null;
  }

  function isCompleted(questId) {
    var state = ensureState();
    return Boolean(state) && state.completedQuestIds.indexOf(questId) !== -1;
  }

  function addMessage(text) {
    if (text && $gameMessage) $gameMessage.add(text);
  }

  function npcLabel(name, role) {
    if (!name) return '';
    return '\\c[4]' + name + (role ? ' \u2014 ' + role : '') + '\\c[0]';
  }

  function questGiverLabel(quest) {
    return quest && quest.npc ? npcLabel(quest.npc, quest.role) : '';
  }

  function objectiveResult(questId, objectiveId) {
    var state = ensureState();
    var questResults = state.objectiveResults[questId] || {};
    return questResults[objectiveId];
  }

  function refreshWorld() {
    if (window.K8sWorldStateEngine) window.K8sWorldStateEngine.refresh();
  }

  function showObjectives(quest) {
    if (!quest || !Array.isArray(quest.objectives)) return;

    quest.objectives.forEach(function (objective) {
      var result = objectiveResult(quest.id, objective.id);
      var marker =
        result && result.passed ? '\\c[3]\u2713\\c[0]' : '\\c[6]\u2022\\c[0]';
      addMessage(marker + ' ' + objective.text);
    });
  }

  function startQuest(questId) {
    var quest = findQuest(questId);
    var state = ensureState();

    if (!quest || !state) {
      addMessage('Quest data is not available.');
      return false;
    }

    state.currentQuestId = quest.id;
    if (state.startedQuestIds.indexOf(quest.id) === -1) {
      state.startedQuestIds.push(quest.id);
      addMessage('\\c[6]' + quest.title + '\\c[0]');
      if (quest.intro) addMessage(quest.intro);
    }
    showObjectives(quest);
    refreshWorld();
    return true;
  }

  function showStatus() {
    var quest = currentQuest();
    if (!quest) {
      addMessage('No Kubernetes quest is currently available.');
      return;
    }

    addMessage('\\c[6]Current Quest: ' + quest.title + '\\c[0]');
    if (quest.summary) addMessage(quest.summary);
    showObjectives(quest);
  }

  function setObjectiveResults(questId, objectives) {
    var state = ensureState();
    if (!state.objectiveResults[questId]) state.objectiveResults[questId] = {};

    (objectives || []).forEach(function (objective) {
      if (!objective || !objective.id) return;
      state.objectiveResults[questId][objective.id] = {
        passed: objective.passed === true,
        message: objective.message || '',
      };
    });
  }

  function completeQuest(questId, source) {
    var state = ensureState();
    var quest = findQuest(questId || state.currentQuestId);

    if (!quest) {
      addMessage('Cannot complete an unknown quest.');
      return false;
    }

    if (source !== 'validator' && !devMode) {
      addMessage(
        'Quest completion must be confirmed by the Kubernetes validator.',
      );
      return false;
    }

    if (state.completedQuestIds.indexOf(quest.id) === -1) {
      state.completedQuestIds.push(quest.id);
    }

    addMessage('\\c[3]Quest Complete: ' + quest.title + '\\c[0]');
    if (quest.success) addMessage(quest.success);

    if (quest.nextQuestId && findQuest(quest.nextQuestId)) {
      state.currentQuestId = quest.nextQuestId;
      var next = findQuest(quest.nextQuestId);
      if (next && next.npc) {
        addMessage('A new quest awaits. Speak with ' + next.npc + '.');
      } else {
        addMessage('A new quest has become available.');
      }
    } else {
      state.currentQuestId = null;
      addMessage('Chapter complete.');
    }
    refreshWorld();
    return true;
  }

  function applyValidationResult(result) {
    if (!result || !result.questId) {
      console.warn('K8sQuestEngine: invalid validation result', result);
      return false;
    }

    var quest = findQuest(result.questId);
    if (!quest) {
      console.warn('K8sQuestEngine: unknown quest', result.questId);
      return false;
    }

    var state = ensureState();

    if (isCompleted(result.questId)) {
      setObjectiveResults(result.questId, result.objectives || []);
      if (result.message) addMessage(result.message);
      refreshWorld();
      return true;
    }

    if (
      state &&
      state.currentQuestId &&
      result.questId !== state.currentQuestId
    ) {
      console.warn(
        'K8sQuestEngine: rejected out-of-order validation for ' +
          result.questId +
          ' (current quest is ' +
          state.currentQuestId +
          ')',
      );
      return false;
    }

    setObjectiveResults(result.questId, result.objectives || []);

    if (result.message) addMessage(result.message);
    if (result.completed === true) {
      return completeQuest(result.questId, 'validator');
    }

    showObjectives(quest);
    refreshWorld();
    return true;
  }

  function validatorAvailable() {
    return Boolean(
      window.K8sValidatorClient && window.K8sValidatorClient.isEnabled(),
    );
  }

  function showStatusWithHint(quest) {
    showStatus();
    if (quest && quest.hint) addMessage('Hint: ' + quest.hint);
  }

  function checkCurrentQuest() {
    var quest = currentQuest();
    if (!quest) {
      addMessage('No Kubernetes quest is currently available.');
      return;
    }
    if (validatorAvailable()) {
      window.K8sValidatorClient.checkQuest(quest.id, function () {
        showStatusWithHint(quest);
      });
    } else {
      showStatusWithHint(quest);
    }
  }

  function handleActiveQuest(quest, npcName) {
    var state = ensureState();
    var started = state.startedQuestIds.indexOf(quest.id) !== -1;

    addMessage(quest.npc ? questGiverLabel(quest) : npcLabel(npcName));

    if (!started) {
      startQuest(quest.id);
      return;
    }

    if (validatorAvailable()) {
      addMessage('Let me take a look at the cluster...');
      window.K8sValidatorClient.checkQuest(quest.id, function () {
        showStatusWithHint(quest);
      });
    } else {
      showStatusWithHint(quest);
    }
  }

  function interact(npcName) {
    var quest = currentQuest();
    var bound = questForNpc(npcName);

    if (bound) {
      if (isCompleted(bound.id)) {
        addMessage(questGiverLabel(bound));
        addMessage(bound.done || 'Thank you again for your help, hero.');
        if (quest && quest.npc && quest.id !== bound.id) {
          addMessage('I hear ' + quest.npc + ' could use a hand next.');
        }
        return;
      }

      if (quest && bound.id === quest.id) {
        handleActiveQuest(quest, npcName);
        return;
      }

      addMessage(questGiverLabel(bound));
      addMessage(
        bound.locked ||
          'I will need your help soon, but the village is not ready for that work yet.',
      );
      if (quest && quest.npc) {
        addMessage('For now, ' + quest.npc + ' is the one waiting for you.');
      }
      return;
    }

    if (!quest) {
      addMessage(npcLabel(npcName));
      addMessage('The village is peaceful for now. There are no new quests.');
      return;
    }

    if (!quest.npc) {
      handleActiveQuest(quest, npcName);
      return;
    }

    addMessage(npcLabel(npcName));
    addMessage(
      'Busy days in the village. If you are looking for work, talk to ' +
        quest.npc +
        '.',
    );
  }

  function resetState() {
    if (!devMode) {
      addMessage('Quest reset is only available with ?questDev=1.');
      return;
    }
    $gameSystem._k8sQuestState = null;
    ensureState();
    if (window.K8sWorldStateEngine) window.K8sWorldStateEngine.reset();
    addMessage('Kubernetes quest progress has been reset.');
  }

  var _Game_Interpreter_pluginCommand =
    Game_Interpreter.prototype.pluginCommand;
  Game_Interpreter.prototype.pluginCommand = function (command, args) {
    _Game_Interpreter_pluginCommand.call(this, command, args);
    if (command !== 'K8sQuest') return;

    var action = (args[0] || 'status').toLowerCase();
    var questId = args[1];

    if (action === 'status') showStatus();
    if (action === 'check') checkCurrentQuest();
    if (action === 'start') startQuest(questId || firstQuestId());
    if (action === 'complete') completeQuest(questId, 'dev');
    if (action === 'reset') resetState();
  };

  window.K8sQuestEngine = {
    applyValidationResult: applyValidationResult,
    checkCurrentQuest: checkCurrentQuest,
    completeQuest: function (questId) {
      return completeQuest(questId, 'validator');
    },
    currentQuest: currentQuest,
    interact: interact,
    isDevMode: function () {
      return devMode;
    },
    questForNpc: questForNpc,
    showStatus: showStatus,
    startQuest: startQuest,
  };
})();
