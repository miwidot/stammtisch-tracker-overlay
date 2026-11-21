import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard limit; the child is killed and the run fails when exceeded. */
  timeoutMs?: number;
  label?: string;
}

export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<void>;

const TAIL_LINES = 40;

/** Runs a command, forwards its output to stderr, and rejects on non-zero exit, signal or timeout. */
export const runCommand: Runner = (command, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const label = options.label ?? command;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail: string[] = [];
    const forward = (chunk: Buffer): void => {
      process.stderr.write(chunk);
      tail.push(...chunk.toString().split('\n'));
      if (tail.length > TAIL_LINES) tail.splice(0, tail.length - TAIL_LINES);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : undefined;
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error(`${label} timed out after ${options.timeoutMs} ms`));
      if (code === 0) return resolvePromise();
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${label} failed (${reason})\n${tail.join('\n').trim()}`));
    });
  });
