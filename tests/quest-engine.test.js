'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootQuestEngine } = require('./mv-sandbox');

const FIRST = 'village-01-namespace';
const SECOND = 'village-02-pod';

test('a new game starts with the first quest active and nothing started', () => {
  const game = bootQuestEngine();
  assert.equal(game.engine.currentQuest().id, FIRST);
  assert.deepEqual(Array.from(game.state().startedQuestIds), []);
  assert.deepEqual(Array.from(game.state().completedQuestIds), []);
});

test('the bound NPC starts their own quest on first interaction', () => {
  const game = bootQuestEngine();
  game.engine.interact('Vivian');
  assert.ok(game.state().startedQuestIds.includes(FIRST));
  assert.ok(game.messages.some((m) => m.includes('A Place to Rebuild')));
  assert.ok(game.messages.some((m) => m.includes('Quartermaster')));
});

test('NPC lookup ignores surrounding whitespace and case', () => {
  const game = bootQuestEngine();
  assert.equal(game.engine.questForNpc('Reno ').id, 'village-07-boss');
  assert.equal(game.engine.questForNpc('vivian').id, FIRST);
});

test('a future quest giver does not start their quest early', () => {
  const game = bootQuestEngine();
  game.engine.interact('Lena');
  assert.deepEqual(Array.from(game.state().startedQuestIds), []);
  assert.ok(game.messages.some((m) => m.includes('Vivian')));
});

test('an unbound NPC points the player to the current quest giver', () => {
  const game = bootQuestEngine();
  game.engine.interact('Stella');
  assert.deepEqual(Array.from(game.state().startedQuestIds), []);
  assert.ok(game.messages.some((m) => m.includes('talk to Vivian')));
});

test('a validator result completes the current quest and advances the story', () => {
  const game = bootQuestEngine();
  game.engine.interact('Vivian');
  const ok = game.engine.applyValidationResult({
    questId: FIRST,
    completed: true,
    objectives: [{ id: 'namespace', passed: true }],
  });
  assert.equal(ok, true);
  assert.ok(game.state().completedQuestIds.includes(FIRST));
  assert.equal(game.state().currentQuestId, SECOND);
  assert.ok(game.messages.some((m) => m.includes('Tek')));
});

test('out-of-order validation results are rejected', () => {
  const game = bootQuestEngine();
  const ok = game.engine.applyValidationResult({
    questId: 'village-03-deployment',
    completed: true,
    objectives: [{ id: 'deployment', passed: true }],
  });
  assert.equal(ok, false);
  assert.deepEqual(Array.from(game.state().completedQuestIds), []);
  assert.equal(game.state().currentQuestId, FIRST);
});

test('a partial validator result records objective progress without completing', () => {
  const game = bootQuestEngine();
  game.engine.applyValidationResult({
    questId: FIRST,
    completed: true,
    objectives: [{ id: 'namespace', passed: true }],
  });
  game.messages.length = 0;

  const ok = game.engine.applyValidationResult({
    questId: SECOND,
    completed: false,
    objectives: [
      { id: 'pod', passed: true },
      { id: 'port', passed: false, message: 'Port 80 is not exposed.' },
    ],
  });
  assert.equal(ok, true);
  assert.ok(!game.state().completedQuestIds.includes(SECOND));
  assert.equal(game.state().objectiveResults[SECOND].pod.passed, true);
  assert.equal(game.state().objectiveResults[SECOND].port.passed, false);
  assert.ok(game.messages.some((m) => m.includes('✓')));
});

test('manual completion is blocked outside dev mode', () => {
  const game = bootQuestEngine();
  game.runPluginCommand('K8sQuest', ['complete']);
  assert.deepEqual(Array.from(game.state().completedQuestIds), []);
  assert.ok(game.messages.some((m) => m.includes('validator')));
});

test('dev mode allows manual completion and reset', () => {
  const game = bootQuestEngine({ search: '?questDev=1' });
  game.runPluginCommand('K8sQuest', ['complete']);
  assert.ok(game.state().completedQuestIds.includes(FIRST));

  game.runPluginCommand('K8sQuest', ['reset']);
  assert.deepEqual(Array.from(game.state().completedQuestIds), []);
  assert.equal(game.state().currentQuestId, FIRST);
});

test('a completed quest giver thanks the player and points onwards', () => {
  const game = bootQuestEngine();
  game.engine.applyValidationResult({
    questId: FIRST,
    completed: true,
    objectives: [{ id: 'namespace', passed: true }],
  });
  game.messages.length = 0;

  game.engine.interact('Vivian');
  assert.ok(game.messages.some((m) => m.includes('district you founded')));
  assert.ok(game.messages.some((m) => m.includes('Tek')));
});

test('re-validating an already completed quest does not complete it twice', () => {
  const game = bootQuestEngine();
  const result = {
    questId: FIRST,
    completed: true,
    objectives: [{ id: 'namespace', passed: true }],
  };
  game.engine.applyValidationResult(result);
  game.engine.applyValidationResult(result);
  assert.deepEqual(Array.from(game.state().completedQuestIds), [FIRST]);
  assert.equal(game.state().currentQuestId, SECOND);
});
