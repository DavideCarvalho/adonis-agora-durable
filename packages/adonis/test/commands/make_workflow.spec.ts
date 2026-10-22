import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('make:workflow', () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-ace-'));
    // A minimal adonisrc so the ignitor can boot the ace kernel.
    await writeFile(
      join(appRoot, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
    );
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it('emits a valid BaseWorkflow stub at app/workflows/<name>_workflow.ts', async () => {
    const ace = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    await ace.app.init();
    await ace.app.boot();

    const { default: MakeWorkflow } = await import('../../commands/make_workflow.js');
    ace.ui.switchMode('raw');
    const command = await ace.create(MakeWorkflow, ['order']);
    await command.exec();

    const file = join(appRoot, 'app/workflows/order_workflow.ts');
    const contents = await readFile(file, 'utf8');
    expect(contents).toContain('import { BaseWorkflow }');
    expect(contents).toContain('export default class OrderWorkflow extends BaseWorkflow');
    expect(contents).toContain('static workflow = {');
    expect(contents).toContain("name: 'order'");
    expect(contents).toContain('async run(ctx: WorkflowCtx');
    expect(contents).toContain("from '@adonis-agora/durable'");
  });

  it.each([['OrderWorkflow'], ['order_workflow'], ['Order']])(
    'accepts %s with or without the Workflow suffix (no doubled suffix)',
    async (name) => {
      const ace = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
        importer: (filePath) => import(filePath),
      });
      await ace.app.init();
      await ace.app.boot();

      const { default: MakeWorkflow } = await import('../../commands/make_workflow.js');
      ace.ui.switchMode('raw');
      const command = await ace.create(MakeWorkflow, [name]);
      await command.exec();

      const contents = await readFile(join(appRoot, 'app/workflows/order_workflow.ts'), 'utf8');
      expect(contents).toContain('export default class OrderWorkflow extends BaseWorkflow');
      expect(contents).not.toContain('WorkflowWorkflow');
      expect(contents).toContain('interface OrderInput');
      expect(contents).toContain("name: 'order'");
    },
  );
});
