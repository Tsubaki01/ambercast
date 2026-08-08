/**
 * Parses CLI arguments, delegates parsed generation to runtime, and selects
 * the only process-exit boundary in the product.
 *
 * The only subcommand is `generate [files...]`. Its positional values are
 * literal prompt paths; an empty list delegates matching to configured
 * discovery. Its flags are `--strict`, `--force`, `--dry-run`,
 * `--target <name>`, `--ai <claude|codex>`, `--allow-empty`, `--list`,
 * `--json`, `--config <path>`, and `--no-color`. The parser accepts only those
 * provider names, keeping provider selection a runtime concern rather than a
 * usecase option.
 *
 * Top-level `--version` and `--help` short-circuit before subcommand lookup;
 * command-local help does likewise after `generate` is recognized. Version
 * text uses the build-time `__VERSION__` constant rather than reading package
 * metadata at runtime, so the source and bundled entry paths agree. Invalid
 * commands or flags, and missing values for `--target`, `--ai`, or `--config`,
 * write plain-text usage to stderr and exit 2 without a report envelope.
 *
 * For a valid generate invocation, this layer creates one `AbortController`,
 * aborting it when `SIGINT` or `SIGTERM` arrives, and passes its signal with the
 * parsed input to runtime. Runtime returns an envelope and selected exit code;
 * `--json` writes exactly `JSON.stringify(envelope)`, while human output renders
 * that same envelope with ANSI styling disabled by `--no-color`. After output
 * has been written, this module makes the single final `process.exit` call.
 *
 * The parser stays hand-written because the small fixed flag surface needs no
 * dependency or a second command grammar. This layer imports only runtime:
 * configuration, provider selection, errors, and report construction remain
 * on the composition side of that boundary.
 */
import { runGenerateCommand } from '#runtime/generate-command.js';

interface ParsedGenerateCommand {
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

const USAGE = `Usage: ambercast <command> [options]\n\nCommands:\n  generate [files...]  Generate deterministic plans\n\nGenerate options:\n  --strict  --force  --dry-run  --target <name>  --ai <claude|codex>\n  --allow-empty  --list  --json  --config <path>  --no-color\n`;

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
  if (argv.includes('--help')) {
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

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  if (argv.length === 0) {
    writeUsage(stdout);
    process.exit(0);
    return;
  }

  if (argv[0] === '--version') {
    stdout.write(`ambercast v${__VERSION__}\n`);
    process.exit(0);
    return;
  }
  if (argv[0] === '--help') {
    writeUsage(stdout);
    process.exit(0);
    return;
  }
  if (argv[0] !== 'generate') {
    stderr.write(`Unknown command: ${argv[0]}.\n`);
    writeUsage(stderr);
    process.exit(2);
    return;
  }

  const controller = new AbortController();
  const parsed = parseGenerate(argv.slice(1), controller.signal);
  if (typeof parsed === 'string') {
    if (parsed === 'help') {
      writeUsage(stdout);
      process.exit(0);
      return;
    }

    stderr.write(`${parsed}\n`);
    writeUsage(stderr);
    process.exit(2);
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
    const output = await runGenerateCommand(parsed.input);
    stdout.write(parsed.json ? `${JSON.stringify(output.envelope)}\n` : renderHumanReport(output.envelope, parsed.color));
    process.exit(output.exitCode);
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
