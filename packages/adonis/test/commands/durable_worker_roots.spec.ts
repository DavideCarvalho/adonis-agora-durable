import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

describe('durable:worker — several stepsPath / workflowsPath roots', () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-worker-roots-'));
    await writeFile(
      join(appRoot, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
    );
    for (const [rel, contents] of [
      [
        'app/orders/steps/reserve_step.ts',
        `import { defineStep } from '${SRC}/step-ref.js'\nexport const reserve = defineStep('reserve', async () => 1)`,
      ],
      [
        'app/billing/steps/charge_step.ts',
        `import { defineStep } from '${SRC}/step-ref.js'\nexport const charge = defineStep('charge', async () => 1)`,
      ],
      [
        'app/orders/flows/order_workflow.ts',
        `export default class OrderWorkflow { static workflow = { name: 'order' }; async run() {} }`,
      ],
      [
        'app/billing/flows/refund_workflow.ts',
        `export default class RefundWorkflow { static workflow = { name: 'refund' }; async run() {} }`,
      ],
    ] as const) {
      await mkdir(join(appRoot, rel, '..'), { recursive: true });
      await writeFile(join(appRoot, rel), contents);
    }
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it('serves the steps and advertises the workflows of every root', async () => {
    const ace = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    await ace.app.init();
    await ace.app.boot();
    ace.app.config.set('durable', {
      role: 'tenant',
      stepsPath: ['app/orders/steps', 'app/billing/steps'],
      workflowsPath: ['app/orders/flows', 'app/billing/flows'],
    });

    const { default: DurableWorker } = await import('../../commands/durable_worker.js');
    ace.ui.switchMode('raw');
    const command = await ace.create(DurableWorker, []);
    // The command stays alive until a shutdown signal: stop it once it reports it started.
    const done = command.exec();
    const started = () =>
      ace.ui.logger.getLogs().some((log) => log.message.includes('durable:worker started'));
    for (let i = 0; i < 200 && !started(); i++) await new Promise((r) => setTimeout(r, 10));
    process.emit('SIGINT');
    await done;

    const messages = ace.ui.logger.getLogs().map((log) => log.message);
    expect(messages).toContain(
      '[ blue(info) ] registered 2 step handler(s) from app/orders/steps, app/billing/steps',
    );
    expect(messages).toContain(
      '[ blue(info) ] advertising 2 workflow name(s) from app/orders/flows, app/billing/flows',
    );
  });
});
