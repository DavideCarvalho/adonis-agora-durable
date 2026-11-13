import { ListLoader } from '@adonisjs/core/ace';
import AgoraDoctor from './agora_doctor.js';
import DurableDoctor from './durable_doctor.js';
import DurableWorker from './durable_worker.js';
import DurableExport from './export_run.js';
import DurableHealth from './health.js';
import DurableLifecycleRepublish from './lifecycle_republish.js';
import MakeWorkflow from './make_workflow.js';
import DurableRuns from './runs.js';
import DurableRunsBulk from './runs_bulk.js';
import DurableRunsCancel from './runs_cancel.js';
import DurableRunsContinue from './runs_continue.js';
import DurableRunsEvent from './runs_event.js';
import DurableRunsFan from './runs_fan.js';
import DurableRunsRedispatch from './runs_redispatch.js';
import DurableRunsReplay from './runs_replay.js';
import DurableRunsRetry from './runs_retry.js';
import DurableRunsShow from './runs_show.js';
import DurableRunsSignal from './runs_signal.js';
import DurableRunsUpdate from './runs_update.js';
import DurableRunsValues from './runs_values.js';
import DurableSchedules from './schedules.js';
import DurableSchedulesPause from './schedules_pause.js';
import DurableSchedulesResume from './schedules_resume.js';
import DurableSchedulesTrigger from './schedules_trigger.js';
import DurableTasksComplete from './tasks_complete.js';
import DurableTasksFail from './tasks_fail.js';
import DurableWork from './work.js';
import DurableWorkers from './workers.js';
import DurableWorkflowsLifecycle from './workflows_lifecycle.js';

/**
 * The commands barrel for `@adonis-agora/durable`. Registered in an app's `adonisrc` via
 * `rcFile.addCommand('@adonis-agora/durable/commands')` (done by this package's `configure`). The ace
 * kernel imports this module and treats it as a commands loader: a {@link ListLoader} over the durable
 * commands — the workers (`durable:work`, `durable:worker`), the operator commands that mirror the
 * console (`durable:runs*`, `durable:tasks:*`, `durable:schedules*`, `durable:workers`,
 * `durable:health`, `durable:workflows:lifecycle`, `durable:lifecycle:republish`), `durable:export`,
 * `make:workflow`, `agora:doctor` and `durable:doctor`.
 */
export const DURABLE_COMMANDS = [
  DurableWork,
  DurableWorker,
  DurableRuns,
  DurableRunsShow,
  DurableRunsFan,
  DurableRunsValues,
  DurableRunsEvent,
  DurableRunsRetry,
  DurableRunsReplay,
  DurableRunsRedispatch,
  DurableRunsCancel,
  DurableRunsContinue,
  DurableRunsSignal,
  DurableRunsUpdate,
  DurableRunsBulk,
  DurableTasksComplete,
  DurableTasksFail,
  DurableSchedules,
  DurableSchedulesPause,
  DurableSchedulesResume,
  DurableSchedulesTrigger,
  DurableWorkers,
  DurableHealth,
  DurableWorkflowsLifecycle,
  DurableLifecycleRepublish,
  DurableExport,
  MakeWorkflow,
  AgoraDoctor,
  DurableDoctor,
];

const loader = new ListLoader(DURABLE_COMMANDS);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
