import { Step } from '../../../src/step-ref.js';

/** A plain service a container would resolve for the step class below. */
export class Pricing {
  readonly currency = 'BRL';
  quote(amount: number): string {
    return `${this.currency} ${amount}`;
  }
}

/**
 * A step class whose `@Step` body uses a constructor-injected dependency. In an app it carries
 * `@inject()`; here the tests hand discovery a factory that plays the container (the real one needs
 * `reflect-metadata`, which this package does not depend on).
 */
export class PricingSteps {
  constructor(private pricing: Pricing) {}

  @Step('pricing:quote')
  quote(input: { amount: number }) {
    return this.pricing.quote(input.amount);
  }
}
