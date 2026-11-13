import DurableSchedulesPause from './schedules_pause.js';

/** `node ace durable:schedules:resume <key>` — resume a paused schedule fleet-wide. */
export default class DurableSchedulesResume extends DurableSchedulesPause {
  static override commandName = 'durable:schedules:resume';
  static override description = 'Resume a paused schedule fleet-wide';
  protected override readonly verb = 'resume' as const;
}
