import { args, BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { stubsRoot } from '../stubs/main.js';

/**
 * `node ace make:workflow <name>` — scaffold a durable workflow class under `app/workflows/`, the
 * parallel to `@adonisjs/queue`'s `make:job` (which scaffolds `app/jobs/`). The generated class
 * extends `BaseWorkflow` (the blessed authoring form) with a `static workflow = { name, version }`
 * identity and a `run(ctx, input)` method, and is auto-registered on the engine at boot by the
 * durable provider — no manual `engine.register(...)`.
 */
export default class MakeWorkflow extends BaseCommand {
  static override commandName = 'make:workflow';
  static override description = 'Create a new durable workflow class';
  static override options: CommandOptions = { allowUnknownFlags: true };

  @args.string({ description: 'Name of the workflow' })
  declare name: string;

  override async run(): Promise<void> {
    const codemods = await this.createCodemods();
    await codemods.makeUsingStub(stubsRoot, 'make/workflow/main.stub', {
      flags: this.parsed.flags,
      entity: this.app.generators.createEntity(this.name),
    });
  }
}
