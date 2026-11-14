import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_REPO_NOTICE } from './copy.ts';
import { DataRepo } from './repo.ts';
import { SCHEMA_VERSION } from './schema.ts';
import type { Lane } from './schema.ts';

export const DEFAULT_LANES: Lane[] = [
  { id: 'people-owed', name: 'People you owe' },
  { id: 'waiting-on-you', name: 'Applications waiting on you' },
  { id: 'one-outreach', name: 'One outreach' },
];

const SOURCES_README = `# Sources

Each file in this folder is one place the agent may look for open roles.
The app writes them when you add a source. You can also edit them by hand.
This folder starts empty: nothing is searched until you add a source.

One source is one file, named after its id (for example \`s1.json\`):

\`\`\`json
{
  "id": "s1",
  "url": "https://careers.example.com/jobs",
  "label": "Example careers page",
  "enabled": true,
  "addedAt": "2026-01-01T09:00:00.000Z",
  "addedBy": "user"
}
\`\`\`

- \`id\` matches the file name.
- \`url\` is an http or https address.
- \`label\` is optional and only for your own reference.
- \`enabled\` is \`false\` to pause a source.
- \`addedBy\` is \`user\` or \`interview\`.
`;

const GITIGNORE = `cookies/
*.cookies.json
storage-state*.json
secrets/
.env*
`;

const README = `# Your private data repo

${PRIVATE_REPO_NOTICE}

Your profile, interviews, sources, roles, applications and commands are stored here as
plain files. The app and the agent each keep a copy and sync it through this repo.
Do not make it public, and do not add cookies or passwords to it.
`;

/**
 * Write the starting layout into `dir`. `dir` must be empty or hold only `.git`;
 * anything else throws before a single file is written.
 */
export function initDataLayout(dir: string, now: Date = new Date()): void {
  fs.mkdirSync(dir, { recursive: true });
  const entries = fs.readdirSync(dir).filter((name) => name !== '.git');
  if (entries.length > 0) {
    throw new Error(`Cannot set up a data repo in ${dir}: the folder is not empty.`);
  }

  const app = new DataRepo(dir, 'app');
  app.putSingleton('meta', { schemaVersion: SCHEMA_VERSION, createdAt: now.toISOString() });
  app.putSingleton('lanes', { lanes: DEFAULT_LANES.map((l) => ({ ...l })) });
  app.putSingleton('declarations', { hardNosNone: false, sourcesDecideLater: false });

  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sources', 'README.md'), SOURCES_README, 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE, 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), README, 'utf8');
}
