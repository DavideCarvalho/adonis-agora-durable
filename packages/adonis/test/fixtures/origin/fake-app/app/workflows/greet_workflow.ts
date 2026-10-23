/** An app-local workflow, discovered by scanning `app/workflows`: it derives the app's own name. */
export default class GreetWorkflow {
  static workflow = { name: 'fixture-app-greet' };
  async run() {
    return 'hi';
  }
}
