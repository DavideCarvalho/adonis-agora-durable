import { ListLoader } from '@adonisjs/core/ace';
import DurableWorker from './durable_worker.js';
import DurableExport from './export_run.js';
import MakeWorkflow from './make_workflow.js';
import DurableRetry from './retry.js';
import DurableRuns from './runs.js';
import DurableWork from './work.js';

/**
 * The commands barrel for `@adonis-agora/durable`. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/durable/commands')` (done by this package's `configure`). The ace
 * kernel imports this module and treats it as a commands loader: a {@link ListLoader} over the durable
 * commands (`durable:work`, `durable:worker`, `durable:runs`, `durable:retry`, `durable:export`, `make:workflow`)
 * provides their metadata and constructors.
 */
const loader = new ListLoader([
  DurableWork,
  DurableWorker,
  DurableRuns,
  DurableRetry,
  DurableExport,
  MakeWorkflow,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
