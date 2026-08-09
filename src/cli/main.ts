/**
 * Parses CLI arguments, delegates parsed generate and run commands to runtime,
 * and selects the only process-exit boundary in the product.
 *
 * The `generate [files...]` and `run [files...]` subcommands both treat
 * positionals as literal prompt paths, delegating an empty list to configured
 * discovery. Generate parses generation policy and rendering flags; run parses
 * replay policy including path grep, target, headed execution, cache policy,
 * stale handling, provider override, color control, and JSON rendering. The parser accepts
 * only the supported provider names, keeping provider selection a runtime
 * concern rather than a usecase option. A bare `--` ends option parsing so a
 * prompt whose literal path begins with `--` remains addressable.
 *
 * Top-level `--version` and `--help` short-circuit before subcommand lookup;
 * command-local help does likewise after a recognized subcommand. Version
 * text uses the build-time `__VERSION__` constant rather than reading package
 * metadata at runtime, so the source and bundled entry paths agree. Invalid
 * commands or flags, malformed command arguments, and missing option values
 * write plain-text usage to stderr and exit 2 without a report envelope.
 *
 * For either valid command, this layer creates one `AbortController`, aborting
 * it when `SIGINT` or `SIGTERM` arrives, and passes its signal with the parsed
 * input to the matching runtime command. Runtime returns an envelope and
 * selected exit code; `--json` writes exactly `JSON.stringify(envelope)`,
 * while human output renders that same envelope with ANSI styling disabled by
 * `--no-color`. After output has been written, this
 * module sets the selected process exit code and lets Node exit naturally once
 * pending stream writes have drained.
 *
 * The parser stays hand-written because the small fixed flag surface needs no
 * dependency or a second command grammar. This layer imports only runtime:
 * configuration, provider selection, errors, and report construction remain
 * on the composition side of that boundary.
 */
import { runGenerateCommand } from '#runtime/generate-command.js';
import { runRunCommand } from '#runtime/run-command.js';

interface ParsedGenerateCommand {
  readonly command: 'generate';
  readonly input: {
    readonly files: readonly string[];
    readonly strict: boolean;
    readonly force: boolean;
    readonly dryRun: boolean;
    readonly target?: string;
    readonly aiProviderOverride?: 'claude' | 'codex';
    readonly allowEmpty: boolean;
    readonly list: boolean;
    readonly configPathOverride?: string;
    readonly cwd: string;
    readonly signal: AbortSignal;
  };
  readonly json: boolean;
  readonly color: boolean;
}

interface ParsedRunCommand {
  readonly command: 'run';
  readonly input: {
    readonly files: readonly string[];
    readonly grep?: RegExp;
    readonly target?: string;
    readonly headed: boolean;
    readonly cacheOnly: boolean;
    readonly stale: 'fail' | 'regenerate';
    readonly aiProviderOverride?: 'claude' | 'codex';
    readonly cwd: string;
    readonly signal: AbortSignal;
  };
  readonly json: boolean;
  readonly color: boolean;
}

const USAGE = `Usage: ambercast <command> [options]\n\nCommands:\n  generate [files...]  Generate deterministic plans\n  run [files...]       Replay deterministic plans\n\nGenerate options:\n  --strict  --force  --dry-run  --target <name>  --ai <claude|codex>\n  --allow-empty  --list  --json  --config <path>  --no-color\n\nRun options:\n  --grep <pattern>  --target <name>  --headed  --json  --cache-only  --no-color\n  --stale <fail>\n`;

function writeUsage(stream: NodeJS.WritableStream): void {
  stream.write(USAGE);
}

function colorize(value: string, color: string, enabled: boolean): string {
  return enabled ? `\u001B[${color}m${value}\u001B[0m` : value;
}

function renderHumanReport(envelope: unknown, color: boolean): string {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return `${String(envelope)}\n`;
  }

  const report = envelope as Record<string, unknown>;
  const results = Array.isArray(report.results) ? report.results : [];
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const lines = results.map((result) => {
    const item = result as Record<string, unknown>;
    const status = String(item.status ?? 'unknown');
    const statusColor = status === 'failed' ? '31' : status === 'would-generate' ? '33' : '32';
    return `${colorize(status, statusColor, color)} ${String(item.file ?? item.id ?? '')}`.trimEnd();
  });

  for (const error of errors) {
    const item = error as Record<string, unknown>;
    lines.push(`${colorize('error', '31', color)} ${String(item.message ?? 'Unknown error')}`);
  }

  return `${lines.join('\n')}${lines.length === 0 ? '' : '\n'}`;
}

function parseGenerate(argv: readonly string[], signal: AbortSignal): ParsedGenerateCommand | string {
  const separator = argv.indexOf('--');
  if (argv.slice(0, separator === -1 ? undefined : separator).includes('--help')) {
    return 'help';
  }

  const files: string[] = [];
  let strict = false;
  let force = false;
  let dryRun = false;
  let target: string | undefined;
  let aiProviderOverride: 'claude' | 'codex' | undefined;
  let allowEmpty = false;
  let list = false;
  let json = false;
  let configPathOverride: string | undefined;
  let color = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--') {
      files.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      files.push(argument);
      continue;
    }

    if (argument === '--strict') {
      strict = true;
    } else if (argument === '--force') {
      force = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--allow-empty') {
      allowEmpty = true;
    } else if (argument === '--list') {
      list = true;
    } else if (argument === '--json') {
      json = true;
    } else if (argument === '--no-color') {
      color = false;
    } else if (argument === '--target' || argument === '--ai' || argument === '--config') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return `Missing value for ${argument}.`;
      }

      index += 1;
      if (argument === '--target') {
        target = value;
      } else if (argument === '--config') {
        configPathOverride = value;
      } else if (value === 'claude' || value === 'codex') {
        aiProviderOverride = value;
      } else {
        return 'The --ai value must be claude or codex.';
      }
    } else {
      return `Unknown generate option: ${argument}.`;
    }
  }

  return {
    command: 'generate',
    input: {
      files,
      strict,
      force,
      dryRun,
      ...(target === undefined ? {} : { target }),
      ...(aiProviderOverride === undefined ? {} : { aiProviderOverride }),
      allowEmpty,
      list,
      ...(configPathOverride === undefined ? {} : { configPathOverride }),
      cwd: process.cwd(),
      signal,
    },
    json,
    color,
  };
}

/**
 * Parses the `run [files...]` replay surface before it crosses into runtime.
 *
 * Positional files identify literal prompts; with none, runtime uses configured
 * discovery. `--grep` filters those paths, `--target` selects a configured
 * target, `--headed` requests visible browser execution, `--json` selects the
 * report rendering, and `--no-color` disables its ANSI styling. `--cache-only`
 * is accepted for forward compatibility but has no effect because replay never
 * falls back to AI resolution. `--stale` accepts `fail` and `regenerate` as enum
 * values, while runtime rejects `regenerate` as an unavailable option before
 * touching files. `--ai` retains the shared CLI provider-override syntax without
 * making replay resolve a provider.
 *
 * `--grep` constructs its regular expression here rather than deferring it to
 * runtime. A malformed pattern is argument-shape validation, like the
 * parser's existing eager `--ai` value check, so parsing returns plain-text
 * usage with exit 2 and no report envelope instead of creating a runtime
 * `ConfigInvalidError`.
 */
function parseRun(argv: readonly string[], signal: AbortSignal): ParsedRunCommand | string {
  const separator = argv.indexOf('--');
  if (argv.slice(0, separator === -1 ? undefined : separator).includes('--help')) {
    return 'help';
  }

  const files: string[] = [];
  let grep: RegExp | undefined;
  let target: string | undefined;
  let headed = false;
  let json = false;
  let cacheOnly = false;
  let stale: 'fail' | 'regenerate' = 'fail';
  let aiProviderOverride: 'claude' | 'codex' | undefined;
  let color = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--') {
      files.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      files.push(argument);
      continue;
    }

    if (argument === '--headed') {
      headed = true;
    } else if (argument === '--json') {
      json = true;
    } else if (argument === '--cache-only') {
      cacheOnly = true;
    } else if (argument === '--no-color') {
      color = false;
    } else if (argument === '--grep' || argument === '--target' || argument === '--stale' || argument === '--ai') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return `Missing value for ${argument}.`;
      }

      index += 1;
      if (argument === '--grep') {
        try {
          grep = new RegExp(value);
        } catch {
          return 'The --grep value must be a valid regular expression.';
        }
      } else if (argument === '--target') {
        target = value;
      } else if (argument === '--stale') {
        if (value !== 'fail' && value !== 'regenerate') {
          return 'The --stale value must be fail or regenerate.';
        }
        stale = value;
      } else if (value === 'claude' || value === 'codex') {
        aiProviderOverride = value;
      } else {
        return 'The --ai value must be claude or codex.';
      }
    } else {
      return `Unknown run option: ${argument}.`;
    }
  }

  return {
    command: 'run',
    input: {
      files,
      ...(grep === undefined ? {} : { grep }),
      ...(target === undefined ? {} : { target }),
      headed,
      cacheOnly,
      stale,
      ...(aiProviderOverride === undefined ? {} : { aiProviderOverride }),
      cwd: process.cwd(),
      signal,
    },
    json,
    color,
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  if (argv.length === 0) {
    writeUsage(stdout);
    process.exitCode = 0;
    return;
  }

  if (argv[0] === '--version') {
    stdout.write(`ambercast v${__VERSION__}\n`);
    process.exitCode = 0;
    return;
  }
  if (argv[0] === '--help') {
    writeUsage(stdout);
    process.exitCode = 0;
    return;
  }
  if (argv[0] !== 'generate' && argv[0] !== 'run') {
    stderr.write(`Unknown command: ${argv[0]}.\n`);
    writeUsage(stderr);
    process.exitCode = 2;
    return;
  }

  const controller = new AbortController();
  const parsed = argv[0] === 'generate'
    ? parseGenerate(argv.slice(1), controller.signal)
    : parseRun(argv.slice(1), controller.signal);
  if (typeof parsed === 'string') {
    if (parsed === 'help') {
      writeUsage(stdout);
      process.exitCode = 0;
      return;
    }

    stderr.write(`${parsed}\n`);
    writeUsage(stderr);
    process.exitCode = 2;
    return;
  }

  const abort = (signal: NodeJS.Signals): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Received ${signal}.`));
    }
  };
  const onSigint = (): void => abort('SIGINT');
  const onSigterm = (): void => abort('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    try {
      const output = parsed.command === 'generate'
        ? await runGenerateCommand(parsed.input)
        : await runRunCommand(parsed.input);
      stdout.write(parsed.json ? `${JSON.stringify(output.envelope)}\n` : renderHumanReport(output.envelope, parsed.color));
      process.exitCode = output.exitCode;
    } catch {
      stderr.write(`The ${parsed.command} command crashed unexpectedly.\n`);
      process.exitCode = 3;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
