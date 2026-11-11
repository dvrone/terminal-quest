/**
 * commands.js — Shell parser and the Linux command implementations.
 *
 * Pipeline: raw input -> tokenize() -> parse() -> Shell.run() -> command.run()
 *
 * Supported shell features: quoting ('..' ".." \), ~ and $VAR expansion,
 * wildcards (* ? [..]), pipes (|), sequencing (; and &&).
 * Not supported on purpose: redirection (> <), background jobs (&), ||.
 *
 * Commands never touch the host OS; they only operate on the virtual
 * filesystem (filesystem.js) and return plain data:
 *   { out: string, err: string, code: number, clear?: boolean }
 */
(function (global) {
  'use strict';
  const TQ = (global.TQ = global.TQ || {});
  const ENV = TQ.ENV;
  const FsError = TQ.FsError;

  /* ======================================================================
     Small helpers
     ====================================================================== */

  const ok = (out) => ({ out: out || '', err: '', code: 0 });
  const fail = (err, code) => ({ out: '', err, code: code === undefined ? 1 : code });
  const fsMessage = (error) => TQ.FS_MESSAGES[error.code] || 'Unknown error';
  const pad = (n, width) => String(n).padStart(width || 2, '0');
  const plural = (n, one, many) => (n === 1 ? one : many);

  /** Split text into lines, ignoring the trailing newline. */
  function textLines(text) {
    if (!text) return [];
    return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  }

  /** Join lines with a trailing newline (empty list -> empty string). */
  function joinLines(lines) {
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  function usageError(cmd, message) {
    return `${cmd}: ${message}\nTry 'help ${cmd}' for more information.`;
  }

  /**
   * Minimal option parser shared by the commands.
   *   flags:   string of boolean short flags ("alh")
   *   values:  string of short options that take a value ("n")
   *   long:    map of long option name -> short flag
   *   numeric: accept "-5" as shorthand for "-n 5"
   * Returns { flags:Set, values:{}, operands:[] } or { error }.
   */
  function parseArgs(args, spec) {
    const flags = new Set();
    const values = {};
    const operands = [];
    const flagChars = (spec && spec.flags) || '';
    const valueChars = (spec && spec.values) || '';
    const long = (spec && spec.long) || {};
    let optionsEnded = false;

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (optionsEnded || arg === '-' || !arg.startsWith('-')) {
        operands.push(arg);
        continue;
      }
      if (arg === '--') { optionsEnded = true; continue; }
      if (arg.startsWith('--')) {
        const [name, inline] = arg.slice(2).split(/=(.*)/s);
        const short = long[name];
        if (!short) return { error: `unrecognized option '--${name}'` };
        if (valueChars.includes(short)) {
          const value = inline !== undefined ? inline : args[++i];
          if (value === undefined) return { error: `option '--${name}' requires an argument` };
          values[short] = value;
        } else {
          flags.add(short);
        }
        continue;
      }
      if (spec && spec.numeric && /^-\d+$/.test(arg)) { values.n = arg.slice(1); continue; }
      for (let j = 1; j < arg.length; j += 1) {
        const c = arg[j];
        if (valueChars.includes(c)) {
          const attached = arg.slice(j + 1);
          const value = attached !== '' ? attached : args[++i];
          if (value === undefined) return { error: `option requires an argument -- '${c}'` };
          values[c] = value;
          break;
        } else if (flagChars.includes(c)) {
          flags.add(c);
        } else {
          return { error: `invalid option -- '${c}'` };
        }
      }
    }
    return { flags, values, operands };
  }

  /** Commands that take no operands. Returns an error result or null. */
  function rejectOperands(name, args, flagChars) {
    const parsed = parseArgs(args, { flags: flagChars || '' });
    if (parsed.error) return fail(usageError(name, parsed.error), 2);
    if (parsed.operands.length) return fail(usageError(name, `extra operand '${parsed.operands[0]}'`), 1);
    return null;
  }

  /** Human-readable size in the style of `ls -h` / `df -h`. */
  function humanSize(bytes) {
    const units = ['', 'K', 'M', 'G', 'T'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    if (unit === 0) return String(bytes);
    return (value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value)) + units[unit];
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function timezoneLabel(date) {
    const offset = -date.getTimezoneOffset();
    if (offset === 0) return 'UTC';
    const sign = offset < 0 ? '-' : '+';
    const abs = Math.abs(offset);
    const minutes = abs % 60;
    return sign + pad(Math.floor(abs / 60)) + (minutes ? pad(minutes) : '');
  }

  /** Supports the common strftime codes used with `date +FORMAT`. */
  function formatDate(date, format) {
    const fmt = format || '%a %b %e %H:%M:%S %Z %Y';
    return fmt.replace(/%([a-zA-Z%])/g, (match, code) => {
      switch (code) {
        case 'Y': return String(date.getFullYear());
        case 'y': return pad(date.getFullYear() % 100);
        case 'm': return pad(date.getMonth() + 1);
        case 'd': return pad(date.getDate());
        case 'e': return String(date.getDate()).padStart(2, ' ');
        case 'H': return pad(date.getHours());
        case 'I': return pad(date.getHours() % 12 || 12);
        case 'M': return pad(date.getMinutes());
        case 'S': return pad(date.getSeconds());
        case 'p': return date.getHours() < 12 ? 'AM' : 'PM';
        case 'A': return DAYS_FULL[date.getDay()];
        case 'a': return DAYS[date.getDay()];
        case 'B': return MONTHS_FULL[date.getMonth()];
        case 'b': return MONTHS[date.getMonth()];
        case 'F': return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        case 'T': return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        case 'Z': return timezoneLabel(date);
        case 's': return String(Math.floor(date.getTime() / 1000));
        case 'n': return '\n';
        case '%': return '%';
        default: return match;
      }
    });
  }

  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Convert a POSIX basic regular expression to a JavaScript one. */
  function breToJs(pattern) {
    const special = '+?|(){}';
    let out = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i];
      if (c === '\\' && i + 1 < pattern.length) {
        const next = pattern[++i];
        out += special.includes(next) ? next : '\\' + next;
      } else if (special.includes(c)) {
        out += '\\' + c;
      } else {
        out += c;
      }
    }
    return out;
  }

  /** Display form of a child path found while walking `start` (find/grep). */
  const displayJoin = (dir, name) => (dir.endsWith('/') ? dir + name : dir + '/' + name);

  /* ======================================================================
     Command implementations
     ====================================================================== */

  const BOOT_TIME = Date.now() - (2 * 3600 + 14 * 60) * 1000;

  const COMMANDS = [];
  const define = (cmd) => COMMANDS.push(cmd);

  /* ------------------------------------------------------------------ Basic */

  define({
    name: 'pwd', category: 'Basic', summary: 'Print the current working directory',
    usage: ['pwd'],
    run(ctx) {
      const bad = rejectOperands('pwd', ctx.args, 'LP');
      return bad || ok(ctx.cwd + '\n');
    },
  });

  define({
    name: 'whoami', category: 'Basic', summary: 'Print the current user name',
    usage: ['whoami'],
    run(ctx) {
      const bad = rejectOperands('whoami', ctx.args);
      return bad || ok(ENV.USER + '\n');
    },
  });

  define({
    name: 'hostname', category: 'Basic', summary: 'Show the name of this computer',
    usage: ['hostname'],
    run(ctx) {
      const bad = rejectOperands('hostname', ctx.args, 's');
      return bad || ok(ENV.HOST + '\n');
    },
  });

  define({
    name: 'date', category: 'Basic', summary: 'Show the current date and time',
    usage: ['date [+FORMAT]'], examples: ["date +%Y-%m-%d", "date '+%H:%M'"],
    run(ctx) {
      const parsed = parseArgs(ctx.args, { flags: '' });
      if (parsed.error) return fail(usageError('date', parsed.error), 1);
      const operand = parsed.operands[0];
      if (parsed.operands.length > 1) return fail(`date: extra operand '${parsed.operands[1]}'`);
      if (operand !== undefined && !operand.startsWith('+')) return fail(`date: invalid date '${operand}'`);
      return ok(formatDate(new Date(), operand ? operand.slice(1) : '') + '\n');
    },
  });

  define({
    name: 'clear', category: 'Basic', summary: 'Clear the terminal screen',
    usage: ['clear'],
    run(ctx) {
      const bad = rejectOperands('clear', ctx.args);
      return bad || { out: '', err: '', code: 0, clear: true };
    },
  });

  define({
    name: 'help', category: 'Basic', summary: 'List commands or show help for one command',
    usage: ['help', 'help <command>'],
    run(ctx) {
      const registry = ctx.shell.registry;
      if (ctx.args.length > 1) return fail('help: too many arguments');
      if (ctx.args.length === 1) {
        const cmd = registry.get(ctx.args[0]);
        if (!cmd) return fail(`help: no help topics match '${ctx.args[0]}'.`);
        const lines = [`${cmd.name} — ${cmd.summary}`, '', 'Usage:'];
        cmd.usage.forEach((u) => lines.push('  ' + u));
        if (cmd.options) {
          lines.push('', 'Options:');
          cmd.options.forEach((o) => lines.push('  ' + o));
        }
        if (cmd.examples) {
          lines.push('', 'Examples:');
          cmd.examples.forEach((e) => lines.push('  ' + e));
        }
        return ok(joinLines(lines));
      }
      const categories = ['Basic', 'Navigation', 'File management', 'File reading', 'Search', 'System'];
      const lines = ['Terminal Quest — available commands', ''];
      categories.forEach((category) => {
        lines.push(category);
        [...registry.values()].filter((c) => c.category === category)
          .forEach((c) => lines.push('  ' + c.name.padEnd(10) + c.summary));
        lines.push('');
      });
      lines.push('Type "help <command>" for usage details.');
      lines.push('Shell features: pipes (|), && and ;, quotes, wildcards (*), ~ and Tab completion.');
      return ok(joinLines(lines));
    },
  });

  /* ------------------------------------------------------------- Navigation */

  /** Format `ls -l` style permission/date columns. */
  function longListing(fs, entries, human) {
    const rows = entries.map(({ name, node }) => {
      const isDir = node.type === 'dir';
      const date = new Date(node.mtime);
      return {
        perms: isDir ? 'drwxr-xr-x' : '-rw-r--r--',
        links: isDir ? 2 : 1,
        size: human ? humanSize(fs.size(node)) : String(fs.size(node)),
        date: `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
        name,
      };
    });
    const linkWidth = Math.max(1, ...rows.map((r) => String(r.links).length));
    const sizeWidth = Math.max(1, ...rows.map((r) => r.size.length));
    return rows.map((r) =>
      `${r.perms} ${String(r.links).padStart(linkWidth)} ${ENV.USER} ${ENV.USER} ${r.size.padStart(sizeWidth)} ${r.date} ${r.name}`);
  }

  define({
    name: 'ls', category: 'Navigation', summary: 'List directory contents',
    usage: ['ls [options] [path...]'],
    options: ['-a  include hidden files', '-l  long listing', '-h  human-readable sizes (with -l)', '-1  one entry per line', '-R  list subdirectories recursively', '-r  reverse order', '-F  mark directories with /'],
    examples: ['ls', 'ls -la ~/Documents', 'ls /var/log'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'aAlh1RrF' });
      if (opts.error) return fail(usageError('ls', opts.error), 2);
      const { fs } = ctx;
      const flags = opts.flags;
      const operands = opts.operands.length ? opts.operands : ['.'];
      const showHeadings = operands.length > 1 || flags.has('R');
      const errors = [];
      const out = [];

      const formatEntries = (entries) => {
        const decorated = entries.map(({ name, node }) => ({
          name: flags.has('F') && node.type === 'dir' && name !== '.' && name !== '..' ? name + '/' : name,
          node,
        }));
        if (flags.has('l')) return longListing(fs, decorated, flags.has('h'));
        const names = decorated.map((e) => e.name);
        if (flags.has('1') || ctx.piped) return names;
        return names.length ? [names.join('  ')] : [];
      };

      const listDirectory = (display, abs, node) => {
        let entries = fs.list(abs).map(([name, child]) => ({ name, node: child }));
        if (!flags.has('a') && !flags.has('A')) entries = entries.filter((e) => !e.name.startsWith('.'));
        if (flags.has('a')) {
          const parent = fs.getNode(fs.dirname(abs));
          entries = [{ name: '.', node }, { name: '..', node: parent }, ...entries];
        }
        if (flags.has('r')) entries.reverse();
        if (showHeadings) out.push(display + ':');
        if (flags.has('l')) {
          const blocks = entries.reduce((sum, e) => sum + (e.node.type === 'dir' ? 4 : Math.max(4, Math.ceil(fs.size(e.node) / 4096) * 4)), 0);
          out.push(`total ${blocks}`);
        }
        out.push(...formatEntries(entries));
        if (flags.has('R')) {
          entries.filter((e) => e.node.type === 'dir' && e.name !== '.' && e.name !== '..').forEach((e) => {
            out.push('');
            listDirectory(displayJoin(display, e.name), fs.join(abs, e.name), e.node);
          });
        }
      };

      const files = [];
      const dirs = [];
      operands.forEach((operand) => {
        const abs = ctx.path(operand);
        const node = fs.getNode(abs);
        if (!node) {
          errors.push(`ls: cannot access '${operand}': ${fsMessage(new FsError(fs.exists(fs.dirname(abs)) && !fs.isDir(fs.dirname(abs)) ? 'ENOTDIR' : 'ENOENT', abs))}`);
          return;
        }
        (node.type === 'dir' ? dirs : files).push({ operand, abs, node });
      });

      if (files.length) out.push(...formatEntries(files.map((f) => ({ name: f.operand, node: f.node }))));
      dirs.forEach((d, index) => {
        if (index > 0 || files.length) out.push('');
        listDirectory(d.operand, d.abs, d.node);
      });
      return { out: joinLines(out), err: errors.join('\n'), code: errors.length ? 2 : 0 };
    },
  });

  define({
    name: 'cd', category: 'Navigation', summary: 'Change the current directory',
    usage: ['cd [path]', 'cd ..', 'cd ~', 'cd -'],
    examples: ['cd Documents', 'cd /var/log', 'cd ..'],
    run(ctx) {
      const { shell, fs } = ctx;
      if (ctx.args.length > 1) return fail('bash: cd: too many arguments');
      let target = ctx.args[0];
      let printPath = false;
      if (target === undefined || target === '' ) target = ENV.HOME;
      else if (target === '-') { target = shell.oldpwd; printPath = true; }
      const abs = ctx.path(target);
      const node = fs.getNode(abs);
      if (!node) {
        const parentIsFile = fs.isFile(fs.dirname(abs));
        return fail(`bash: cd: ${ctx.args[0]}: ${parentIsFile ? 'Not a directory' : 'No such file or directory'}`);
      }
      if (node.type !== 'dir') return fail(`bash: cd: ${ctx.args[0]}: Not a directory`);
      shell.oldpwd = shell.cwd;
      shell.cwd = abs;
      return ok(printPath ? abs + '\n' : '');
    },
  });

  define({
    name: 'tree', category: 'Navigation', summary: 'Show a directory as a tree',
    usage: ['tree [options] [path]'],
    options: ['-a  include hidden files', '-d  directories only', '-L N  limit depth to N levels'],
    examples: ['tree', 'tree ~/Projects', 'tree -L 1 /'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'ad', values: 'L' });
      if (opts.error) return fail(usageError('tree', opts.error), 2);
      let maxDepth = 0;
      if (opts.values.L !== undefined) {
        maxDepth = parseInt(opts.values.L, 10);
        if (!/^\d+$/.test(opts.values.L) || maxDepth < 1) return fail('tree: Invalid level, must be greater than 0.');
      }
      const { fs } = ctx;
      const showHidden = opts.flags.has('a');
      const dirsOnly = opts.flags.has('d');
      const operands = opts.operands.length ? opts.operands : ['.'];
      const lines = [];
      let dirCount = 0;
      let fileCount = 0;
      let code = 0;

      const walk = (abs, prefix, level) => {
        let entries = fs.list(abs);
        if (!showHidden) entries = entries.filter(([name]) => !name.startsWith('.'));
        if (dirsOnly) entries = entries.filter(([, node]) => node.type === 'dir');
        entries.forEach(([name, node], index) => {
          const last = index === entries.length - 1;
          lines.push(prefix + (last ? '└── ' : '├── ') + name);
          if (node.type === 'dir') {
            dirCount += 1;
            if (!maxDepth || level < maxDepth) walk(fs.join(abs, name), prefix + (last ? '    ' : '│   '), level + 1);
          } else {
            fileCount += 1;
          }
        });
      };

      operands.forEach((operand) => {
        const abs = ctx.path(operand);
        const node = fs.getNode(abs);
        if (!node) { lines.push(`${operand} [error opening dir]`); code = 2; return; }
        lines.push(operand);
        if (node.type === 'dir') walk(abs, '', 1);
        else fileCount += 1;
      });

      let summary = `${dirCount} ${plural(dirCount, 'directory', 'directories')}`;
      if (!dirsOnly) summary += `, ${fileCount} ${plural(fileCount, 'file', 'files')}`;
      lines.push('', summary);
      return { out: joinLines(lines), err: '', code };
    },
  });

  /* -------------------------------------------------------- File management */

  define({
    name: 'mkdir', category: 'File management', summary: 'Create directories',
    usage: ['mkdir [-p] <directory>...'],
    options: ['-p  create parent directories as needed'],
    examples: ['mkdir backup', 'mkdir -p projects/web/css'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'pv' });
      if (opts.error) return fail(usageError('mkdir', opts.error), 1);
      if (!opts.operands.length) return fail(usageError('mkdir', 'missing operand'));
      const errors = [];
      const out = [];
      opts.operands.forEach((operand) => {
        try {
          ctx.fs.mkdir(ctx.path(operand), { parents: opts.flags.has('p') });
          if (opts.flags.has('v')) out.push(`mkdir: created directory '${operand}'`);
        } catch (err) {
          if (!(err instanceof FsError)) throw err;
          errors.push(`mkdir: cannot create directory '${operand}': ${fsMessage(err)}`);
        }
      });
      return { out: joinLines(out), err: errors.join('\n'), code: errors.length ? 1 : 0 };
    },
  });

  define({
    name: 'touch', category: 'File management', summary: 'Create empty files or update timestamps',
    usage: ['touch <file>...'],
    examples: ['touch notes.txt', 'touch a.txt b.txt'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'c' });
      if (opts.error) return fail(usageError('touch', opts.error), 1);
      if (!opts.operands.length) return fail(usageError('touch', 'missing file operand'));
      const errors = [];
      opts.operands.forEach((operand) => {
        try {
          const abs = ctx.path(operand);
          if (opts.flags.has('c') && !ctx.fs.exists(abs)) return;
          ctx.fs.touch(abs);
        } catch (err) {
          if (!(err instanceof FsError)) throw err;
          errors.push(`touch: cannot touch '${operand}': ${fsMessage(err)}`);
        }
      });
      return { out: '', err: errors.join('\n'), code: errors.length ? 1 : 0 };
    },
  });

  /** Shared logic for cp and mv. */
  function transfer(ctx, name, isMove) {
    const opts = parseArgs(ctx.args, { flags: isMove ? 'v' : 'rRv' });
    if (opts.error) return fail(usageError(name, opts.error), 1);
    const operands = opts.operands;
    if (operands.length === 0) return fail(usageError(name, 'missing file operand'));
    if (operands.length === 1) return fail(usageError(name, `missing destination file operand after '${operands[0]}'`));
    const { fs } = ctx;
    const sources = operands.slice(0, -1);
    const destOperand = operands[operands.length - 1];
    const destAbs = ctx.path(destOperand);
    const destNode = fs.getNode(destAbs);
    const destIsDir = Boolean(destNode && destNode.type === 'dir');
    const recursive = opts.flags.has('r') || opts.flags.has('R');
    if (sources.length > 1 && !destIsDir) return fail(`${name}: target '${destOperand}' is not a directory`);

    const out = [];
    const errors = [];
    sources.forEach((source) => {
      const srcAbs = ctx.path(source);
      const srcNode = fs.getNode(srcAbs);
      if (!srcNode) { errors.push(`${name}: cannot ${isMove ? 'stat' : 'stat'} '${source}': No such file or directory`); return; }
      if (!isMove && srcNode.type === 'dir' && !recursive) { errors.push(`cp: -r not specified; omitting directory '${source}'`); return; }
      const target = destIsDir ? fs.join(destAbs, fs.basename(srcAbs)) : destAbs;
      if (srcAbs === target) { errors.push(`${name}: '${source}' and '${destOperand}' are the same file`); return; }
      if (srcNode.type === 'dir' && target.startsWith(srcAbs + '/')) {
        errors.push(isMove
          ? `mv: cannot move '${source}' to a subdirectory of itself, '${destOperand}'`
          : `cp: cannot copy a directory, '${source}', into itself, '${destOperand}'`);
        return;
      }
      try {
        if (isMove) fs.move(srcAbs, target); else fs.copy(srcAbs, target);
        if (opts.flags.has('v')) out.push(isMove ? `renamed '${source}' -> '${destOperand}'` : `'${source}' -> '${destOperand}'`);
      } catch (err) {
        if (!(err instanceof FsError)) throw err;
        const verb = isMove ? 'move' : 'copy';
        const kind = srcNode.type === 'dir' ? 'directory' : 'regular file';
        errors.push(`${name}: cannot ${isMove ? verb : 'create ' + kind} '${destOperand}': ${fsMessage(err)}`);
      }
    });
    return { out: joinLines(out), err: errors.join('\n'), code: errors.length ? 1 : 0 };
  }

  define({
    name: 'cp', category: 'File management', summary: 'Copy files and directories',
    usage: ['cp [-r] <source>... <destination>'],
    options: ['-r  copy directories recursively', '-v  explain what is being done'],
    examples: ['cp notes.txt notes.bak', 'cp -r Projects /tmp/backup'],
    run: (ctx) => transfer(ctx, 'cp', false),
  });

  define({
    name: 'mv', category: 'File management', summary: 'Move or rename files and directories',
    usage: ['mv <source>... <destination>'],
    options: ['-v  explain what is being done'],
    examples: ['mv draft.txt final.txt', 'mv report.txt ~/Documents/'],
    run: (ctx) => transfer(ctx, 'mv', true),
  });

  define({
    name: 'rm', category: 'File management', summary: 'Remove files or directories',
    usage: ['rm [-rf] <path>...'],
    options: ['-r  remove directories and their contents', '-f  ignore missing files, never complain', '-v  explain what is being done'],
    examples: ['rm old.txt', 'rm -r old-folder'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'rRfvd' });
      if (opts.error) return fail(usageError('rm', opts.error), 1);
      const force = opts.flags.has('f');
      const recursive = opts.flags.has('r') || opts.flags.has('R');
      if (!opts.operands.length) return force ? ok() : fail(usageError('rm', 'missing operand'));
      const { fs } = ctx;
      const errors = [];
      const out = [];
      opts.operands.forEach((operand) => {
        const last = operand.replace(/\/+$/, '').split('/').pop();
        if (last === '.' || last === '..') { errors.push(`rm: refusing to remove '.' or '..' directory: skipping '${operand}'`); return; }
        const abs = ctx.path(operand);
        if (abs === '/') {
          errors.push("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe");
          return;
        }
        const node = fs.getNode(abs);
        if (!node) { if (!force) errors.push(`rm: cannot remove '${operand}': No such file or directory`); return; }
        if (node.type === 'dir' && !recursive) {
          if (opts.flags.has('d') && node.children.size === 0) { fs.remove(abs, { recursive: true }); return; }
          errors.push(`rm: cannot remove '${operand}': Is a directory`);
          return;
        }
        fs.remove(abs, { recursive: true });
        if (opts.flags.has('v')) out.push(`removed ${node.type === 'dir' ? 'directory ' : ''}'${operand}'`);
      });
      return { out: joinLines(out), err: errors.join('\n'), code: errors.length ? 1 : 0 };
    },
  });

  /* ----------------------------------------------------------- File reading */

  /** Read text from files (or stdin). Returns { sources, errors }. */
  function readSources(ctx, name, operands) {
    const sources = [];
    const errors = [];
    operands.forEach((operand) => {
      if (operand === '-' && ctx.stdin !== null) { sources.push({ name: 'standard input', text: ctx.stdin }); return; }
      const abs = ctx.path(operand);
      const node = ctx.fs.getNode(abs);
      if (!node) { errors.push(`${name}: ${operand}: No such file or directory`); return; }
      if (node.type === 'dir') { errors.push(`${name}: ${operand}: Is a directory`); return; }
      sources.push({ name: operand, text: node.content });
    });
    return { sources, errors };
  }

  define({
    name: 'cat', category: 'File reading', summary: 'Print the contents of files',
    usage: ['cat [-n] <file>...'],
    options: ['-n  number all output lines'],
    examples: ['cat notes.txt', 'cat -n /etc/passwd'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'nA' });
      if (opts.error) return fail(usageError('cat', opts.error), 1);
      let sources;
      let errors = [];
      if (!opts.operands.length) {
        if (ctx.stdin === null) return fail('cat: missing file operand (interactive input is not supported here)');
        sources = [{ name: 'standard input', text: ctx.stdin }];
      } else {
        ({ sources, errors } = readSources(ctx, 'cat', opts.operands));
      }
      let text = sources.map((s) => s.text).join('');
      if (opts.flags.has('n')) {
        text = joinLines(textLines(text).map((line, i) => `${String(i + 1).padStart(6)}\t${line}`));
      }
      return { out: text, err: errors.join('\n'), code: errors.length ? 1 : 0 };
    },
  });

  /** head and tail share option parsing and multi-file headers. */
  function headTail(name) {
    return (ctx) => {
      const opts = parseArgs(ctx.args, { flags: 'qv', values: 'n', numeric: true, long: { lines: 'n', quiet: 'q', verbose: 'v' } });
      if (opts.error) return fail(usageError(name, opts.error), 1);
      const raw = opts.values.n !== undefined ? opts.values.n : '10';
      if (!/^[+-]?\d+$/.test(raw)) return fail(`${name}: invalid number of lines: '${raw}'`);
      const count = parseInt(raw, 10);
      const plus = raw.startsWith('+');
      const negative = raw.startsWith('-');

      const pick = (lines) => {
        if (name === 'head') {
          if (negative) return lines.slice(0, Math.max(0, lines.length - Math.abs(count)));
          return lines.slice(0, count);
        }
        if (plus) return lines.slice(Math.max(count - 1, 0));
        const n = Math.abs(count);
        return n === 0 ? [] : lines.slice(-n);
      };

      let sources;
      let errors = [];
      if (!opts.operands.length) {
        if (ctx.stdin === null) return fail(`${name}: missing file operand (pipe some text in or name a file)`);
        sources = [{ name: 'standard input', text: ctx.stdin }];
      } else {
        ({ sources, errors } = readSources(ctx, name, opts.operands));
      }
      const showHeaders = !opts.flags.has('q') && (opts.flags.has('v') || opts.operands.length > 1);
      const chunks = sources.map((source, index) => {
        const body = joinLines(pick(textLines(source.text)));
        if (!showHeaders) return body;
        return (index > 0 ? '\n' : '') + `==> ${source.name} <==\n` + body;
      });
      return { out: chunks.join(''), err: errors.join('\n'), code: errors.length ? 1 : 0 };
    };
  }

  define({
    name: 'head', category: 'File reading', summary: 'Show the first lines of a file',
    usage: ['head [-n N] [file...]'],
    options: ['-n N  show the first N lines (default 10)'],
    examples: ['head -n 3 /var/log/system.log', 'head -5 notes.txt'],
    run: headTail('head'),
  });

  define({
    name: 'tail', category: 'File reading', summary: 'Show the last lines of a file',
    usage: ['tail [-n N] [file...]'],
    options: ['-n N   show the last N lines (default 10)', '-n +N  start at line N'],
    examples: ['tail -n 2 /var/log/system.log', 'tail -n +5 notes.txt'],
    run: headTail('tail'),
  });

  /* ----------------------------------------------------------------- Search */

  define({
    name: 'find', category: 'Search', summary: 'Search for files and directories',
    usage: ['find [path...] [-name PATTERN] [-type f|d] [-maxdepth N]'],
    options: ['-name PATTERN  match the file name (wildcards allowed, quote them)', '-iname PATTERN case-insensitive -name', '-type f|d      files or directories only', '-maxdepth N    do not go deeper than N levels', '-mindepth N    ignore the first N levels'],
    examples: ['find . -name "*.txt"', 'find /var -type d', 'find ~ -maxdepth 1'],
    run(ctx) {
      const args = ctx.args;
      const starts = [];
      let i = 0;
      while (i < args.length && !/^(-|!|\()/.test(args[i])) { starts.push(args[i]); i += 1; }
      if (!starts.length) starts.push('.');

      const predicates = [];
      let maxDepth = Infinity;
      let minDepth = 0;
      while (i < args.length) {
        const arg = args[i++];
        switch (arg) {
          case '-name':
          case '-iname': {
            const value = args[i++];
            if (value === undefined) return fail(`find: missing argument to '${arg}'`);
            predicates.push({ kind: 'name', re: TQ.globToRegExp(value, arg === '-iname') });
            break;
          }
          case '-type': {
            const value = args[i++];
            if (value === undefined) return fail("find: missing argument to '-type'");
            if (value !== 'f' && value !== 'd') return fail(`find: Unknown argument to -type: ${value}`);
            predicates.push({ kind: 'type', value });
            break;
          }
          case '-maxdepth':
          case '-mindepth': {
            const value = args[i++];
            if (value === undefined) return fail(`find: missing argument to '${arg}'`);
            if (!/^\d+$/.test(value)) return fail(`find: Invalid argument '${value}' to '${arg}'`);
            if (arg === '-maxdepth') maxDepth = parseInt(value, 10); else minDepth = parseInt(value, 10);
            break;
          }
          case '-print':
            break;
          default:
            return fail(`find: unknown predicate '${arg}'`);
        }
      }

      const { fs } = ctx;
      const lines = [];
      const errors = [];
      const matches = (name, node) => predicates.every((p) => {
        if (p.kind === 'name') return p.re.test(name);
        return p.value === 'd' ? node.type === 'dir' : node.type === 'file';
      });

      starts.forEach((start) => {
        const abs = ctx.path(start);
        const node = fs.getNode(abs);
        if (!node) { errors.push(`find: '${start}': No such file or directory`); return; }
        const visit = (display, absPath, current, depth) => {
          if (depth > maxDepth) return;
          const name = depth === 0 ? (start.replace(/\/+$/, '').split('/').pop() || start) : fs.basename(absPath);
          if (depth >= minDepth && matches(name, current)) lines.push(display);
          if (current.type === 'dir' && depth < maxDepth) {
            fs.list(absPath).forEach(([childName, child]) => visit(displayJoin(display, childName), fs.join(absPath, childName), child, depth + 1));
          }
        };
        visit(start, abs, node, 0);
      });
      return { out: joinLines(lines), err: errors.join('\n'), code: errors.length ? 1 : 0 };
    },
  });

  define({
    name: 'grep', category: 'Search', summary: 'Search for text in files',
    usage: ['grep [options] <pattern> [file...]'],
    options: ['-i  ignore case', '-n  show line numbers', '-r  search directories recursively', '-v  invert match (show non-matching lines)', '-c  count matching lines', '-l  list matching file names only', '-w  match whole words', '-F  treat the pattern as a plain string', '-E  extended regular expression'],
    examples: ['grep ERROR /var/log/system.log', 'grep -rn TODO ~/Projects', 'cat notes.txt | grep -i linux'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'inrRvclwFEHhq', values: 'e' });
      if (opts.error) return fail(usageError('grep', opts.error), 2);
      const flags = opts.flags;
      let operands = [...opts.operands];
      let pattern;
      if (opts.values.e !== undefined) {
        pattern = opts.values.e;
      } else {
        if (!operands.length) return fail("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'help grep' for more information.", 2);
        pattern = operands.shift();
      }

      let source = flags.has('F') ? escapeRegExp(pattern) : flags.has('E') ? pattern : breToJs(pattern);
      if (flags.has('w')) source = `\\b(?:${source})\\b`;
      let re;
      try {
        re = new RegExp(source, flags.has('i') ? 'i' : '');
      } catch (err) {
        return fail(`grep: Invalid regular expression: ${pattern}`, 2);
      }

      const recursive = flags.has('r') || flags.has('R');
      const { fs } = ctx;
      const sources = [];
      const errors = [];
      let implicitRecursive = false;
      let recursedIntoDir = false;

      if (!operands.length) {
        if (recursive) { operands = ['.']; implicitRecursive = true; }
        else if (ctx.stdin !== null) sources.push({ name: '(standard input)', text: ctx.stdin });
        else return fail('grep: no input (pipe some text into grep or name a file)', 2);
      }

      operands.forEach((operand) => {
        if (operand === '-' && ctx.stdin !== null) { sources.push({ name: '(standard input)', text: ctx.stdin }); return; }
        const abs = ctx.path(operand);
        const node = fs.getNode(abs);
        if (!node) { errors.push(`grep: ${operand}: No such file or directory`); return; }
        if (node.type === 'file') { sources.push({ name: operand, text: node.content }); return; }
        if (!recursive) { errors.push(`grep: ${operand}: Is a directory`); return; }
        recursedIntoDir = true;
        fs.walk(abs, (path, current) => {
          if (current.type !== 'file') return true;
          const rel = abs === '/' ? path.slice(1) : path.slice(abs.length + 1);
          sources.push({ name: implicitRecursive ? rel : displayJoin(operand, rel), text: current.content });
          return true;
        });
      });

      let showName = operands.length > 1 || recursedIntoDir;
      if (flags.has('H')) showName = true;
      if (flags.has('h')) showName = false;

      const out = [];
      let matchedAny = false;
      sources.forEach((src) => {
        const prefix = showName ? src.name + ':' : '';
        let count = 0;
        const selected = [];
        textLines(src.text).forEach((line, index) => {
          if (re.test(line) !== flags.has('v')) { count += 1; selected.push({ line, number: index + 1 }); }
        });
        if (count > 0) matchedAny = true;
        if (flags.has('q')) return;
        if (flags.has('l')) { if (count > 0) out.push(src.name); return; }
        if (flags.has('c')) { out.push(prefix + count); return; }
        selected.forEach((s) => out.push(prefix + (flags.has('n') ? s.number + ':' : '') + s.line));
      });

      const code = errors.length ? 2 : matchedAny ? 0 : 1;
      return { out: flags.has('q') ? '' : joinLines(out), err: errors.join('\n'), code };
    },
  });

  /* ----------------------------------------------------------------- System */

  define({
    name: 'uname', category: 'System', summary: 'Print system information',
    usage: ['uname [-asnrvmo]'],
    options: ['-a  all information', '-s  kernel name', '-n  hostname', '-r  kernel release', '-v  kernel version', '-m  machine hardware', '-o  operating system'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'asnrvmop' });
      if (opts.error) return fail(usageError('uname', opts.error), 1);
      if (opts.operands.length) return fail(usageError('uname', `extra operand '${opts.operands[0]}'`));
      const info = { s: 'Linux', n: ENV.HOST, r: '6.1.0-quest', v: '#1 SMP PREEMPT_DYNAMIC Sun Nov 1 09:00:00 UTC 2026', m: 'x86_64', o: 'GNU/Linux' };
      const order = ['s', 'n', 'r', 'v', 'm', 'o'];
      const wanted = opts.flags.has('a') ? order : order.filter((k) => opts.flags.has(k));
      return ok((wanted.length ? wanted : ['s']).map((k) => info[k]).join(' ') + '\n');
    },
  });

  define({
    name: 'uptime', category: 'System', summary: 'Show how long the system has been running',
    usage: ['uptime [-p] [-s]'],
    options: ['-p  pretty format', '-s  system up since'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'ps' });
      if (opts.error) return fail(usageError('uptime', opts.error), 1);
      if (opts.operands.length) return fail(usageError('uptime', `extra operand '${opts.operands[0]}'`));
      const now = new Date();
      const minutesUp = Math.floor((now.getTime() - BOOT_TIME) / 60000);
      const hours = Math.floor(minutesUp / 60);
      const minutes = minutesUp % 60;
      if (opts.flags.has('s')) return ok(formatDate(new Date(BOOT_TIME), '%F %T') + '\n');
      if (opts.flags.has('p')) {
        const parts = [];
        if (hours) parts.push(`${hours} ${plural(hours, 'hour', 'hours')}`);
        parts.push(`${minutes} ${plural(minutes, 'minute', 'minutes')}`);
        return ok('up ' + parts.join(', ') + '\n');
      }
      const upText = hours > 0 ? `${String(hours).padStart(2)}:${pad(minutes)}` : `${minutes} min`;
      const seed = now.getTime() / 100000;
      const load = [0.05 + Math.abs(Math.sin(seed)) * 0.4, 0.05 + Math.abs(Math.sin(seed / 2)) * 0.3, 0.03 + Math.abs(Math.sin(seed / 4)) * 0.2];
      return ok(` ${formatDate(now, '%T')} up ${upText},  1 user,  load average: ${load.map((n) => n.toFixed(2)).join(', ')}\n`);
    },
  });

  const DF_ROWS = [
    { fs: '/dev/vda1', kb: 41152812, used: 12304512, mount: '/' },
    { fs: 'tmpfs', kb: 2013024, used: 0, mount: '/dev/shm' },
    { fs: 'tmpfs', kb: 402604, used: 1128, mount: '/run' },
    { fs: 'tmpfs', kb: 2013024, used: 16, mount: '/tmp' },
    { fs: '/dev/vda15', kb: 106858, used: 6186, mount: '/boot/efi' },
  ];

  define({
    name: 'df', category: 'System', summary: 'Show disk space usage',
    usage: ['df [-h] [path...]'],
    options: ['-h  human-readable sizes'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'hT' });
      if (opts.error) return fail(usageError('df', opts.error), 1);
      const human = opts.flags.has('h');
      let rows = DF_ROWS;
      const errors = [];
      if (opts.operands.length) {
        rows = [];
        opts.operands.forEach((operand) => {
          const abs = ctx.path(operand);
          if (!ctx.fs.exists(abs)) { errors.push(`df: ${operand}: No such file or directory`); return; }
          const best = DF_ROWS.filter((r) => r.mount === '/' || abs === r.mount || abs.startsWith(r.mount + '/'))
            .sort((a, b) => b.mount.length - a.mount.length)[0];
          if (!rows.includes(best)) rows.push(best);
        });
      }
      const fmt = (kb) => (human ? humanSize(kb * 1024) : String(kb));
      const table = [['Filesystem', human ? 'Size' : '1K-blocks', 'Used', 'Avail', 'Use%', 'Mounted on']];
      rows.forEach((r) => {
        table.push([r.fs, fmt(r.kb), fmt(r.used), fmt(r.kb - r.used), Math.ceil((r.used / r.kb) * 100) + '%', r.mount]);
      });
      table[0][3] = human ? 'Avail' : 'Available';
      const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
      const lines = rows.length ? table.map((row) => row.map((cell, c) => {
        if (c === 0) return cell.padEnd(widths[c]);
        if (c === 5) return cell;
        return cell.padStart(widths[c]);
      }).join(' ')) : [];
      return { out: joinLines(lines), err: errors.join('\n'), code: errors.length ? 1 : 0 };
    },
  });

  define({
    name: 'free', category: 'System', summary: 'Show memory usage',
    usage: ['free [-h|-b|-k|-m|-g]'],
    options: ['-h  human-readable', '-b  bytes', '-k  kibibytes (default)', '-m  mebibytes', '-g  gibibytes'],
    run(ctx) {
      const opts = parseArgs(ctx.args, { flags: 'hbkmg' });
      if (opts.error) return fail(usageError('free', opts.error), 1);
      if (opts.operands.length) return fail(usageError('free', `extra operand '${opts.operands[0]}'`));
      const mem = [4028652, 1296540, 1553212, 14196, 1178900, 2568312];
      const swap = [2097148, 0, 2097148];
      const human = (kib) => {
        if (kib >= 1048576) { const v = kib / 1048576; return (v < 10 ? v.toFixed(1) : Math.round(v)) + 'Gi'; }
        if (kib >= 1024) { const v = kib / 1024; return (v < 10 ? v.toFixed(1) : Math.round(v)) + 'Mi'; }
        return kib + 'Ki';
      };
      const fmt = (kib) => {
        if (opts.flags.has('h')) return human(kib);
        if (opts.flags.has('b')) return String(kib * 1024);
        if (opts.flags.has('m')) return String(Math.floor(kib / 1024));
        if (opts.flags.has('g')) return String(Math.floor(kib / 1048576));
        return String(kib);
      };
      const row = (label, values) => label.padEnd(8) + values.map((v) => fmt(v).padStart(12)).join('');
      const header = ' '.repeat(8) + ['total', 'used', 'free', 'shared', 'buff/cache', 'available'].map((h) => h.padStart(12)).join('');
      return ok(joinLines([header, row('Mem:', mem), row('Swap:', swap)]));
    },
  });

  define({
    name: 'ps', category: 'System', summary: 'List running processes',
    usage: ['ps', 'ps aux', 'ps -ef'],
    run(ctx) {
      const shell = ctx.shell;
      shell.pidCounter += 1;
      const psPid = 1500 + shell.pidCounter;
      const args = ctx.args.map((a) => a.replace(/^-/, ''));
      const supported = /^(a|u|x|e|f|A|ef|aux|au|ax)$/;
      const unsupported = ctx.args.find((a) => !supported.test(a.replace(/^-/, '')));
      if (unsupported) return fail(`ps: unsupported option '${unsupported}' (try: ps, ps aux, ps -ef)`);
      const hhmm = (ms) => formatDate(new Date(ms), '%H:%M');
      const boot = hhmm(BOOT_TIME);
      const session = hhmm(shell.startedAt);
      const procs = [
        { user: 'root', pid: 1, ppid: 0, vsz: 167940, rss: 11824, tty: '?', stat: 'Ss', start: boot, time: '0:01', cmd: '/sbin/init' },
        { user: 'root', pid: 2, ppid: 0, vsz: 0, rss: 0, tty: '?', stat: 'S', start: boot, time: '0:00', cmd: '[kthreadd]' },
        { user: 'root', pid: 312, ppid: 1, vsz: 42988, rss: 16640, tty: '?', stat: 'Ss', start: boot, time: '0:00', cmd: '/lib/systemd/systemd-journald' },
        { user: 'root', pid: 518, ppid: 1, vsz: 6620, rss: 2916, tty: '?', stat: 'Ss', start: boot, time: '0:00', cmd: '/usr/sbin/cron -f' },
        { user: 'root', pid: 544, ppid: 1, vsz: 15420, rss: 8504, tty: '?', stat: 'Ss', start: boot, time: '0:00', cmd: 'sshd: /usr/sbin/sshd -D' },
        { user: 'root', pid: 702, ppid: 1, vsz: 55300, rss: 5112, tty: '?', stat: 'Ss', start: boot, time: '0:00', cmd: 'nginx: master process /usr/sbin/nginx' },
        { user: 'www-data', pid: 703, ppid: 702, vsz: 56012, rss: 8240, tty: '?', stat: 'S', start: boot, time: '0:00', cmd: 'nginx: worker process' },
        { user: 'player', pid: 1342, ppid: 544, vsz: 8212, rss: 5396, tty: 'pts/0', stat: 'Ss', start: session, time: '0:00', cmd: '-bash' },
        { user: 'player', pid: psPid, ppid: 1342, vsz: 10072, rss: 3320, tty: 'pts/0', stat: 'R+', start: hhmm(Date.now()), time: '0:00', cmd: 'ps ' + ctx.args.join(' ') },
      ];
      const mode = args.join('');
      if (/aux|au|ax|^a$|^u$|^x$/.test(mode) && !/e|f/.test(mode.replace(/aux|ax|au/g, ''))) {
        const head = 'USER'.padEnd(10) + 'PID'.padStart(5) + ' %CPU %MEM'.padStart(10) + 'VSZ'.padStart(8) + 'RSS'.padStart(7) + ' ' + 'TTY'.padEnd(8) + 'STAT'.padEnd(5) + ' ' + 'START'.padEnd(6) + 'TIME'.padStart(5) + ' COMMAND';
        const lines = procs.map((p) => p.user.padEnd(10) + String(p.pid).padStart(5) + '  0.0  0.1'.padStart(10) + String(p.vsz).padStart(8) + String(p.rss).padStart(7) + ' ' + p.tty.padEnd(8) + p.stat.padEnd(5) + ' ' + p.start.padEnd(6) + p.time.padStart(5) + ' ' + p.cmd);
        return ok(joinLines([head, ...lines]));
      }
      if (/e|f|A/.test(mode)) {
        const head = 'UID'.padEnd(9) + 'PID'.padStart(5) + 'PPID'.padStart(6) + '  C STIME TTY          TIME CMD';
        const lines = procs.map((p) => p.user.padEnd(9) + String(p.pid).padStart(5) + String(p.ppid).padStart(6) + '  0 ' + p.start.padEnd(5) + ' ' + p.tty.padEnd(8) + '00:00:00 ' + p.cmd);
        return ok(joinLines([head, ...lines]));
      }
      const mine = procs.filter((p) => p.tty === 'pts/0');
      const lines = ['    PID TTY          TIME CMD', ...mine.map((p) => String(p.pid).padStart(7) + ' ' + p.tty.padEnd(8) + ' 00:00:00 ' + p.cmd.replace(/^-/, '').split(' ')[0])];
      return ok(joinLines(lines));
    },
  });

  /* ======================================================================
     Tokenizer / parser
     ====================================================================== */

  /** Read $NAME, ${NAME} or $? at position i. Returns { value, next }. */
  function readVariable(line, i, env) {
    const rest = line.slice(i + 1);
    let match = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
    if (match) return { value: env[match[1]] || '', next: i + 1 + match[0].length };
    match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (match) return { value: env[match[1]] || '', next: i + 1 + match[0].length };
    if (rest[0] === '?') return { value: '0', next: i + 2 };
    return { value: '$', next: i + 1 };
  }

  /**
   * Split a command line into word and operator tokens.
   * Returns { tokens } or { error }.
   */
  function tokenize(line, env) {
    const tokens = [];
    let cur = '';
    let hasWord = false;
    let glob = false;
    let i = 0;

    const flush = () => {
      if (hasWord) tokens.push({ type: 'word', value: cur, glob });
      cur = ''; hasWord = false; glob = false;
    };

    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t') { flush(); i += 1; continue; }
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        if (end === -1) return { error: "bash: unexpected EOF while looking for matching `''" };
        cur += line.slice(i + 1, end); hasWord = true; i = end + 1; continue;
      }
      if (c === '"') {
        i += 1;
        let closed = false;
        while (i < line.length) {
          const d = line[i];
          if (d === '"') { closed = true; i += 1; break; }
          if (d === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) { cur += line[i + 1]; i += 2; continue; }
          if (d === '$') { const r = readVariable(line, i, env); cur += r.value; i = r.next; continue; }
          cur += d; i += 1;
        }
        if (!closed) return { error: 'bash: unexpected EOF while looking for matching `"\'' };
        hasWord = true; continue;
      }
      if (c === '\\') {
        if (i + 1 < line.length) { cur += line[i + 1]; hasWord = true; i += 2; } else { i += 1; }
        continue;
      }
      if (c === '$') {
        const r = readVariable(line, i, env);
        if (r.value !== '') { cur += r.value; hasWord = true; }
        i = r.next; continue;
      }
      if (c === '|' || c === ';' || c === '&' || c === '>' || c === '<') {
        flush();
        if (c === '|') {
          if (line[i + 1] === '|') return { error: "bash: '||' is not supported in Terminal Quest" };
          tokens.push({ type: 'op', value: '|' }); i += 1;
        } else if (c === ';') {
          tokens.push({ type: 'op', value: ';' }); i += 1;
        } else if (c === '&') {
          if (line[i + 1] !== '&') return { error: "bash: background jobs ('&') are not supported in Terminal Quest" };
          tokens.push({ type: 'op', value: '&&' }); i += 2;
        } else {
          return { error: `bash: redirection ('${c}') is not supported in Terminal Quest` };
        }
        continue;
      }
      if (c === '~' && !hasWord && cur === '' && (i + 1 >= line.length || /[\s/|;&]/.test(line[i + 1]))) {
        cur += env.HOME; hasWord = true; i += 1; continue;
      }
      if (c === '*' || c === '?' || c === '[') glob = true;
      cur += c; hasWord = true; i += 1;
    }
    flush();
    return { tokens };
  }

  /** Group tokens into statements (; &&) made of pipelines (|) made of words. */
  function parse(tokens) {
    const statements = [];
    let pipeline = [];
    let words = [];
    let connector = null;
    const syntax = (token) => ({ error: `bash: syntax error near unexpected token '${token}'` });

    for (const token of tokens) {
      if (token.type === 'word') { words.push(token); continue; }
      if (!words.length) return syntax(token.value);
      pipeline.push(words);
      words = [];
      if (token.value !== '|') {
        statements.push({ connector, pipeline });
        connector = token.value;
        pipeline = [];
      }
    }
    if (words.length) {
      pipeline.push(words);
      statements.push({ connector, pipeline });
    } else if (pipeline.length) {
      return { error: 'bash: syntax error: unexpected end of line' };
    } else if (connector === '&&') {
      return { error: 'bash: syntax error: unexpected end of line' };
    }
    return { statements };
  }

  /** Expand a wildcard pattern against the virtual filesystem. */
  function expandGlob(pattern, fs, cwd) {
    const segments = pattern.split('/').filter((s) => s !== '');
    let current = [pattern.startsWith('/') ? '/' : ''];
    for (const segment of segments) {
      const next = [];
      for (const prefix of current) {
        const join = (name) => (prefix === '' ? name : prefix.endsWith('/') ? prefix + name : prefix + '/' + name);
        if (!/[*?[]/.test(segment)) {
          if (fs.exists(fs.resolve(join(segment), cwd))) next.push(join(segment));
          continue;
        }
        const dirAbs = fs.resolve(prefix || '.', cwd);
        const dir = fs.getNode(dirAbs);
        if (!dir || dir.type !== 'dir') continue;
        const re = TQ.globToRegExp(segment);
        fs.list(dirAbs).forEach(([name]) => {
          if (name.startsWith('.') && !segment.startsWith('.')) return;
          if (re.test(name)) next.push(join(name));
        });
      }
      current = next;
    }
    return current.sort();
  }

  /* ======================================================================
     Shell
     ====================================================================== */

  class Shell {
    constructor(fs, state) {
      this.fs = fs;
      this.registry = new Map(COMMANDS.map((c) => [c.name, c]));
      this.cwd = state && fs.isDir(state.cwd) ? state.cwd : ENV.HOME;
      this.oldpwd = state && typeof state.oldpwd === 'string' ? state.oldpwd : this.cwd;
      this.pidCounter = 0;
      this.startedAt = Date.now();
    }

    /** Persistable shell state. */
    state() { return { cwd: this.cwd, oldpwd: this.oldpwd }; }

    env() {
      return { HOME: ENV.HOME, USER: ENV.USER, PWD: this.cwd, OLDPWD: this.oldpwd, HOSTNAME: ENV.HOST, SHELL: '/bin/bash' };
    }

    /** Pieces of the prompt: player@terminal-quest:~/Projects$ */
    promptParts() {
      let path = this.cwd;
      if (path === ENV.HOME) path = '~';
      else if (path.startsWith(ENV.HOME + '/')) path = '~' + path.slice(ENV.HOME.length);
      return { user: ENV.USER, host: ENV.HOST, path };
    }

    /**
     * Run one line of input.
     * Returns { raw, empty, outputs[], code, names[], name, out, err, cleared }
     *   outputs: ordered list of { type: 'out'|'err'|'clear', text? }
     *   names:   every command name executed on the line
     *   out/err: stdout/stderr of the final command (used by mission validation)
     */
    run(line) {
      const result = { raw: line, empty: false, outputs: [], code: 0, names: [], name: '', out: '', err: '', cleared: false };
      const trimmed = String(line).trim();
      if (!trimmed) { result.empty = true; return result; }

      const syntaxFailure = (message) => {
        result.outputs.push({ type: 'err', text: message });
        result.err = message;
        result.code = 2;
        return result;
      };
      const tokenized = tokenize(trimmed, this.env());
      if (tokenized.error) return syntaxFailure(tokenized.error);
      const parsed = parse(tokenized.tokens);
      if (parsed.error) return syntaxFailure(parsed.error);

      let previous = 0;
      parsed.statements.forEach((statement) => {
        if (statement.connector === '&&' && previous !== 0) return;
        previous = this._runPipeline(statement.pipeline, result);
      });
      result.code = previous;
      this._repairCwd();
      return result;
    }

    _expand(token) {
      if (!token.glob) return [token.value];
      const matches = expandGlob(token.value, this.fs, this.cwd);
      return matches.length ? matches : [token.value];
    }

    _runPipeline(pipeline, result) {
      let stdin = null;
      let last = ok();
      pipeline.forEach((words, index) => {
        const expanded = [];
        words.forEach((token) => expanded.push(...this._expand(token)));
        const name = expanded[0];
        result.names.push(name);
        result.name = name;
        const command = this.registry.get(name);
        let res;
        if (!command) {
          res = fail(`bash: ${name}: command not found`, 127);
        } else {
          try {
            res = command.run({
              args: expanded.slice(1),
              stdin,
              piped: index < pipeline.length - 1,
              fs: this.fs,
              cwd: this.cwd,
              shell: this,
              path: (p) => this.fs.resolve(p, this.cwd),
            });
          } catch (error) {
            console.error(error);
            res = fail(`${name}: internal error: ${error.message}`);
          }
        }
        if (res.clear) { result.outputs.push({ type: 'clear' }); result.cleared = true; }
        if (res.err) result.outputs.push({ type: 'err', text: res.err });
        if (index === pipeline.length - 1 && res.out) result.outputs.push({ type: 'out', text: res.out });
        stdin = res.out || '';
        last = res;
      });
      result.out = last.out || '';
      result.err = last.err || '';
      return last.code;
    }

    /** If the current directory was deleted, fall back to the nearest parent. */
    _repairCwd() {
      let dir = this.cwd;
      while (dir !== '/' && !this.fs.isDir(dir)) dir = this.fs.dirname(dir);
      this.cwd = dir;
    }

    /**
     * Tab completion for the text before the cursor.
     * Returns { prefix, word, candidates[] } where candidates are full
     * replacements for `word`.
     */
    complete(text) {
      const match = /(\S*)$/.exec(text);
      const word = match[1];
      const before = text.slice(0, text.length - word.length);
      const previous = before.trim().split(/\s+/).pop();
      const isCommand = before.trim() === '' || ['|', ';', '&&'].includes(previous);

      if (isCommand && !word.includes('/')) {
        const candidates = [...this.registry.keys()].filter((n) => n.startsWith(word)).sort();
        return { prefix: before, word, candidates };
      }
      const slash = word.lastIndexOf('/');
      const dirPart = slash === -1 ? '' : word.slice(0, slash + 1);
      const namePart = word.slice(slash + 1);
      const dirAbs = this.fs.resolve(dirPart || '.', this.cwd);
      let candidates = [];
      if (this.fs.isDir(dirAbs)) {
        candidates = this.fs.list(dirAbs)
          .filter(([name]) => name.startsWith(namePart) && (!name.startsWith('.') || namePart.startsWith('.')))
          .map(([name, node]) => dirPart + name + (node.type === 'dir' ? '/' : ''));
      }
      return { prefix: before, word, candidates };
    }
  }

  TQ.COMMANDS = COMMANDS;
  TQ.Shell = Shell;
  TQ.shellInternals = { tokenize, parse, parseArgs, formatDate };
})(typeof window !== 'undefined' ? window : globalThis);
