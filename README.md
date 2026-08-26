# Kubernetes Isekai

An RPG where the dungeon is a real Kubernetes cluster. NPCs hand out quests, the player answers them with `kubectl`, and the story only moves forward once the cluster actually reaches the requested state.

Built with RPG Maker MV. Runs fully independently: the repository contains the game client, the quest engine and a local validator that inspects the cluster — no external grading backend required.

## Quick start

Requirements: Node.js, `kubectl` configured against any cluster you are allowed to play in (minikube, kind, k3d all work).

```bash
node validator/server.js
# then open http://localhost:8787/
```

The sidecar serves the game and validates quests against the cluster through your local kubeconfig. Talk to a quest NPC after doing the work in the cluster and they will check it for you, or use the `K8sQuest check` plugin command.

To try the story without a cluster, open the game with `?questDev=1` and use the dev plugin commands below.

## How it plays

Kubernetes is part of the world, not a quiz inside an RPG shell:

| Cluster concept  | In the world                        |
| ---------------- | ----------------------------------- |
| Cluster          | the world / kingdom                 |
| Namespace        | a district or region                |
| Pod              | a worker, building or creature      |
| Deployment       | a managed guild or service          |
| Service          | a stable road or portal             |
| ConfigMap        | a public ledger / spellbook         |
| Secret           | a sealed record                     |
| Scaling          | reinforcements                      |
| CrashLoopBackOff | a recurring curse                   |

### Chapter 1 — The Broken Village

Each quest belongs to one NPC in the village. Everyone else will point you to whoever needs you next.

| # | Quest                         | Quest giver            | Teaches                    |
| - | ----------------------------- | ---------------------- | -------------------------- |
| 1 | A Place to Rebuild            | Vivian, Quartermaster  | Namespaces                 |
| 2 | Light the First Lantern       | Tek, Innkeeper         | Pods and container ports   |
| 3 | Build Something That Survives | Noah, Engineer         | Deployments                |
| 4 | The Night Rush                | Maya, Inn Steward      | Scaling                    |
| 5 | Open the Road                 | Carl, Roadwright       | Services                   |
| 6 | The Missing Ledger            | Lena, Archivist        | ConfigMaps                 |
| 7 | Boss: Restore the Village     | Reno, Village Chief    | Real health: ready replicas, Service routing + endpoints, consuming the ConfigMap |

Quest progress feeds back into the world: completing a quest flips its world switch (lights, roads, celebration), and the boss quest literally starts a storm that only clears when the whole stack is healthy. See **World effects** below.

## Architecture

```text
RPG Maker MV game (browser)
    |
    +-- K8sQuestEngine ......... story, quest state in save data,
    |                            validation-result contract
    +-- K8sWorldStateEngine .... maps quest state to switches/weather/BGM
    +-- K8sValidatorClient ..... fetches results from the sidecar
    +-- NpcK8sPluginCommand .... NPC bridge; legacy backend compatibility
    |
    v  HTTP (same origin by default)
validator/server.js (Node, zero dependencies)
    |
    v  kubectl (local kubeconfig)
Kubernetes cluster
```

Game progression is owned by the game itself. The validator only reports a small result contract, so the checking side can be replaced without touching maps or NPC events:

```js
K8sQuestEngine.applyValidationResult({
  questId: 'village-04-scale',
  completed: true,
  state: 'completed', // 'pending' | 'partial' | 'completed'
  objectives: [{ id: 'replicas', passed: true }],
});
```

Results are only accepted for the quest that is currently active — an external component cannot complete the story out of order. Quest progress is stored in normal RPG Maker save files.

### World effects

Quests declare what their progress does to the world in `data/K8sQuests.json`:

```json
"worldEffects": {
  "started": ["storm_on"],
  "partial": ["inn_dim"],
  "completed": ["storm_off", "village_restored"]
}
```

`js/plugins/K8sWorldStateEngine.js` recomputes these effects from quest state — idempotently, on every state change and map start, so loaded saves always show the right world. Effect names map to concrete RPG Maker actions in `data/K8sWorldEffects.json` (game switches, weather, BGM). Phases are cumulative, so a quest's `completed` effects can override its `started` ones — that is how the boss storm clears.

Switches 11–18 are reserved for Kubernetes world state (named in the editor):

| Switch | Meaning              | Set by quest              |
| ------ | -------------------- | ------------------------- |
| 11     | Village Founded      | village-01-namespace      |
| 12     | Inn Lit              | village-02-pod            |
| 13     | Inn Managed          | village-03-deployment     |
| 14     | Inn Scaled           | village-04-scale          |
| 15     | Road Open            | village-05-service        |
| 16     | Ledger Restored      | village-06-config         |
| 17     | Village Restored     | village-07-boss           |
| 18     | Storm Active         | village-07-boss (started) |

To make a map react (a lamp lights, villagers appear, a road opens), give the event a second page in the RPG Maker editor whose page condition is the matching switch — no plugin code needed. Weather and BGM are driven directly by the engine.

### Quest definitions

Quests live in `data/K8sQuests.json`. Objectives declare what to check, declaratively:

```json
{
  "id": "replicas",
  "text": "Scale the inn Deployment to 3 replicas.",
  "validator": {
    "type": "deployment_replicas",
    "namespace": "village",
    "name": "inn",
    "count": 3
  }
}
```

The sidecar and the game read the same file, so story and validation cannot drift apart.

### Validator sidecar

`validator/server.js` needs only Node and `kubectl`:

```bash
node validator/server.js [--port 8787] [--host 127.0.0.1] [--kubectl /path/to/kubectl] [--api-only] [--allow-origin <origin>]...
```

Security defaults: the server binds to `127.0.0.1` only, and cross-origin API calls are accepted solely from loopback origins (`localhost` / `127.0.0.1` on any port). Pass `--host 0.0.0.0` only when you deliberately want other machines to reach it, and `--allow-origin` to whitelist additional origins — e.g. `--allow-origin null` if you open the game straight from disk via `file://` instead of letting the sidecar serve it.

| Endpoint                        | Purpose                                  |
| ------------------------------- | ---------------------------------------- |
| `GET /api/health`               | liveness check                           |
| `GET /api/quests`               | quest definitions                        |
| `GET /api/validate?questId=…`   | run the quest's checks, return contract  |
| `POST /api/reset/<chapterId>`   | delete the chapter's namespaces          |
| `GET /`                         | the game itself (unless `--api-only`)    |

Supported validator types:

| Type | Checks |
| ---- | ------ |
| `namespace_exists` | namespace is present |
| `pod_exists` | Pod present, optionally running a given image |
| `pod_ready` | Pod condition `Ready=True` |
| `container_port` | a container on the Pod exposes the port |
| `deployment_exists` | Deployment present, optionally with image |
| `deployment_replicas` | desired replica count matches |
| `deployment_ready_replicas` | `status.readyReplicas` matches |
| `deployment_available` | condition `Available=True` |
| `deployment_uses_configmap` | template consumes the ConfigMap via `envFrom`, `env valueFrom` or a volume |
| `service_exists` | Service present with port/selector value |
| `service_routes_to_deployment` | every selector entry matches the Deployment's Pod template labels |
| `service_has_ready_endpoints` | the Service's Endpoints have ready addresses |
| `configmap_value` | ConfigMap holds `key=value` |

### Resetting between playthroughs

```bash
npm run reset             # or: node validator/reset.js --dry-run
```

Deletes only the namespaces the chapter's quest validators reference (for Chapter 1: `namespace/village`, which takes the pod, deployment, service and configmap with it). The same operation is available as `POST /api/reset/chapter-01`. The deletion list is derived strictly from `data/K8sQuests.json` — the endpoint takes no resource names from the request, so it cannot be used as a generic kubectl proxy. In-game progress is reset separately with `?questDev=1` + `K8sQuest reset`. (Roadmap: label game-managed resources with `k8s-isekai.io/managed` so cleanup can be label-scoped once quests span shared namespaces.)

The kubeconfig never reaches the browser; the game only ever sees pass/fail results.

## Running modes

| Mode        | How                                          | Validation source        |
| ----------- | -------------------------------------------- | ------------------------ |
| Independent | `node validator/server.js`, open the game    | local validator sidecar  |
| Dev/story   | open with `?questDev=1`                      | manual plugin commands   |
| Legacy      | open with `?baseUrl=…&apiKey=…&game=…`       | original grader backend  |

Useful URL parameters: `validatorUrl=<url>` points the game at a validator on another origin; `validator=0` disables cluster validation.

Dev plugin commands (Event > Plugin Command):

```text
K8sQuest status
K8sQuest check
K8sQuest start <questId>
K8sQuest complete [questId]   # dev mode only
K8sQuest reset                # dev mode only
```

## Development

```bash
npm test          # unit tests for quest engine, text wrapping and validators
npm run validator # start the sidecar
```

Tests run on Node's built-in test runner with a small RPG Maker stub (`tests/mv-sandbox.js`) — no cluster and no browser needed.

Project layout:

```text
data/K8sQuests.json            quest, validator and world-effect definitions
data/K8sWorldEffects.json      effect name -> switch/weather/BGM mapping
js/plugins/K8sQuestEngine.js   quest state machine and NPC routing
js/plugins/K8sWorldStateEngine.js quest state -> world state
js/plugins/K8sValidatorClient.js  HTTP client for the sidecar
js/plugins/NpcK8sPluginCommand.js NPC bridge + legacy compatibility
validator/server.js            independent Kubernetes validator
validator/reset.js             safe chapter cleanup (npm run reset)
tests/                         unit tests
python_tools/                  content-generation notebooks
design/character_generator/    RPG Maker character generator presets
```

## Origins

This project grew out of a team academic project (Higher Diploma in Cloud and Data Centre Administration). The game client — maps, events, characters and story world — was built by the student team. It originally connected to an AWS SAM grading backend with Kubernetes test rules, developed separately under supervisor guidance:

- Grader/backend: https://github.com/wongcyrus/k8s-grader
- Kubernetes game rules: https://github.com/wongcyrus/k8s-game-rule

This repository continues the team's game client and extends it with an independent quest engine and local validator, so the game now runs without that backend. The legacy mode is kept so the original prototype can still be demonstrated.
