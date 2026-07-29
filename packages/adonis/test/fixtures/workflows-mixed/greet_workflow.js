// Same workflow name+version as the sibling .ts in this directory, on purpose: if this file were
// ever imported alongside the .ts, the spec's assertion on the run output would catch it.
export default class GreetWorkflow {
  static workflow = { name: 'greet', version: '1' };
  async run(_ctx, input) {
    return `js:${input.name}`;
  }
}
