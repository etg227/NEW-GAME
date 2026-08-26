/*:
 * @plugindesc Maps Kubernetes quest state onto the RPG world (switches, weather, BGM).
 * @author etg227
 *
 * @help
 * Reads effect definitions from data/K8sWorldEffects.json and quest
 * progress from K8sQuestEngine's save state, then applies the resulting
 * world effects. Effects are recomputed (idempotently) whenever quest
 * state changes and when a map starts, so loaded saves always show the
 * correct world.
 *
 * Quests declare effects per phase in data/K8sQuests.json:
 *
 *   "worldEffects": {
 *     "started":   ["storm_on"],
 *     "partial":   ["inn_dim"],
 *     "completed": ["storm_off", "village_restored"]
 *   }
 *
 * Phases are cumulative: a completed quest applies its started and
 * partial effects first, then its completed effects, so a completed
 * phase can override an earlier one (e.g. storm_off after storm_on).
 *
 * Effect actions supported in K8sWorldEffects.json:
 *   "switch":  { "id": 11, "value": true }
 *   "weather": { "type": "storm", "power": 7, "duration": 0 }
 *   "bgm":     { "name": "Theme1", "volume": 90, "pitch": 100 }
 *
 * Visible map changes (lit lamps, opened roads, extra villagers) are
 * wired in the RPG Maker editor: give the event a second page whose
 * condition is the effect's switch.
 */

(function () {
  'use strict';

  var DATA_NAME = '$dataK8sWorldEffects';
  var DATA_FILE = 'K8sWorldEffects.json';

  DataManager._databaseFiles.push({ name: DATA_NAME, src: DATA_FILE });

  var PHASE_ORDER = ['started', 'partial', 'completed'];

  function effectDefs() {
    return (window[DATA_NAME] && window[DATA_NAME].effects) || {};
  }

  function questList() {
    return (window.$dataK8sQuests && window.$dataK8sQuests.quests) || [];
  }

  function questState() {
    return $gameSystem ? $gameSystem._k8sQuestState : null;
  }

  function applyAction(def) {
    if (!def) return;
    if (def.switch && window.$gameSwitches) {
      $gameSwitches.setValue(def.switch.id, def.switch.value !== false);
    }
    if (def.weather && window.$gameScreen) {
      $gameScreen.changeWeather(
        def.weather.type || 'none',
        def.weather.power || 0,
        def.weather.duration || 0,
      );
    }
    if (def.bgm && window.AudioManager) {
      AudioManager.playBgm({
        name: def.bgm.name,
        volume: def.bgm.volume !== undefined ? def.bgm.volume : 90,
        pitch: def.bgm.pitch !== undefined ? def.bgm.pitch : 100,
        pan: 0,
      });
    }
  }

  function applyEffects(names) {
    (names || []).forEach(function (name) {
      var def = effectDefs()[name];
      if (!def) {
        console.warn('K8sWorldStateEngine: unknown effect "' + name + '"');
        return;
      }
      applyAction(def);
    });
  }

  function questPhase(quest, state) {
    if (state.completedQuestIds.indexOf(quest.id) !== -1) return 'completed';
    var results = state.objectiveResults[quest.id];
    var anyPassed =
      results &&
      Object.keys(results).some(function (key) {
        return results[key] && results[key].passed;
      });
    if (anyPassed) return 'partial';
    if (state.startedQuestIds.indexOf(quest.id) !== -1) return 'started';
    return null;
  }

  // Recomputes every world effect from quest state. Idempotent: safe to
  // call on every map start and after every quest state change.
  function refresh() {
    var state = questState();
    if (!state) return;

    questList().forEach(function (quest) {
      var effects = quest.worldEffects;
      if (!effects) return;
      var phase = questPhase(quest, state);
      if (!phase) return;

      var upTo = PHASE_ORDER.indexOf(phase);
      for (var i = 0; i <= upTo; i++) {
        applyEffects(effects[PHASE_ORDER[i]]);
      }
    });
  }

  // Clears every switch mentioned by any effect and stops weather, then
  // reapplies from quest state. Used by the dev-mode quest reset.
  function reset() {
    var defs = effectDefs();
    Object.keys(defs).forEach(function (name) {
      var def = defs[name];
      if (def.switch && window.$gameSwitches) {
        $gameSwitches.setValue(def.switch.id, false);
      }
    });
    if (window.$gameScreen) $gameScreen.changeWeather('none', 0, 0);
    refresh();
  }

  if (window.Scene_Map) {
    var _Scene_Map_start = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function () {
      _Scene_Map_start.call(this);
      refresh();
    };
  }

  window.K8sWorldStateEngine = {
    applyEffects: applyEffects,
    refresh: refresh,
    reset: reset,
  };
})();
