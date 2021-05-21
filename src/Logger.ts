import type { Runner } from './Runner';
import type { JsonCompatible } from '.';

/**
 * Manages logging updates to a running job.
 */
export class Logger {
  private runner: Runner;

  /**
   * Create a Logger.
   * @param runner The runner of the job
   */
  constructor(runner: Runner) {
    this.runner = runner;
  }

  public async info<T extends JsonCompatible<T>>(
    status: string,
    meta: T
  ): Promise<void> {
    return await this.runner.postUpdate(status, meta);
  }
  public async debug<T extends JsonCompatible<T>>(
    status: string,
    meta: T
  ): Promise<void> {
    if (process.env.OADA_JOBS_LOGGING?.includes('debug')) {
      return await this.runner.postUpdate(status, meta);
    }
  }
  public async trace<T extends JsonCompatible<T>>(
    status: string,
    meta: T
  ): Promise<void> {
    if (process.env.OADA_JOBS_LOGGING?.includes('trace')) {
      return await this.runner.postUpdate(status, meta);
    }
  }
  public async error<T extends JsonCompatible<T>>(
    status: string,
    meta: T
  ): Promise<void> {
    return await this.runner.postUpdate(status, meta);
  }
}
