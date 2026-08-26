'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const pluginCode = fs.readFileSync(
  path.join(ROOT, 'js', 'plugins', 'K8sVillageDirector.js'),
  'utf8',
);
const sceneData = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'K8sVillageScenes.json'), 'utf8'),
);

function boot() {
  const events = {};
  for (let id = 1; id <= 20; id += 1) {
    events[id] = {
      _eventId: id,
      _mapId: 8,
      transparent: false,
      stepAnime: false,
      moveSpeed: 3,
      _moveType: 0,
      setTransparent(value) {
        this.transparent = value;
      },
      setStepAnime(value) {
        this.stepAnime = value;
      },
      setMoveSpeed(value) {
        this.moveSpeed = value;
      },
    };
  }

  function GameMap() {}
  GameMap.prototype.setup = function (mapId) {
    this._mapId = mapId;
  };

  function GameEvent() {}
  GameEvent.prototype.start = function () {
    this.started = true;
  };

  const sandbox = {
    window: null,
    console,
    DataManager: { _databaseFiles: [] },
    Game_Map: GameMap,
    Game_Event: GameEvent,
    AudioManager: { playSe() {} },
    $dataK8sVillageScenes: sceneData,
    $dataK8sQuests: {
      quests: ['q1', 'q2', 'q3'].map((id) => ({ id })),
    },
    $gameSwitches: {
      values: {},
      value(id) {
        return !!this.values[id];
      },
    },
    $gameSystem: {
      _k8sQuestState: {
        currentQuestId: 'q1',
        completedQuestIds: [],
      },
    },
    $gameMessage: { add() {}, isBusy() { return false; } },
    $gameMap: {
      _mapId: 8,
      mapId() {
        return this._mapId;
      },
      event(id) {
        return events[id];
      },
    },
    K8sWorldStateEngine: { refresh() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(pluginCode, sandbox, { filename: 'K8sVillageDirector.js' });
  return { sandbox, events };
}

test('Chapter 1 inn population and flames follow world-state switches', () => {
  const { sandbox, events } = boot();
  sandbox.K8sVillageDirector.refresh();
  assert.equal(events[1].transparent, true);
  assert.equal(events[8].transparent, true);
  assert.equal(events[7].transparent, false);

  sandbox.$gameSwitches.values[11] = true;
  sandbox.K8sVillageDirector.refresh();
  assert.equal(events[8].transparent, false);
  assert.equal(events[12].transparent, true);

  sandbox.$gameSwitches.values[12] = true;
  sandbox.K8sVillageDirector.refresh();
  assert.equal(events[1].transparent, false);
  assert.equal(events[2].transparent, false);
  assert.equal(events[12].transparent, false);
});

test('scaling brings back a moving villager and restoration animates the room', () => {
  const { sandbox, events } = boot();
  sandbox.$gameSwitches.values[14] = true;
  sandbox.K8sVillageDirector.refresh();
  assert.equal(events[6].transparent, false);
  assert.equal(events[6]._moveType, 1);

  sandbox.$gameSwitches.values[17] = true;
  sandbox.K8sVillageDirector.refresh();
  for (const id of [4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    assert.equal(events[id].stepAnime, true);
  }
});

test('Map003 forest exits stay blocked until the Service route is restored', () => {
  const { sandbox } = boot();
  sandbox.$gameMap._mapId = 3;
  for (const id of [4, 5, 6]) {
    assert.equal(sandbox.K8sVillageDirector.shouldBlockEvent(3, id), true);
  }
  assert.equal(sandbox.K8sVillageDirector.shouldBlockEvent(3, 3), false);

  sandbox.$gameSwitches.values[15] = true;
  assert.equal(sandbox.K8sVillageDirector.shouldBlockEvent(3, 4), false);
});

test('fully completed Chapter 1 remains complete instead of restarting quest one', () => {
  const { sandbox } = boot();
  sandbox.$gameSystem._k8sQuestState.completedQuestIds = ['q1', 'q2', 'q3'];
  sandbox.$gameSystem._k8sQuestState.currentQuestId = null;
  assert.equal(sandbox.K8sVillageDirector.sealCompletedChapter(), true);
  assert.equal(sandbox.$gameSystem._k8sQuestState.chapterCompleted, true);
  assert.equal(
    sandbox.$gameSystem._k8sQuestState.currentQuestId,
    '__k8s_chapter_01_complete__',
  );
});
