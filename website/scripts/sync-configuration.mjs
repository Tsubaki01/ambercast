import { promises as fs } from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve(import.meta.dirname, '../../docs/configuration.md');
const outputPath = path.resolve(
  import.meta.dirname,
  '../src/content/docs/reference/configuration.md',
);

const frontmatter = `---
title: Configuration
description: Auto-generated from the repository's docs/configuration.md — configuration fields with a non-obvious contract.
editUrl: https://github.com/kotarotsubaki/ambercast/edit/main/docs/configuration.md
sidebar:
  order: 2
---

`;

try {
  let content = await fs.readFile(sourcePath, 'utf8');
  content = content.replace(/^# Configuration reference(?:\r?\n|$)(?:\r?\n)?/, '');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${frontmatter}${content}`, 'utf8');

  console.log('Synced docs/configuration.md -> src/content/docs/reference/configuration.md');
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error('Cannot sync configuration: docs/configuration.md does not exist.');
  } else {
    console.error(
      `Failed to sync configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
}
