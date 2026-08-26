#!/usr/bin/env node
/*
 * Chapter cleanup for Kubernetes Isekai.
 *
 * Deletes ONLY the namespaces referenced by the chapter's quest
 * validators in data/K8sQuests.json (for Chapter 1: namespace/village,
 * which removes the pod, deployment, service and configmap inside it).
 *
 * Usage:
 *   npm run reset            # resets the chapter defined in K8sQuests.json
 *   node validator/reset.js [--kubectl /path/to/kubectl] [--dry-run]
 */

'use strict';

const {
  loadQuests,
  makeKubectlDeleter,
  resetChapter,
  resetTargets,
} = require('./server');

async function main() {
  const argv = process.argv.slice(2);
  let kubectl = 'kubectl';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--kubectl') kubectl = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else {
      console.error(`Unknown option: ${argv[i]}`);
      process.exit(1);
    }
  }

  const questData = loadQuests();
  const chapterId = questData.chapter?.id;
  const targets = resetTargets(questData);

  if (dryRun) {
    console.log(
      `Would delete namespace(s) for ${chapterId}: ${targets.namespaces.join(', ')}`,
    );
    return;
  }

  console.log(
    `Resetting ${chapterId}: deleting namespace(s) ${targets.namespaces.join(', ')}...`,
  );
  const result = await resetChapter(
    chapterId,
    questData,
    makeKubectlDeleter(kubectl),
  );
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(
    `Done. Deleted: ${result.deletedNamespaces.join(', ')} (namespace termination continues in the background).`,
  );
  console.log(
    'In-game progress is separate: use ?questDev=1 and the "K8sQuest reset" plugin command to restart the story.',
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
