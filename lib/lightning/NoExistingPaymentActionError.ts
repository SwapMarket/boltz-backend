class NoExistingPaymentActionError extends Error {
  constructor() {
    super('no existing payment action to recover');
    this.name = 'NoExistingPaymentActionError';
  }
}

export default NoExistingPaymentActionError;
