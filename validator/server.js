#!/usr/bin/env node
/*
 * Independent Kubernetes validator sidecar for Kubernetes Isekai.
 *
 * Reads quest definitions from data/K8sQuests.json, inspects the real
 * cluster through kubectl (using the local kubeconfig), and answers the
 * game with the validation-result contract that K8sQuestEngine consumes.
 *
 * Zero runtime dependencies — only Node.js and a working kubectl.
 *
 * Usage:
 *   node validator/server.js [--port 8787] [--host 127.0.0.1]
 *                            [--kubectl kubectl] [--api-only]
 *                            [--allow-origin <origin>]...
 *
 * Security defaults: the server binds to 127.0.0.1 only, and cross-origin
 * API calls are accepted solely from loopback origins (localhost/127.0.0.1
 * on any port). Use --host to expose it deliberately and --allow-origin to
 * whitelist additional origins (e.g. --allow-origin null for a game opened
 * straight from disk via file://).
 *
 * By default the server also serves the game itself from the repository
 * root, so the whole independent mode is just:
 *   node validator/server.js
 *   open http://localhost:8787/
 *
 * Endpoints:
 *   GET  /api/health                 -> { ok: true }
 *   GET  /api/quests                 -> contents of data/K8sQuests.json
 *   GET  /api/validate?questId=<id>  -> validation-result contract
 *   POST /api/reset/<chapterId>      -> delete the chapter's namespaces
 *                                       (derived from quest data only)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const QUESTS_FILE = path.join(ROOT, 'data', 'K8sQuests.json');
const KUBECTL_TIMEOUT_MS = 10000;

const MIME_TYPES = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.rpgmvp': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
};

function parseArgs(argv) {
  const options = {
    port: 8787,
    host: '127.0.0.1',
    kubectl: 'kubectl',
    apiOnly: false,
    allowOrigins: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--host') options.host = argv[++i];
    else if (argv[i] === '--kubectl') options.kubectl = argv[++i];
    else if (argv[i] === '--api-only') options.apiOnly = true;
    else if (argv[i] === '--allow-origin') options.allowOrigins.push(argv[++i]);
    else {
      console.error(`Unknown option: ${argv[i]}`);
      process.exit(1);
    }
  }
  return options;
}

// Cross-origin callers are only accepted from loopback origins by default;
// anything else (including the "null" origin of file:// pages) must be
// allowed explicitly with --allow-origin. Same-origin requests carry no
// Origin header and need no CORS response at all.
const LOOPBACK_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function corsOriginFor(origin, allowOrigins) {
  if (!origin) return null;
  if ((allowOrigins || []).includes(origin)) return origin;
  return LOOPBACK_ORIGIN_RE.test(origin) ? origin : null;
}

function loadQuests() {
  return JSON.parse(fs.readFileSync(QUESTS_FILE, 'utf8'));
}

// Returns the parsed resource, or null when the resource does not exist.
function makeKubectlGetter(kubectlBin) {
  return function kubectlGet(kind, name, namespace) {
    const args = ['get', kind, name, '-o', 'json'];
    if (namespace) args.push('-n', namespace);
    return new Promise((resolve, reject) => {
      execFile(
        kubectlBin,
        args,
        { timeout: KUBECTL_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (!error) {
            try {
              resolve(JSON.parse(stdout));
            } catch (parseError) {
              reject(
                new Error(
                  `kubectl returned invalid JSON: ${parseError.message}`,
                ),
              );
            }
            return;
          }
          if (/NotFound/i.test(String(stderr))) {
            resolve(null);
            return;
          }
          if (error.code === 'ENOENT') {
            reject(new Error(`kubectl not found (looked for "${kubectlBin}")`));
            return;
          }
          const detail = String(stderr).trim().split('\n')[0] || error.message;
          reject(new Error(detail));
        },
      );
    });
  };
}

function pass(message) {
  return { passed: true, message };
}

function fail(message) {
  return { passed: false, message };
}

function containerImages(podLikeSpec) {
  return (podLikeSpec.containers || []).map((container) =>
    String(container.image || ''),
  );
}

function imageMatches(images, wanted) {
  return images.some(
    (image) =>
      image === wanted ||
      image.startsWith(`${wanted}:`) ||
      image.startsWith(`${wanted}@`),
  );
}

const validators = {
  namespace_exists: async (spec, ctx) => {
    const namespace = await ctx.get('namespace', spec.name);
    return namespace
      ? pass(`Namespace "${spec.name}" exists.`)
      : fail(`Namespace "${spec.name}" was not found.`);
  },

  pod_exists: async (spec, ctx) => {
    const pod = await ctx.get('pod', spec.name, spec.namespace);
    if (!pod)
      return fail(
        `Pod "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    if (spec.image) {
      const images = containerImages(pod.spec || {});
      if (!imageMatches(images, spec.image)) {
        return fail(
          `Pod "${spec.name}" does not run image "${spec.image}" (found: ${images.join(', ') || 'none'}).`,
        );
      }
    }
    return pass(`Pod "${spec.name}" is present.`);
  },

  container_port: async (spec, ctx) => {
    const pod = await ctx.get('pod', spec.pod, spec.namespace);
    if (!pod)
      return fail(
        `Pod "${spec.pod}" was not found in namespace "${spec.namespace}".`,
      );
    const ports = (pod.spec?.containers || []).flatMap((container) =>
      (container.ports || []).map((port) => port.containerPort),
    );
    return ports.includes(spec.port)
      ? pass(`Container port ${spec.port} is exposed.`)
      : fail(`No container on Pod "${spec.pod}" exposes port ${spec.port}.`);
  },

  deployment_exists: async (spec, ctx) => {
    const deployment = await ctx.get('deployment', spec.name, spec.namespace);
    if (!deployment) {
      return fail(
        `Deployment "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    }
    if (spec.image) {
      const images = containerImages(deployment.spec?.template?.spec || {});
      if (!imageMatches(images, spec.image)) {
        return fail(
          `Deployment "${spec.name}" does not run image "${spec.image}" (found: ${images.join(', ') || 'none'}).`,
        );
      }
    }
    return pass(`Deployment "${spec.name}" is present.`);
  },

  deployment_replicas: async (spec, ctx) => {
    const deployment = await ctx.get('deployment', spec.name, spec.namespace);
    if (!deployment) {
      return fail(
        `Deployment "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    }
    const replicas = deployment.spec?.replicas ?? 0;
    return replicas === spec.count
      ? pass(`Deployment "${spec.name}" is set to ${spec.count} replica(s).`)
      : fail(
          `Deployment "${spec.name}" has ${replicas} replica(s), expected ${spec.count}.`,
        );
  },

  deployment_ready_replicas: async (spec, ctx) => {
    const deployment = await ctx.get('deployment', spec.name, spec.namespace);
    if (!deployment) {
      return fail(
        `Deployment "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    }
    const ready = deployment.status?.readyReplicas ?? 0;
    return ready === spec.count
      ? pass(`All ${spec.count} replica(s) of "${spec.name}" are ready.`)
      : fail(
          `Deployment "${spec.name}" has ${ready} ready replica(s), expected ${spec.count}.`,
        );
  },

  service_exists: async (spec, ctx) => {
    const service = await ctx.get('service', spec.name, spec.namespace);
    if (!service) {
      return fail(
        `Service "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    }
    if (spec.port !== undefined) {
      const ports = (service.spec?.ports || []).map((port) => port.port);
      if (!ports.includes(spec.port)) {
        return fail(
          `Service "${spec.name}" does not expose port ${spec.port} (found: ${ports.join(', ') || 'none'}).`,
        );
      }
    }
    if (spec.target) {
      const selector = service.spec?.selector || {};
      if (!Object.values(selector).includes(spec.target)) {
        return fail(
          `Service "${spec.name}" does not select the "${spec.target}" workload.`,
        );
      }
    }
    return pass(`Service "${spec.name}" is routing traffic.`);
  },

  pod_ready: async (spec, ctx) => {
    const pod = await ctx.get('pod', spec.name, spec.namespace);
    if (!pod)
      return fail(
        `Pod "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    const ready = (pod.status?.conditions || []).some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    );
    return ready
      ? pass(`Pod "${spec.name}" is Ready.`)
      : fail(
          `Pod "${spec.name}" exists but is not Ready (phase: ${pod.status?.phase || 'unknown'}).`,
        );
  },

  deployment_available: async (spec, ctx) => {
    const deployment = await ctx.get('deployment', spec.name, spec.namespace);
    if (!deployment) {
      return fail(
        `Deployment "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    }
    const available = (deployment.status?.conditions || []).some(
      (condition) =>
        condition.type === 'Available' && condition.status === 'True',
    );
    return available
      ? pass(`Deployment "${spec.name}" is Available.`)
      : fail(`Deployment "${spec.name}" is not reporting Available yet.`);
  },

  // True routing check: every selector entry on the Service must match the
  // Deployment's Pod template labels, not just contain a magic value.
  service_routes_to_deployment: async (spec, ctx) => {
    const service = await ctx.get('service', spec.service, spec.namespace);
    if (!service) {
      return fail(
        `Service "${spec.service}" was not found in namespace "${spec.namespace}".`,
      );
    }
    const deployment = await ctx.get(
      'deployment',
      spec.deployment,
      spec.namespace,
    );
    if (!deployment) {
      return fail(
        `Deployment "${spec.deployment}" was not found in namespace "${spec.namespace}".`,
      );
    }
    const selector = service.spec?.selector || {};
    const selectorKeys = Object.keys(selector);
    if (selectorKeys.length === 0) {
      return fail(`Service "${spec.service}" has no selector.`);
    }
    const labels = deployment.spec?.template?.metadata?.labels || {};
    const mismatched = selectorKeys.filter(
      (key) => labels[key] !== selector[key],
    );
    return mismatched.length === 0
      ? pass(`Service "${spec.service}" selects the "${spec.deployment}" Pods.`)
      : fail(
          `Service "${spec.service}" selector does not match the "${spec.deployment}" Pod labels (mismatched: ${mismatched.join(', ')}).`,
        );
  },

  service_has_ready_endpoints: async (spec, ctx) => {
    const endpoints = await ctx.get('endpoints', spec.name, spec.namespace);
    if (!endpoints) {
      return fail(
        `No Endpoints object found for Service "${spec.name}" in namespace "${spec.namespace}".`,
      );
    }
    const readyAddresses = (endpoints.subsets || []).flatMap(
      (subset) => subset.addresses || [],
    );
    return readyAddresses.length > 0
      ? pass(
          `Service "${spec.name}" has ${readyAddresses.length} ready endpoint(s).`,
        )
      : fail(`Service "${spec.name}" has no ready endpoints.`);
  },

  deployment_uses_configmap: async (spec, ctx) => {
    const deployment = await ctx.get('deployment', spec.name, spec.namespace);
    if (!deployment) {
      return fail(
        `Deployment "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    }
    const podSpec = deployment.spec?.template?.spec || {};
    const containers = [
      ...(podSpec.containers || []),
      ...(podSpec.initContainers || []),
    ];
    const viaEnvFrom = containers.some((container) =>
      (container.envFrom || []).some(
        (source) => source.configMapRef?.name === spec.configmap,
      ),
    );
    const viaEnv = containers.some((container) =>
      (container.env || []).some(
        (entry) => entry.valueFrom?.configMapKeyRef?.name === spec.configmap,
      ),
    );
    const viaVolume = (podSpec.volumes || []).some(
      (volume) => volume.configMap?.name === spec.configmap,
    );
    return viaEnvFrom || viaEnv || viaVolume
      ? pass(
          `Deployment "${spec.name}" consumes ConfigMap "${spec.configmap}".`,
        )
      : fail(
          `Deployment "${spec.name}" does not consume ConfigMap "${spec.configmap}" (via envFrom, env or a volume).`,
        );
  },

  configmap_value: async (spec, ctx) => {
    const configMap = await ctx.get('configmap', spec.name, spec.namespace);
    if (!configMap) {
      return fail(
        `ConfigMap "${spec.name}" was not found in namespace "${spec.namespace}".`,
      );
    }
    const value = (configMap.data || {})[spec.key];
    if (value === undefined) {
      return fail(`ConfigMap "${spec.name}" has no key "${spec.key}".`);
    }
    return value === spec.value
      ? pass(`ConfigMap "${spec.name}" holds ${spec.key}=${spec.value}.`)
      : fail(
          `ConfigMap "${spec.name}" has ${spec.key}=${value}, expected ${spec.value}.`,
        );
  },
};

async function validateQuest(quest, ctx) {
  const objectives = [];
  for (const objective of quest.objectives || []) {
    const spec = objective.validator || {};
    const validator = validators[spec.type];
    let result;
    if (!validator) {
      result = fail(`Unknown validator type "${spec.type}".`);
    } else {
      try {
        result = await validator(spec, ctx);
      } catch (error) {
        result = fail(`Check failed: ${error.message}`);
      }
    }
    objectives.push({
      id: objective.id,
      passed: result.passed,
      message: result.message,
    });
  }

  const completed =
    objectives.length > 0 && objectives.every((objective) => objective.passed);
  const failed = objectives.filter((objective) => !objective.passed);
  const anyPassed = objectives.some((objective) => objective.passed);
  return {
    questId: quest.id,
    completed,
    state: completed ? 'completed' : anyPassed ? 'partial' : 'pending',
    objectives,
    message: completed
      ? null
      : `${failed.length} objective(s) still need work in the cluster.`,
  };
}

// Chapter reset: the deletion list is derived strictly from the quest
// data (the namespaces the chapter's validators reference), never from
// the request — this endpoint must not become a generic kubectl proxy.
function resetTargets(questData) {
  const namespaces = new Set();
  for (const quest of questData.quests || []) {
    for (const objective of quest.objectives || []) {
      const spec = objective.validator || {};
      if (spec.type === 'namespace_exists' && spec.name) {
        namespaces.add(spec.name);
      }
      if (spec.namespace) namespaces.add(spec.namespace);
    }
  }
  return { namespaces: [...namespaces].sort() };
}

function makeKubectlDeleter(kubectlBin) {
  return function deleteNamespace(namespace) {
    const args = [
      'delete',
      'namespace',
      namespace,
      '--ignore-not-found',
      '--wait=false',
    ];
    return new Promise((resolve, reject) => {
      execFile(
        kubectlBin,
        args,
        { timeout: KUBECTL_TIMEOUT_MS },
        (error, stdout, stderr) => {
          if (error) {
            if (error.code === 'ENOENT') {
              reject(
                new Error(`kubectl not found (looked for "${kubectlBin}")`),
              );
              return;
            }
            const detail =
              String(stderr).trim().split('\n')[0] || error.message;
            reject(new Error(detail));
            return;
          }
          resolve(String(stdout).trim());
        },
      );
    });
  };
}

async function resetChapter(chapterId, questData, deleteNamespace) {
  if (!questData.chapter || questData.chapter.id !== chapterId) {
    return { ok: false, status: 404, error: `Unknown chapter "${chapterId}".` };
  }
  const targets = resetTargets(questData);
  const deleted = [];
  for (const namespace of targets.namespaces) {
    await deleteNamespace(namespace);
    deleted.push(namespace);
  }
  return { ok: true, status: 200, chapterId, deletedNamespaces: deleted };
}

function sendJson(res, statusCode, body, corsOrigin) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, urlPath) {
  const relative = decodeURIComponent(
    urlPath === '/' ? '/index.html' : urlPath,
  );
  const filePath = path.join(ROOT, relative);
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const type =
      MIME_TYPES[path.extname(filePath).toLowerCase()] ||
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  });
}

function createServer(options) {
  const ctx = { get: makeKubectlGetter(options.kubectl) };
  const deleteNamespace = makeKubectlDeleter(options.kubectl);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const corsOrigin = corsOriginFor(req.headers.origin, options.allowOrigins);

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true }, corsOrigin);
      return;
    }

    if (url.pathname === '/api/quests') {
      try {
        sendJson(res, 200, loadQuests(), corsOrigin);
      } catch (error) {
        sendJson(
          res,
          500,
          { error: `Cannot read quest data: ${error.message}` },
          corsOrigin,
        );
      }
      return;
    }

    if (url.pathname === '/api/validate') {
      const questId = url.searchParams.get('questId');
      let quest;
      try {
        quest = (loadQuests().quests || []).find(
          (entry) => entry.id === questId,
        );
      } catch (error) {
        sendJson(
          res,
          500,
          { error: `Cannot read quest data: ${error.message}` },
          corsOrigin,
        );
        return;
      }
      if (!quest) {
        sendJson(
          res,
          404,
          { error: `Unknown questId "${questId}".` },
          corsOrigin,
        );
        return;
      }
      const result = await validateQuest(quest, ctx);
      sendJson(res, 200, result, corsOrigin);
      return;
    }

    const resetMatch = url.pathname.match(/^\/api\/reset\/([A-Za-z0-9_-]+)$/);
    if (resetMatch) {
      if (req.method !== 'POST') {
        sendJson(
          res,
          405,
          { error: 'Use POST to reset a chapter.' },
          corsOrigin,
        );
        return;
      }
      let questData;
      try {
        questData = loadQuests();
      } catch (error) {
        sendJson(
          res,
          500,
          { error: `Cannot read quest data: ${error.message}` },
          corsOrigin,
        );
        return;
      }
      try {
        const result = await resetChapter(
          resetMatch[1],
          questData,
          deleteNamespace,
        );
        sendJson(
          res,
          result.status,
          result.ok
            ? {
                chapterId: result.chapterId,
                deletedNamespaces: result.deletedNamespaces,
              }
            : { error: result.error },
          corsOrigin,
        );
      } catch (error) {
        sendJson(res, 500, { error: error.message }, corsOrigin);
      }
      return;
    }

    if (options.apiOnly) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    serveStatic(req, res, url.pathname);
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = createServer(options);
  server.listen(options.port, options.host, () => {
    console.log(
      `Kubernetes Isekai validator listening on http://${options.host}:${options.port}`,
    );
    if (!options.apiOnly) {
      console.log(`Game served at http://${options.host}:${options.port}/`);
    }
    console.log(`Using kubectl binary: ${options.kubectl}`);
    if (options.host !== '127.0.0.1' && options.host !== 'localhost') {
      console.warn(
        'Warning: the validator is reachable from other machines and exposes cluster state; only do this on a network you trust.',
      );
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  corsOriginFor,
  createServer,
  imageMatches,
  loadQuests,
  makeKubectlDeleter,
  makeKubectlGetter,
  parseArgs,
  resetChapter,
  resetTargets,
  validateQuest,
  validators,
};
