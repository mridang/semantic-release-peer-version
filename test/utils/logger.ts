/**
 * @file A logger that records what is written to it, for the tests.
 */

/**
 * A semantic-release style logger that records everything written to it.
 * @returns The logger and the lines it has received.
 * @example
 * ```ts
 * const { logger, lines } = recordingLogger();
 * logger.log('released', 1.2); // lines is ['released 1.2']
 * ```
 */
export function recordingLogger(): {
  logger: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  lines: string[];
} {
  const lines: string[] = [];
  const write = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  return { logger: { log: write, warn: write }, lines };
}
