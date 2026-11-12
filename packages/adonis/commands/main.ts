import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import DurableDoctor from './durable_doctor.js';
import DurableWorker from './durable_worker.js';
import DurableExport from './export_run.js';
import DurableLifecycleRepublish from './lifecycle_republish.js';
import MakeWorkflow from './make_workflow.js';
import DurableRetry from './retry.js';
import DurableRuns from './runs.js';
import DurableWork from './work.js';

/**
 * The commands barrel for `@adonis-agora/durable`. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/durable/commands')` (done by this package's `configure`). The ace
 * kernel imports this module and treats it as a commands loader: a {@link ListLoader} over the durable
 * commands (`durable:work`, `durable:worker`, `durable:runs`, `durable:retry`, `durable:export`, `durable:lifecycle:republish`, `make:workflow`, `agora:doctor`, `durable:doctor`)
 * provides their metadata and constructors.
 */
const loader = new ListLoader([
  DurableWork,
  DurableWorker,
  DurableRuns,
  DurableRetry,
  DurableExport,
  DurableLifecycleRepublish,
  MakeWorkflow,
  AgoraDoctor,
  DurableDoctor,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
