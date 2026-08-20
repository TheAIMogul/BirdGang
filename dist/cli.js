#!/usr/bin/env node
/**
 * birdgang - CLI tool for posting tweets and replies
 *
 * Usage:
 *   birdgang tweet "Hello world!"
 *   birdgang reply <tweet-id> "This is a reply"
 *   birdgang reply <tweet-url> "This is a reply"
 *   birdgang read <tweet-id-or-url>
 */
import { createProgram, KNOWN_COMMANDS } from './cli/program.js';
import { createCliContext } from './cli/shared.js';
import { resolveCliInvocation } from './lib/cli-args.js';
const rawArgs = process.argv.slice(2);
const normalizedArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const ctx = createCliContext(normalizedArgs);
const program = createProgram(ctx);
const { argv, showHelp } = resolveCliInvocation(normalizedArgs, KNOWN_COMMANDS);
if (showHelp) {
    program.outputHelp();
    process.exit(0);
}
if (argv) {
    program.parse(argv);
}
else {
    program.parse(['node', 'birdgang', ...normalizedArgs]);
}
//# sourceMappingURL=cli.js.map