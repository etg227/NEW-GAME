/*:
 * @plugindesc Chapter 1 village presentation director for Kubernetes Isekai.
 * @author etg227
 *
 * @help
 * Turns the abstract world-state switches produced by K8sWorldStateEngine
 * into visible Chapter 1 changes without coupling Kubernetes validation to
 * a specific map layout.
 *
 * Rules live in data/K8sVillageScenes.json. The first pass makes the current
 * maps visibly recover as the real cluster recovers:
 *   - future quest NPCs return to the inn one stage at a time;
 *   - the inn flames light after the Pod is Ready;
 *   - a returning villager starts walking after the Deployment scales;
 *   - the outdoor forest exits stay blocked until the Service route exists;
 *   - the village enters a lively celebration state after the boss quest.
 *
 * Because this layer only consumes RPG Maker switches, the maps and artwork
 * can be replaced later without changing the Kubernetes quest engine.
 */

(function () {
  'use strict';

  var DATA_NAME = '$dataK8sVillageScenes';
  var DATA_FILE = 'K8sVillageScenes.json';
  var CHAPTER_DONE_SENTINEL = '__k8s_chapter_01_complete__';

  DataManager._databaseFiles.push({ name: DATA_NAME, src: DATA_FILE });

  function data() {
    return window[DATA_NAME] || { maps: {} };
  }

  function mapRules(mapId) {
    return (data().maps || {})[String(mapId)] || null;
  }

  function switchValue(id) {
    return Boolean(window.$gameSwitches && $gameSwitches.value(Number(id)));
  }

  function eventById(eventId) {
    if (!window.$gameMap || !$gameMap.event) return null;
    return $gameMap.event(Number(eventId));
  }

  function setVisible(event, visible) {
    if (!event || !event.setTransparent) return;
    event.setTransparent(!visible);
  }

  function applyVisibility(rules) {
    (rules || []).forEach(function (rule) {
      setVisible(eventById(rule.eventId), switchValue(rule.switchId));
    });
  }

  function applyWander(rules) {
    (rules || []).forEach(function (rule) {
      var event = eventById(rule.eventId);
      if (!event) return;
      var active = switchValue(rule.switchId);
      event._moveType = active ? 1 : 0;
      if (active && event.setMoveSpeed && rule.moveSpeed) {
        event.setMoveSpeed(Number(rule.moveSpeed));
      }
    });
  }

  function applyCelebration(rule) {
    if (!rule) return;
    var active = switchValue(rule.switchId);
    (rule.eventIds || []).forEach(function (eventId) {
      var event = eventById(eventId);
      if (event && event.setStepAnime) event.setStepAnime(active);
    });
  }

  // Older saves (and the v1 quest engine) can end Chapter 1 with a null
  // currentQuestId, which v1 then interprets as "start the first quest" on
  // the next interaction. Seal a fully completed chapter with a truthy,
  // non-quest sentinel so currentQuest() correctly stays null.
  function sealCompletedChapter() {
    if (!window.$gameSystem || !$gameSystem._k8sQuestState) return false;
    var state = $gameSystem._k8sQuestState;
    var quests =
      window.$dataK8sQuests && Array.isArray($dataK8sQuests.quests)
        ? $dataK8sQuests.quests
        : [];
    if (!quests.length) return false;

    var completed = state.completedQuestIds || [];
    var allDone = quests.every(function (quest) {
      return completed.indexOf(quest.id) !== -1;
    });
    if (!allDone) return false;

    state.chapterCompleted = true;
    state.currentQuestId = CHAPTER_DONE_SENTINEL;
    return true;
  }

  function refresh() {
    sealCompletedChapter();
    if (!window.$gameMap || !$gameMap.mapId) return;
    var rules = mapRules($gameMap.mapId());
    if (!rules) return;
    applyVisibility(rules.visibility);
    applyWander(rules.wander);
    applyCelebration(rules.celebrate);
  }

  function blockedRule(mapId, eventId) {
    var rules = mapRules(mapId);
    if (!rules) return null;
    var groups = rules.blockedEvents || [];
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      if (
        (group.eventIds || []).indexOf(Number(eventId)) !== -1 &&
        !switchValue(group.untilSwitchId)
      ) {
        return group;
      }
    }
    return null;
  }

  function shouldBlockEvent(mapId, eventId) {
    return Boolean(blockedRule(mapId, eventId));
  }

  function showBlockedMessage(event, rule) {
    if (!rule || event._k8sBlockedNoticeShown) return;
    event._k8sBlockedNoticeShown = true;
    if (window.$gameMessage && (!$gameMessage.isBusy || !$gameMessage.isBusy())) {
      $gameMessage.add(rule.message || 'That route is not open yet.');
    }
    if (window.AudioManager && AudioManager.playSe) {
      AudioManager.playSe({ name: 'Buzzer1', volume: 70, pitch: 100, pan: 0 });
    }
  }

  // Refresh after map setup so loaded saves immediately render the right
  // village phase before the player starts moving.
  if (window.Game_Map) {
    var _Game_Map_setup = Game_Map.prototype.setup;
    Game_Map.prototype.setup = function (mapId) {
      _Game_Map_setup.call(this, mapId);
      refresh();
    };
  }

  // Player-touch transfer events are used for the three forest exits on
  // Map003. Intercept only the configured event IDs; all other map events
  // retain their original RPG Maker behaviour.
  if (window.Game_Event) {
    var _Game_Event_start = Game_Event.prototype.start;
    Game_Event.prototype.start = function () {
      var rule = blockedRule(this._mapId, this._eventId);
      if (rule) {
        showBlockedMessage(this, rule);
        return;
      }
      this._k8sBlockedNoticeShown = false;
      _Game_Event_start.call(this);
    };
  }

  // QuestEngine calls WorldStateEngine.refresh() after every accepted
  // validator result. Wrap it once so visible map changes happen in the
  // same frame as the switch changes, rather than only after re-entering.
  if (window.K8sWorldStateEngine && window.K8sWorldStateEngine.refresh) {
    var _worldRefresh = window.K8sWorldStateEngine.refresh;
    window.K8sWorldStateEngine.refresh = function () {
      _worldRefresh.apply(this, arguments);
      refresh();
    };
  }

  window.K8sVillageDirector = {
    blockedRule: blockedRule,
    mapRules: mapRules,
    refresh: refresh,
    sealCompletedChapter: sealCompletedChapter,
    shouldBlockEvent: shouldBlockEvent,
  };
})();
