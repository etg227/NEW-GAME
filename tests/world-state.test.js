'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootQuestEngine } = require('./mv-sandbox');

const SWITCH = {
  villageFounded: 11,
  innLit: 12,
  roadOpen: 15,
  villageRestored: 17,
  stormActive: 18,
};

function completeCurrent(game) {
  game.runPluginCommand('K8sQuest', ['complete']);
}

test('completing a quest flips its world switch', () => {
  const game = bootQuestEngine();
  game.engine.applyValidationResult({
    questId: 'village-01-namespace',
    completed: true,
    objectives: [{ id: 'namespace', passed: true }],
  });
  assert.equal(game.switches.value(SWITCH.villageFounded), true);
  assert.equal(game.switches.value(SWITCH.innLit), false);
});

test('starting the boss quest raises the storm; completing it clears the sky', () => {
  const game = bootQuestEngine({ search: '?questDev=1' });
  for (let i = 0; i < 6; i++) completeCurrent(game);
  assert.equal(game.engine.currentQuest().id, 'village-07-boss');
  assert.equal(game.switches.value(SWITCH.stormActive), false);

  game.engine.interact('Reno');
  assert.equal(game.switches.value(SWITCH.stormActive), true);
  const stormCall = game.screen.weatherCalls.at(-1);
  assert.equal(stormCall.type, 'storm');
  assert.ok(stormCall.power > 0);

  completeCurrent(game);
  assert.equal(game.switches.value(SWITCH.stormActive), false);
  assert.equal(game.switches.value(SWITCH.villageRestored), true);
  assert.equal(game.screen.weatherCalls.at(-1).type, 'none');
});

test('refresh rebuilds world state from save data (idempotent)', () => {
  const game = bootQuestEngine({ search: '?questDev=1' });
  for (let i = 0; i < 5; i++) completeCurrent(game);

  // Simulate a fresh session that just loaded this save: switches empty.
  game.switches._values = {};
  game.world.refresh();
  assert.equal(game.switches.value(SWITCH.villageFounded), true);
  assert.equal(game.switches.value(SWITCH.roadOpen), true);
  assert.equal(game.switches.value(SWITCH.villageRestored), false);
});

test('dev-mode quest reset clears every world effect', () => {
  const game = bootQuestEngine({ search: '?questDev=1' });
  for (let i = 0; i < 7; i++) completeCurrent(game);
  assert.equal(game.switches.value(SWITCH.villageRestored), true);

  game.runPluginCommand('K8sQuest', ['reset']);
  for (const id of Object.values(SWITCH)) {
    assert.equal(game.switches.value(id), false, `switch ${id} should clear`);
  }
  assert.equal(game.screen.weatherCalls.at(-1).type, 'none');
});

test('a partial validator result applies partial-phase effects', () => {
  const game = bootQuestEngine();
  // Give the first quest a synthetic partial effect to exercise the phase.
  const quest = game.sandbox.$dataK8sQuests.quests[0];
  quest.worldEffects = {
    partial: ['inn_lit'],
    completed: ['village_founded'],
  };

  game.engine.applyValidationResult({
    questId: 'village-01-namespace',
    completed: false,
    objectives: [{ id: 'namespace', passed: true }],
  });
  assert.equal(game.switches.value(SWITCH.innLit), true);
  assert.equal(game.switches.value(SWITCH.villageFounded), false);
});

test('unknown effect names warn without crashing', () => {
  const game = bootQuestEngine();
  assert.doesNotThrow(() => game.world.applyEffects(['no_such_effect']));
});
