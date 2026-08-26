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
| 7 | Boss: Restore the Village     | Reno, Village Chief    | Integrated health check    |

## Architecture

```text
RPG Maker MV game (browser)
    |
    +-- K8sQuestEngine ......... story, quest state in save data,
    |                            validation-result contract
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
  objectives: [{ id: 'replicas', passed: true }],
});
```

Results are only accepted for the quest that is currently active — an external component cannot complete the story out of order. Quest progress is stored in normal RPG Maker save files.

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
node validator/server.js [--port 8787] [--kubectl /path/to/kubectl] [--api-only]
```

| Endpoint                       | Purpose                                  |
| ------------------------------ | ---------------------------------------- |
| `GET /api/health`              | liveness check                           |
| `GET /api/quests`              | quest definitions                        |
| `GET /api/validate?questId=…`  | run the quest's checks, return contract  |
| `GET /`                        | the game itself (unless `--api-only`)    |

Supported validator types: `namespace_exists`, `pod_exists`, `container_port`, `deployment_exists`, `deployment_replicas`, `deployment_ready_replicas`, `service_exists`, `configmap_value`.

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
data/K8sQuests.json            quest and validator definitions
js/plugins/K8sQuestEngine.js   quest state machine and NPC routing
js/plugins/K8sValidatorClient.js  HTTP client for the sidecar
js/plugins/NpcK8sPluginCommand.js NPC bridge + legacy compatibility
validator/server.js            independent Kubernetes validator
tests/                         unit tests
python_tools/                  content-generation notebooks
design/character_generator/    RPG Maker character generator presets
```

## Origins

This project grew out of a team academic project (Higher Diploma in Cloud and Data Centre Administration): a Web RPG connected to an AWS SAM grading backend with Kubernetes test rules, developed under supervisor guidance:

- Grader/backend: https://github.com/wongcyrus/k8s-grader
- Kubernetes game rules: https://github.com/wongcyrus/k8s-game-rule

The legacy mode is kept so the original prototype can still be demonstrated. Everything else in this repository is an independent game-side implementation that runs without that backend.
