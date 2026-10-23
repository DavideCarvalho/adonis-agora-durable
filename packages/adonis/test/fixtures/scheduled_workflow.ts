/** A workflow module for the lazy-import schedule tests: default-exported, as in `app/workflows`. */
export default class ScheduledFixtureWorkflow {
  static workflow = { name: 'fixture-scheduled' };
  async run() {
    return 'ok';
  }
}
