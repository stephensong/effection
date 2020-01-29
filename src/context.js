import { ControlFunction, HaltError } from './control';

export class ExecutionContext {
  static ids = 1;
  get isUnstarted() { return this.state === 'unstarted'; }
  get isRunning() { return this.state === 'running'; }
  get isWaiting() { return this.state === 'waiting'; }
  get isCompleted() { return this.state === 'completed'; }
  get isErrored() { return this.state === 'errored'; }
  get isHalted() { return this.state === 'halted'; }

  get isBlocking() { return this.isRunning || this.isWaiting || this.isUnstarted; }

  get hasBlockingChildren() {
    for (let child of this.children) {
      if (child.isBlocking && child.isRequired) {
        return true;
      }
    }
    return false;
  }

  constructor(parent = undefined, isRequired = true) {
    this.id = this.constructor.ids++;
    this.parent = parent;
    this.children = new Set();
    this.exitHooks = new Set();
    this.state = 'unstarted';
    this.isRequired = isRequired;
    this.mailbox = { messages: new Set(), receivers: new Set() };
    this.resume = this.resume.bind(this);
    this.fail = this.fail.bind(this);
    this.ensure = this.ensure.bind(this);
    this.spawn = this.spawn.bind(this);
  }

  get promise() {
    this._promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.finalizePromise();
    return this._promise;
  }

  finalizePromise() {
    if(this.isCompleted && this.resolve) {
      this.resolve(this.result);
    } else if(this.isErrored && this.reject) {
      this.reject(this.result);
    } else if(this.isHalted && this.reject) {
      this.reject(new HaltError(this.result));
    }
  }

  then(...args) {
    return this.promise.then(...args);
  }

  catch(...args) {
    return this.promise.catch(...args);
  }

  finally(...args) {
    return this.promise.finally(...args);
  }

  get root() {
    if (!this.parent) {
      return this;
    } else {
      return this.parent.root;
    }
  }

  spawn(operation, isRequired) {
    let child = new ExecutionContext(this, isRequired);
    this.children.add(child);
    child.ensure(() => {
      this.children.delete(child);
      if (this.isWaiting && !this.hasBlockingChildren) {
        this.finalize('completed');
      }
    });
    child.enter(operation);
    return child;
  }

  ensure(hook) {
    let run = hook.bind(null, this);
    if (this.isBlocking) {
      this.exitHooks.add(run);
      return () => this.exitHooks.delete(run);
    } else {
      hook();
      return x => x;
    }
  }

  enter(operation) {
    if (this.isUnstarted) {
      let controller = this.createController(operation);
      this.operation = operation;
      this.state = 'running';

      let { resume, fail, ensure, spawn } = this;
      controller.call({ resume, fail, ensure, spawn, context: this });

    } else {
      throw new Error(`
Tried to call #enter() on a Context that has already been finalized. This
should never happen and so is almost assuredly a bug in effection. All of
its users would be in your eternal debt were you to please take the time to
report this issue here:
https://github.com/thefrontside/effection.js/issues/new

Thanks!`);
    }
  }

  halt(reason) {
    if (this.isBlocking) {
      this.finalize('halted', reason);
    }
  }

  resume(value) {
    if (!this.isRunning) { return; }

    this.result = value;
    if (this.hasBlockingChildren) {
      this.state = 'waiting';
    } else {
      this.finalize('completed', value);
    }
  }

  fail(error) {
    this.finalize('errored', error);
  }

  finalize(state, result) {
    this.result = result || this.result;
    this.state = state;
    for (let hook of this.exitHooks) {
      this.exitHooks.delete(hook);
      hook();
    }
    for (let child of this.children) {
      this.children.delete(child);
      child.halt(result);
    }
    this.finalizePromise();
  }

  createController(operation) {
    let controller = ControlFunction.for(operation);
    if (!controller) {
      throw new Error(`cannot find controller for ${operation}`);
    }
    return controller;
  }

  toString(indent = '') {
    let name = this.operation ? this.operation.name || '' : '';
    let children = [...this.children].map(child => `${child.toString(indent + '  ')}`);
    return [`${indent}-> [${this.id}](${name}): ${this.state}`, ...children].join("\n");
  }
}
