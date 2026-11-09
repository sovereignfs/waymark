import { loadConfig, type Config, type Problem } from './index';
import { processEnv } from './env';

/** The settings were wrong. `problems` name them, never their values. */
export class ConfigError extends Error {
  constructor(readonly problems: readonly Problem[]) {
    super(`Waymark's settings are wrong: ${problems.join(' ')}`);
    this.name = 'ConfigError';
  }
}

let current: Config | undefined;

/**
 * The settings of this process, read and checked on first use and then kept. The server checks them at start-up and stops on a wrong one
 * (instrumentation-node.ts), so by the time a request asks, they are right; this throws only where that did not run, such as a test.
 */
export function getConfig(): Config {
  if (!current) {
    const result = loadConfig(processEnv());
    if (!result.ok) throw new ConfigError(result.problems);
    current = result.config;
  }
  return current;
}
