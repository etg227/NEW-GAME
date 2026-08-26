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
 *   GET /api/health                 -> { ok: true }
 *   GET /api/quests                 -> contents of data/K8sQuests.json
 *   GET /api/validate?questId=<id>  -> validation-result contract
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
  return {
    questId: quest.id,
    completed,
    objectives,
    message: completed
      ? null
      : `${failed.length} objective(s) still need work in the cluster.`,
  };
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
  makeKubectlGetter,
  parseArgs,
  validateQuest,
  validators,
};
