# Kubernetes Isekai — Independent Rework

Kubernetes Isekai is an RPG that turns hands-on Kubernetes work into actions inside a game world: NPCs give quests, the player changes a real cluster, and the game progresses after the cluster state is validated.

This repository started from the game client created as a team academic project. The original grading backend was developed separately under supervisor guidance. This branch of the project is now being redesigned as an independent game-side implementation, with the long-term goal of making the RPG playable without depending on the original supervisor backend.

## Current direction

The redesign treats Kubernetes as part of the world rather than as a quiz shown inside an RPG shell.

- Cluster → the world / kingdom
- Namespace → a district or region
- Pod → a worker, building or creature instance
- Deployment → a managed guild or service
- Service → a stable road or portal
- ConfigMap → a public ledger / spellbook
- Secret → a sealed record
- Scaling → reinforcements
- CrashLoopBackOff → a recurring curse or failed machine

The first playable story arc is **Chapter 1: The Broken Village**. It progresses from namespaces and Pods to Deployments, scaling, Services and ConfigMaps, ending with a small integrated boss objective.

## Architecture in this rework

```text
RPG Maker MV game
    |
    +-- K8sQuestEngine
    |     +-- story / objectives
    |     +-- quest progress in save data
    |     +-- validator result contract
    |
    +-- NpcK8sPluginCommand
          +-- independent local quest mode
          +-- legacy backend compatibility mode

Future independent validator
    |
    +-- Kubernetes API
          +-- Namespace
          +-- Pod
          +-- Deployment
          +-- Service
          +-- ConfigMap
```

The important change is that **game progression is no longer owned by the old grader protocol**. The game now has its own quest state and accepts a small validation-result contract. A future validator can therefore be replaced without rewriting maps and NPC events.

## New quest engine

Quest definitions live in:

```text
data/K8sQuests.json
```

The game-side engine lives in:

```text
js/plugins/K8sQuestEngine.js
```

Example objective definition:

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

A validator only needs to return a result such as:

```js
K8sQuestEngine.applyValidationResult({
  questId: 'village-04-scale',
  completed: true,
  objectives: [
    { id: 'replicas', passed: true }
  ]
});
```

This keeps Kubernetes checking separate from RPG story logic.

## Running modes

### Independent game mode

Open the game without the old `baseUrl`, `apiKey` and `game` query parameters. Existing NPC events that call `NpcK8sPluginCommand` will fall back to the local quest engine instead of failing because the supervisor backend is missing.

Quest progress is stored in normal RPG Maker save data.

### Legacy compatibility mode

The original API flow remains available when all three legacy query parameters are supplied:

```text
?baseUrl=...&apiKey=...&game=...
```

This is kept only so the academic prototype can still be demonstrated while the independent validator is being built.

### Quest development mode

For story testing only, launch with:

```text
?questDev=1
```

RPG Maker plugin commands:

```text
K8sQuest status
K8sQuest start village-01-namespace
K8sQuest complete
K8sQuest reset
```

`complete` and `reset` are blocked outside development mode. In a normal game, quest completion must come from the Kubernetes validator.

## Chapter 1 — The Broken Village

1. **A Place to Rebuild** — Namespace
2. **Light the First Lantern** — Pod + container port
3. **Build Something That Survives** — Deployment
4. **The Night Rush** — scaling to three replicas
5. **Open the Road** — Service
6. **The Missing Ledger** — ConfigMap
7. **Boss: Restore the Village** — integrated health check

## Original academic project

The original project demonstrated a Web RPG connected to an AWS SAM grading backend and Kubernetes test rules:

- Grader/backend: https://github.com/wongcyrus/k8s-grader
- Kubernetes game rules: https://github.com/wongcyrus/k8s-game-rule

Original game client contributors were students from the Higher Diploma in Cloud and Data Centre Administration programme. The independent rework intentionally keeps the original project attribution while separating new game-side work from the supervisor-developed backend.
