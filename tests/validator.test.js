'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validators,
  validateQuest,
  imageMatches,
  loadQuests,
} = require('../validator/server');

// Fake kubectl context: resources keyed by "kind/namespace/name".
function fakeCluster(resources) {
  return {
    get: async (kind, name, namespace) => {
      const key = `${kind}/${namespace || ''}/${name}`;
      if (resources[key] instanceof Error) throw resources[key];
      return resources[key] || null;
    },
  };
}

test('imageMatches accepts bare names, tags and digests', () => {
  assert.ok(imageMatches(['nginx'], 'nginx'));
  assert.ok(imageMatches(['nginx:1.25'], 'nginx'));
  assert.ok(imageMatches(['nginx@sha256:abc'], 'nginx'));
  assert.ok(!imageMatches(['nginx-unprivileged'], 'nginx'));
  assert.ok(!imageMatches([], 'nginx'));
});

test('namespace_exists passes and fails correctly', async () => {
  const ctx = fakeCluster({
    'namespace//village': { metadata: { name: 'village' } },
  });
  assert.equal(
    (await validators.namespace_exists({ name: 'village' }, ctx)).passed,
    true,
  );
  assert.equal(
    (await validators.namespace_exists({ name: 'missing' }, ctx)).passed,
    false,
  );
});

test('pod_exists checks the image when one is required', async () => {
  const pod = { spec: { containers: [{ image: 'nginx:1.25' }] } };
  const ctx = fakeCluster({ 'pod/village/inn-lantern': pod });
  const spec = { namespace: 'village', name: 'inn-lantern', image: 'nginx' };
  assert.equal((await validators.pod_exists(spec, ctx)).passed, true);
  const wrong = { ...spec, image: 'httpd' };
  assert.equal((await validators.pod_exists(wrong, ctx)).passed, false);
});

test('container_port finds ports across containers', async () => {
  const pod = {
    spec: {
      containers: [
        { ports: [{ containerPort: 8080 }] },
        { ports: [{ containerPort: 80 }] },
      ],
    },
  };
  const ctx = fakeCluster({ 'pod/village/inn-lantern': pod });
  const spec = { namespace: 'village', pod: 'inn-lantern', port: 80 };
  assert.equal((await validators.container_port(spec, ctx)).passed, true);
  assert.equal(
    (await validators.container_port({ ...spec, port: 443 }, ctx)).passed,
    false,
  );
});

test('deployment_replicas compares desired replicas', async () => {
  const deployment = { spec: { replicas: 3 } };
  const ctx = fakeCluster({ 'deployment/village/inn': deployment });
  const spec = { namespace: 'village', name: 'inn', count: 3 };
  assert.equal((await validators.deployment_replicas(spec, ctx)).passed, true);
  const result = await validators.deployment_replicas(
    { ...spec, count: 5 },
    ctx,
  );
  assert.equal(result.passed, false);
  assert.match(result.message, /has 3 replica/);
});

test('deployment_ready_replicas reads status, not spec', async () => {
  const deployment = { spec: { replicas: 3 }, status: { readyReplicas: 1 } };
  const ctx = fakeCluster({ 'deployment/village/inn': deployment });
  const spec = { namespace: 'village', name: 'inn', count: 3 };
  assert.equal(
    (await validators.deployment_ready_replicas(spec, ctx)).passed,
    false,
  );
});

test('service_exists checks port and workload selector', async () => {
  const service = {
    spec: { ports: [{ port: 80 }], selector: { app: 'inn' } },
  };
  const ctx = fakeCluster({ 'service/village/inn-service': service });
  const spec = {
    namespace: 'village',
    name: 'inn-service',
    port: 80,
    target: 'inn',
  };
  assert.equal((await validators.service_exists(spec, ctx)).passed, true);
  assert.equal(
    (await validators.service_exists({ ...spec, port: 8080 }, ctx)).passed,
    false,
  );
  assert.equal(
    (await validators.service_exists({ ...spec, target: 'tavern' }, ctx))
      .passed,
    false,
  );
});

test('configmap_value distinguishes missing keys from wrong values', async () => {
  const configMap = { data: { GREETING: 'WelcomeHome' } };
  const ctx = fakeCluster({ 'configmap/village/inn-config': configMap });
  const spec = {
    namespace: 'village',
    name: 'inn-config',
    key: 'GREETING',
    value: 'WelcomeHome',
  };
  assert.equal((await validators.configmap_value(spec, ctx)).passed, true);
  const wrongValue = await validators.configmap_value(
    { ...spec, value: 'Hello' },
    ctx,
  );
  assert.equal(wrongValue.passed, false);
  assert.match(wrongValue.message, /expected Hello/);
  const missingKey = await validators.configmap_value(
    { ...spec, key: 'MOTD' },
    ctx,
  );
  assert.match(missingKey.message, /no key/);
});

test('validateQuest aggregates objectives into the game contract', async () => {
  const quest = {
    id: 'village-02-pod',
    objectives: [
      {
        id: 'pod',
        validator: {
          type: 'pod_exists',
          namespace: 'village',
          name: 'inn-lantern',
          image: 'nginx',
        },
      },
      {
        id: 'port',
        validator: {
          type: 'container_port',
          namespace: 'village',
          pod: 'inn-lantern',
          port: 80,
        },
      },
    ],
  };
  const pod = {
    spec: {
      containers: [{ image: 'nginx', ports: [{ containerPort: 8080 }] }],
    },
  };
  const ctx = fakeCluster({ 'pod/village/inn-lantern': pod });

  const result = await validateQuest(quest, ctx);
  assert.equal(result.questId, 'village-02-pod');
  assert.equal(result.completed, false);
  assert.deepEqual(
    result.objectives.map((o) => o.passed),
    [true, false],
  );
  assert.match(result.message, /1 objective/);
});

test('validateQuest reports completion when everything passes', async () => {
  const quest = {
    id: 'village-01-namespace',
    objectives: [
      {
        id: 'namespace',
        validator: { type: 'namespace_exists', name: 'village' },
      },
    ],
  };
  const ctx = fakeCluster({ 'namespace//village': {} });
  const result = await validateQuest(quest, ctx);
  assert.equal(result.completed, true);
  assert.equal(result.message, null);
});

test('validateQuest survives kubectl failures and unknown validator types', async () => {
  const quest = {
    id: 'broken',
    objectives: [
      { id: 'boom', validator: { type: 'namespace_exists', name: 'village' } },
      { id: 'what', validator: { type: 'time_travel' } },
    ],
  };
  const ctx = fakeCluster({
    'namespace//village': new Error('connection refused'),
  });
  const result = await validateQuest(quest, ctx);
  assert.equal(result.completed, false);
  assert.match(
    result.objectives[0].message,
    /Check failed: connection refused/,
  );
  assert.match(result.objectives[1].message, /Unknown validator type/);
});

test('every validator type used in K8sQuests.json is implemented', () => {
  const used = new Set();
  for (const quest of loadQuests().quests) {
    for (const objective of quest.objectives || []) {
      used.add(objective.validator?.type);
    }
  }
  for (const type of used) {
    assert.ok(
      validators[type],
      `missing validator implementation for "${type}"`,
    );
  }
});

test('corsOriginFor only reflects loopback origins by default', () => {
  const { corsOriginFor } = require('../validator/server');
  assert.equal(corsOriginFor(undefined, []), null);
  assert.equal(
    corsOriginFor('http://localhost:8080', []),
    'http://localhost:8080',
  );
  assert.equal(
    corsOriginFor('http://127.0.0.1:3000', []),
    'http://127.0.0.1:3000',
  );
  assert.equal(corsOriginFor('https://localhost', []), 'https://localhost');
  assert.equal(corsOriginFor('http://evil.example.com', []), null);
  assert.equal(corsOriginFor('http://localhost.evil.com', []), null);
  assert.equal(corsOriginFor('null', []), null);
});

test('corsOriginFor honours an explicit allowlist', () => {
  const { corsOriginFor } = require('../validator/server');
  assert.equal(corsOriginFor('null', ['null']), 'null');
  assert.equal(
    corsOriginFor('https://game.example.com', ['https://game.example.com']),
    'https://game.example.com',
  );
  assert.equal(
    corsOriginFor('https://other.example.com', ['https://game.example.com']),
    null,
  );
});

test('parseArgs defaults to loopback and collects --allow-origin flags', () => {
  const { parseArgs } = require('../validator/server');
  const defaults = parseArgs([]);
  assert.equal(defaults.host, '127.0.0.1');
  assert.deepEqual(defaults.allowOrigins, []);

  const custom = parseArgs([
    '--host',
    '0.0.0.0',
    '--port',
    '9000',
    '--allow-origin',
    'null',
    '--allow-origin',
    'https://game.example.com',
  ]);
  assert.equal(custom.host, '0.0.0.0');
  assert.equal(custom.port, 9000);
  assert.deepEqual(custom.allowOrigins, ['null', 'https://game.example.com']);
});

test('pod_ready requires a True Ready condition', async () => {
  const { validators } = require('../validator/server');
  const readyPod = {
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
    },
  };
  const notReadyPod = {
    status: {
      phase: 'Pending',
      conditions: [{ type: 'Ready', status: 'False' }],
    },
  };
  const spec = { namespace: 'village', name: 'inn-lantern' };
  assert.equal(
    (
      await validators.pod_ready(
        spec,
        fakeCluster({ 'pod/village/inn-lantern': readyPod }),
      )
    ).passed,
    true,
  );
  const result = await validators.pod_ready(
    spec,
    fakeCluster({ 'pod/village/inn-lantern': notReadyPod }),
  );
  assert.equal(result.passed, false);
  assert.match(result.message, /not Ready/);
});

test('deployment_available reads the Available condition', async () => {
  const { validators } = require('../validator/server');
  const available = {
    status: { conditions: [{ type: 'Available', status: 'True' }] },
  };
  const notAvailable = {
    status: { conditions: [{ type: 'Available', status: 'False' }] },
  };
  const spec = { namespace: 'village', name: 'inn' };
  assert.equal(
    (
      await validators.deployment_available(
        spec,
        fakeCluster({ 'deployment/village/inn': available }),
      )
    ).passed,
    true,
  );
  assert.equal(
    (
      await validators.deployment_available(
        spec,
        fakeCluster({ 'deployment/village/inn': notAvailable }),
      )
    ).passed,
    false,
  );
});

test('service_routes_to_deployment matches selector against template labels', async () => {
  const { validators } = require('../validator/server');
  const deployment = {
    spec: { template: { metadata: { labels: { app: 'inn', tier: 'web' } } } },
  };
  const spec = {
    namespace: 'village',
    service: 'inn-service',
    deployment: 'inn',
  };

  const matching = { spec: { selector: { app: 'inn' } } };
  assert.equal(
    (
      await validators.service_routes_to_deployment(
        spec,
        fakeCluster({
          'service/village/inn-service': matching,
          'deployment/village/inn': deployment,
        }),
      )
    ).passed,
    true,
  );

  const mismatched = { spec: { selector: { app: 'tavern' } } };
  const bad = await validators.service_routes_to_deployment(
    spec,
    fakeCluster({
      'service/village/inn-service': mismatched,
      'deployment/village/inn': deployment,
    }),
  );
  assert.equal(bad.passed, false);
  assert.match(bad.message, /mismatched: app/);

  const empty = { spec: { selector: {} } };
  const noSelector = await validators.service_routes_to_deployment(
    spec,
    fakeCluster({
      'service/village/inn-service': empty,
      'deployment/village/inn': deployment,
    }),
  );
  assert.equal(noSelector.passed, false);
  assert.match(noSelector.message, /no selector/);
});

test('service_has_ready_endpoints requires at least one ready address', async () => {
  const { validators } = require('../validator/server');
  const spec = { namespace: 'village', name: 'inn-service' };
  const withAddresses = {
    subsets: [{ addresses: [{ ip: '10.0.0.5' }, { ip: '10.0.0.6' }] }],
  };
  const onlyNotReady = {
    subsets: [{ notReadyAddresses: [{ ip: '10.0.0.5' }] }],
  };

  const ok = await validators.service_has_ready_endpoints(
    spec,
    fakeCluster({
      'endpoints/village/inn-service': withAddresses,
    }),
  );
  assert.equal(ok.passed, true);
  assert.match(ok.message, /2 ready endpoint/);

  assert.equal(
    (
      await validators.service_has_ready_endpoints(
        spec,
        fakeCluster({
          'endpoints/village/inn-service': onlyNotReady,
        }),
      )
    ).passed,
    false,
  );
  assert.equal(
    (await validators.service_has_ready_endpoints(spec, fakeCluster({})))
      .passed,
    false,
  );
});

test('deployment_uses_configmap accepts envFrom, env valueFrom and volumes', async () => {
  const { validators } = require('../validator/server');
  const spec = { namespace: 'village', name: 'inn', configmap: 'inn-config' };
  const key = 'deployment/village/inn';
  const make = (podSpec) => ({ spec: { template: { spec: podSpec } } });

  const viaEnvFrom = make({
    containers: [{ envFrom: [{ configMapRef: { name: 'inn-config' } }] }],
  });
  const viaEnv = make({
    containers: [
      {
        env: [
          {
            name: 'GREETING',
            valueFrom: {
              configMapKeyRef: { name: 'inn-config', key: 'GREETING' },
            },
          },
        ],
      },
    ],
  });
  const viaVolume = make({
    containers: [{}],
    volumes: [{ name: 'cfg', configMap: { name: 'inn-config' } }],
  });
  const unrelated = make({
    containers: [{ envFrom: [{ configMapRef: { name: 'other-config' } }] }],
  });

  assert.equal(
    (
      await validators.deployment_uses_configmap(
        spec,
        fakeCluster({ [key]: viaEnvFrom }),
      )
    ).passed,
    true,
  );
  assert.equal(
    (
      await validators.deployment_uses_configmap(
        spec,
        fakeCluster({ [key]: viaEnv }),
      )
    ).passed,
    true,
  );
  assert.equal(
    (
      await validators.deployment_uses_configmap(
        spec,
        fakeCluster({ [key]: viaVolume }),
      )
    ).passed,
    true,
  );
  assert.equal(
    (
      await validators.deployment_uses_configmap(
        spec,
        fakeCluster({ [key]: unrelated }),
      )
    ).passed,
    false,
  );
});

test('validateQuest reports state pending, partial or completed', async () => {
  const quest = {
    id: 'state-check',
    objectives: [
      { id: 'a', validator: { type: 'namespace_exists', name: 'village' } },
      { id: 'b', validator: { type: 'namespace_exists', name: 'castle' } },
    ],
  };
  const none = await validateQuest(quest, fakeCluster({}));
  assert.equal(none.state, 'pending');
  const some = await validateQuest(
    quest,
    fakeCluster({ 'namespace//village': {} }),
  );
  assert.equal(some.state, 'partial');
  const all = await validateQuest(
    quest,
    fakeCluster({ 'namespace//village': {}, 'namespace//castle': {} }),
  );
  assert.equal(all.state, 'completed');
});

test('resetTargets derives only the namespaces the chapter really uses', () => {
  const { resetTargets } = require('../validator/server');
  assert.deepEqual(resetTargets(loadQuests()).namespaces, ['village']);
});

test('resetChapter refuses unknown chapters and deletes only derived namespaces', async () => {
  const { resetChapter } = require('../validator/server');
  const deleted = [];
  const fakeDelete = async (namespace) => deleted.push(namespace);
  const questData = loadQuests();

  const wrong = await resetChapter('chapter-99', questData, fakeDelete);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 404);
  assert.deepEqual(deleted, []);

  const right = await resetChapter(questData.chapter.id, questData, fakeDelete);
  assert.equal(right.ok, true);
  assert.deepEqual(right.deletedNamespaces, ['village']);
  assert.deepEqual(deleted, ['village']);
});
