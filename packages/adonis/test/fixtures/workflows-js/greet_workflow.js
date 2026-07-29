export default class GreetWorkflow {
  static workflow = { name: 'greet', version: '1' };
  async run(_ctx, input) {
    return `js:${input.name}`;
  }
}
