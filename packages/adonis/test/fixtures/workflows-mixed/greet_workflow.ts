// Same workflow name+version as the sibling .js in this directory, on purpose: proves the `.ts`
// extension wins and the `.js` twin is never imported (not merely de-duped after both load).
export default class GreetWorkflow {
  static workflow = { name: 'greet', version: '1' };
  async run(_ctx: unknown, input: { name: string }) {
    return `ts:${input.name}`;
  }
}
