'use strict';

// Minimal RPG Maker MV runtime stub, just enough to load the K8s plugins
// inside a Node `vm` context for unit testing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLUGIN_DIR = path.join(__dirname, '..', 'js', 'plugins');
const QUESTS_FILE = path.join(__dirname, '..', 'data', 'K8sQuests.json');
const EFFECTS_FILE = path.join(__dirname, '..', 'data', 'K8sWorldEffects.json');

function createSandbox({ search = '' } = {}) {
  const messages = [];
  const sandbox = {};

  sandbox.window = sandbox;
  sandbox.console = { log() {}, warn() {}, error() {} };
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.location = { search, protocol: 'http:' };

  sandbox.Game_System = function Game_System() {};
  sandbox.Game_System.prototype.initialize = function () {};

  sandbox.Game_Interpreter = function Game_Interpreter() {};
  sandbox.Game_Interpreter.prototype.pluginCommand = function () {};

  sandbox.DataManager = { _databaseFiles: [] };
  sandbox.$gameMessage = {
    add(text) {
      messages.push(text);
    },
  };
  sandbox.$gameSwitches = {
    _values: {},
    setValue(id, value) {
      this._values[id] = value;
    },
    value(id) {
      return !!this._values[id];
    },
  };
  sandbox.$gameScreen = {
    weatherCalls: [],
    changeWeather(type, power, duration) {
      this.weatherCalls.push({ type, power, duration });
    },
  };
  sandbox.AudioManager = {
    bgmCalls: [],
    playBgm(args) {
      this.bgmCalls.push(args);
    },
  };

  vm.createContext(sandbox);
  return { sandbox, messages };
}

function loadPlugin(sandbox, fileName) {
  const code = fs.readFileSync(path.join(PLUGIN_DIR, fileName), 'utf8');
  vm.runInContext(code, sandbox, { filename: fileName });
}

function loadQuestData() {
  return JSON.parse(fs.readFileSync(QUESTS_FILE, 'utf8'));
}

function loadEffectData() {
  return JSON.parse(fs.readFileSync(EFFECTS_FILE, 'utf8'));
}

// Boots a sandbox with the quest and world-state engines loaded, data
// injected and a fresh $gameSystem, mirroring what
// DataManager.createGameObjects produces.
function bootQuestEngine({ search = '' } = {}) {
  const { sandbox, messages } = createSandbox({ search });
  loadPlugin(sandbox, 'K8sQuestEngine.js');
  loadPlugin(sandbox, 'K8sWorldStateEngine.js');
  sandbox.$dataK8sQuests = loadQuestData();
  sandbox.$dataK8sWorldEffects = loadEffectData();
  sandbox.$gameSystem = new sandbox.Game_System();
  sandbox.$gameSystem.initialize();
  return {
    sandbox,
    messages,
    engine: sandbox.K8sQuestEngine,
    world: sandbox.K8sWorldStateEngine,
    switches: sandbox.$gameSwitches,
    screen: sandbox.$gameScreen,
    state: () => sandbox.$gameSystem._k8sQuestState,
    runPluginCommand(command, args) {
      const interpreter = new sandbox.Game_Interpreter();
      interpreter.pluginCommand(command, args);
    },
  };
}

module.exports = {
  bootQuestEngine,
  createSandbox,
  loadEffectData,
  loadPlugin,
  loadQuestData,
};
