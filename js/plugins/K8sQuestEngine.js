/*:
 * @plugindesc Independent quest/progression engine for Kubernetes Isekai.
 * @author etg227
 *
 * @help
 * Loads game-side quest definitions from data/K8sQuests.json and keeps
 * quest progress in the normal RPG Maker save file.
 *
 * Plugin commands:
 *   K8sQuest status
 *   K8sQuest start <questId>
 *   K8sQuest complete [questId]   # dev mode only (?questDev=1)
 *   K8sQuest reset                # dev mode only (?questDev=1)
 *
 * A future Kubernetes validator should call:
 *   K8sQuestEngine.applyValidationResult({
 *     questId: 'village-01-namespace',
 *     completed: true,
 *     objectives: [{ id: 'namespace', passed: true }]
 *   });
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

  function addMessage(text) {
    if (text && $gameMessage) $gameMessage.add(text);
  }

  function objectiveResult(questId, objectiveId) {
    var state = ensureState();
    var questResults = state.objectiveResults[questId] || {};
    return questResults[objectiveId];
  }

  function showObjectives(quest) {
    if (!quest || !Array.isArray(quest.objectives)) return;

    quest.objectives.forEach(function (objective) {
      var result = objectiveResult(quest.id, objective.id);
      var marker = result && result.passed ? '\\c[3]✓\\c[0]' : '\\c[6]•\\c[0]';
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
      addMessage('Quest completion must be confirmed by the Kubernetes validator.');
      return false;
    }

    if (state.completedQuestIds.indexOf(quest.id) === -1) {
      state.completedQuestIds.push(quest.id);
    }

    addMessage('\\c[3]Quest Complete: ' + quest.title + '\\c[0]');
    if (quest.success) addMessage(quest.success);

    if (quest.nextQuestId && findQuest(quest.nextQuestId)) {
      state.currentQuestId = quest.nextQuestId;
      addMessage('A new quest has become available.');
    } else {
      state.currentQuestId = null;
      addMessage('Chapter complete.');
    }
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

    setObjectiveResults(result.questId, result.objectives || []);

    if (result.message) addMessage(result.message);
    if (result.completed === true) {
      return completeQuest(result.questId, 'validator');
    }

    showObjectives(quest);
    return true;
  }

  function interact(npcName) {
    var quest = currentQuest();
    if (!quest) {
      addMessage('The village is peaceful for now. There are no new quests.');
      return;
    }

    var state = ensureState();
    var started = state.startedQuestIds.indexOf(quest.id) !== -1;

    if (!started) {
      if (npcName) addMessage('\\c[4]' + npcName + '\\c[0]');
      startQuest(quest.id);
      return;
    }

    if (npcName) addMessage('\\c[4]' + npcName + '\\c[0]');
    showStatus();
    if (quest.hint) addMessage('Hint: ' + quest.hint);
  }

  function resetState() {
    if (!devMode) {
      addMessage('Quest reset is only available with ?questDev=1.');
      return;
    }
    $gameSystem._k8sQuestState = null;
    ensureState();
    addMessage('Kubernetes quest progress has been reset.');
  }

  var _Game_Interpreter_pluginCommand = Game_Interpreter.prototype.pluginCommand;
  Game_Interpreter.prototype.pluginCommand = function (command, args) {
    _Game_Interpreter_pluginCommand.call(this, command, args);
    if (command !== 'K8sQuest') return;

    var action = (args[0] || 'status').toLowerCase();
    var questId = args[1];

    if (action === 'status') showStatus();
    if (action === 'start') startQuest(questId || firstQuestId());
    if (action === 'complete') completeQuest(questId, 'dev');
    if (action === 'reset') resetState();
  };

  window.K8sQuestEngine = {
    applyValidationResult: applyValidationResult,
    completeQuest: function (questId) {
      return completeQuest(questId, 'validator');
    },
    currentQuest: currentQuest,
    interact: interact,
    isDevMode: function () {
      return devMode;
    },
    showStatus: showStatus,
    startQuest: startQuest,
  };
})();
