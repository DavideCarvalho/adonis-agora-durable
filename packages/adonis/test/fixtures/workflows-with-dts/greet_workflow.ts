export default class GreetWorkflow {
  static workflow = { name: 'greet', version: '1' };
  async run(_ctx: unknown, input: { name: string }) {
    return `ts:${input.name}`;
  }
}
