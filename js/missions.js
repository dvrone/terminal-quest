/**
 * missions.js — Mission data, fixtures and validators.
 *
 * Mission *data* (text, difficulty, XP, hints) is plain JSON-compatible, so
 * it can be edited or moved to a .json file without touching any logic.
 * Behaviour is referenced by name:
 *   validator: key into VALIDATORS  -> decides whether the mission is complete
 *   setup:     key into SETUPS      -> prepares the filesystem when the mission starts
 *   nudge / nudgeOn: optional feedback when a related command ran but the
 *                    result is not what the mission asks for
 *
 * Validators inspect the *resulting state* (the virtual filesystem, the
 * current directory) or the *actual output* of the last command. A mission is
 * never completed just because a particular command name was typed.
 *
 * Validator context: { fs, cwd, home, last }
 *   last = { names[], name, out, err, code, cleared, raw } (see Shell.run)
 */
(function (global) {
  'use strict';
  const TQ = (global.TQ = global.TQ || {});
  const HOME = TQ.ENV.HOME;

  const DIFFICULTY_XP = { easy: 25, medium: 50, hard: 100 };

  const LEVELS = [
    { id: 1, title: 'Getting Started', summary: 'Learn the first commands every terminal user needs.' },
    { id: 2, title: 'Navigation', summary: 'Move around the filesystem with confidence.' },
    { id: 3, title: 'File Management', summary: 'Create, copy, move and delete files and folders.' },
    { id: 4, title: 'Reading Files', summary: 'Inspect file contents without opening an editor.' },
    { id: 5, title: 'Searching', summary: 'Find files and text quickly.' },
  ];

  const MISSIONS = [
    /* ---------------------------------------------------------- Level 1 */
    {
      id: 'pwd', level: 1, difficulty: 'easy', title: 'Where Am I?',
      description: 'Every terminal session has a current working directory. Before you go anywhere, find out where you are.',
      objective: 'Print your current working directory.',
      hint: 'The command name is short for “print working directory”. It takes no arguments.',
      explanation: '`pwd` prints the absolute path of the directory you are in. Use it whenever you feel lost.',
      validator: 'pwdOutput', setup: 'home',
    },
    {
      id: 'whoami', level: 1, difficulty: 'easy', title: 'Who Are You?',
      description: 'Linux is a multi-user system, so it matters which account you are using.',
      objective: 'Display the username of the current user.',
      hint: 'The command is literally the question you would ask: who am I? Write it as one word.',
      explanation: '`whoami` prints the name of the user running the shell. It is handy on shared servers.',
      validator: 'whoamiOutput', setup: 'home',
    },
    {
      id: 'hostname', level: 1, difficulty: 'easy', title: 'Name That Machine',
      description: 'Every computer on a network has a name. Find out what this one is called.',
      objective: 'Display the hostname of this computer.',
      hint: 'Combine the words “host” and “name”.',
      explanation: '`hostname` shows the machine name. You will see it in the prompt too: player@terminal-quest.',
      validator: 'hostnameOutput', setup: 'home',
    },
    {
      id: 'clear', level: 1, difficulty: 'easy', title: 'Clean Slate',
      description: 'Terminals fill up quickly. Learn how to wipe the screen and start fresh.',
      objective: 'Clear the terminal screen.',
      hint: 'The command is a five-letter English word meaning “remove everything”.',
      explanation: '`clear` erases the visible screen. Your files and history are untouched.',
      validator: 'clearRan', setup: 'home',
    },
    {
      id: 'help', level: 1, difficulty: 'easy', title: 'Ask for Help',
      description: 'You do not need to memorise everything. This simulator has a built-in list of commands.',
      objective: 'Run the command that lists all available commands.',
      hint: 'It is the word you would call out in an emergency.',
      explanation: '`help` lists commands, and `help <command>` shows usage and examples for one command.',
      validator: 'helpRan', setup: 'home',
    },

    /* ---------------------------------------------------------- Level 2 */
    {
      id: 'ls', level: 2, difficulty: 'easy', title: 'Look Around',
      description: 'Your home directory contains a few folders. List them without moving anywhere.',
      objective: 'List the contents of your home directory.',
      hint: 'ls is short for “list”. You are already standing in your home directory.',
      explanation: '`ls` lists directory contents. Try `ls -l` for details and `ls -a` to show hidden files.',
      validator: 'lsHome', setup: 'home',
      nudge: 'Make sure you are listing your home directory (cd ~ first, then ls).', nudgeOn: ['ls'],
    },
    {
      id: 'cd-projects', level: 2, difficulty: 'easy', title: 'Step Inside',
      description: 'Folders are only useful if you can enter them. Move into the Projects folder.',
      objective: 'Change into the Projects directory.',
      hint: 'cd takes a directory name: cd <name>. Projects is inside your home directory.',
      explanation: '`cd` changes the current directory. A path without a leading / is relative to where you are.',
      validator: 'cdProjects', setup: 'home',
    },
    {
      id: 'cd-abs', level: 2, difficulty: 'medium', title: 'Absolute Travel',
      description: 'Absolute paths start with / and work from anywhere. System logs live far away from your home.',
      objective: 'Go to the system log directory /var/log using an absolute path.',
      hint: 'Type cd followed by the full path, starting with a slash.',
      explanation: '`cd ..` goes up one level, `cd ~` returns home and `cd -` jumps back to the previous directory.',
      validator: 'cdVarLog', setup: 'home',
    },
    {
      id: 'tree', level: 2, difficulty: 'medium', title: 'See the Big Picture',
      description: 'Sometimes you want to see how folders are nested instead of listing one level at a time.',
      objective: 'Display the directory tree of your home directory.',
      hint: 'tree takes an optional path. Run it while you are in your home directory.',
      explanation: '`tree` draws nested directories. Limit the depth with `tree -L 2`.',
      validator: 'treeHome', setup: 'home',
      nudge: 'Run tree from your home directory so Documents, Downloads and Projects all appear.', nudgeOn: ['tree'],
    },

    /* ---------------------------------------------------------- Level 3 */
    {
      id: 'mkdir', level: 3, difficulty: 'easy', title: 'Build a Folder',
      description: 'Start a new project by creating a folder for a website inside Projects.',
      objective: 'Create a directory named website inside ~/Projects.',
      hint: 'mkdir <path>. You can use the full path or cd into Projects first.',
      explanation: '`mkdir` creates directories. Add `-p` to create nested folders in one go.',
      validator: 'mkdirWebsite', setup: 'mkdirWebsite',
    },
    {
      id: 'touch', level: 3, difficulty: 'easy', title: 'Create a File',
      description: 'A website needs a home page. Create an empty page inside the folder you just made.',
      objective: 'Create an empty file named index.html inside ~/Projects/website.',
      hint: 'touch creates empty files. Give it the path ~/Projects/website/index.html or cd there first.',
      explanation: '`touch` creates an empty file, or updates the timestamp if the file already exists.',
      validator: 'touchIndex', setup: 'touchIndex',
    },
    {
      id: 'cp', level: 3, difficulty: 'medium', title: 'Make a Backup',
      description: 'Before editing important notes, make a copy so nothing is lost.',
      objective: 'Copy ~/Documents/notes.txt to a new file named ~/Documents/notes-backup.txt (keep the original).',
      hint: 'cp <source> <destination>. Both paths can be relative to your home directory.',
      explanation: '`cp` copies files. Use `cp -r` to copy whole directories.',
      validator: 'cpNotes', setup: 'cpNotes',
      nudge: 'Both files must exist afterwards: the original notes.txt and the new notes-backup.txt.', nudgeOn: ['cp', 'mv'],
    },
    {
      id: 'mv', level: 3, difficulty: 'medium', title: 'Move It',
      description: 'A draft report is sitting in Downloads, but it belongs in Documents.',
      objective: 'Move ~/Downloads/report-draft.txt into the ~/Documents directory.',
      hint: 'mv <source> <destination-directory>. The file must disappear from Downloads.',
      explanation: '`mv` moves files and also renames them: `mv old.txt new.txt`.',
      validator: 'mvReport', setup: 'mvReport',
      nudge: 'The file should end up in Documents and no longer exist in Downloads. Moving is not copying.', nudgeOn: ['mv', 'cp'],
    },
    {
      id: 'rm', level: 3, difficulty: 'medium', title: 'Take Out the Trash',
      description: 'Downloads contains a temporary file you no longer need. There is no trash can in the terminal, so be precise.',
      objective: 'Delete ~/Downloads/junk.tmp but keep keep-me.txt.',
      hint: 'rm <file> deletes permanently. Name exactly one file — do not use wildcards.',
      explanation: '`rm` removes files without asking. Double-check the name before pressing Enter.',
      validator: 'rmJunk', setup: 'rmJunk',
      nudge: 'keep-me.txt is gone! Use the “Reset files” button in the mission panel and try again.', nudgeOn: ['rm'],
    },
    {
      id: 'rm-r', level: 3, difficulty: 'hard', title: 'Remove a Directory',
      description: 'The old-project folder in Projects is abandoned. Remove it together with everything inside, but leave the other projects alone.',
      objective: 'Delete the ~/Projects/old-project directory and its contents.',
      hint: 'rm refuses directories by default. Add the recursive option: -r.',
      explanation: '`rm -r` deletes a directory and everything in it. Combine with `-f` only when you are very sure.',
      validator: 'rmOldProject', setup: 'rmOldProject',
      nudge: 'Only old-project should go. If you removed too much, press “Reset files” and try again.', nudgeOn: ['rm'],
    },

    /* ---------------------------------------------------------- Level 4 */
    {
      id: 'cat', level: 4, difficulty: 'easy', title: 'Read a File',
      description: 'A welcome message is waiting for you in your Documents folder.',
      objective: 'Display the contents of ~/Documents/welcome.txt.',
      hint: 'cat <file> prints a whole file. Remember that ~ means your home directory.',
      explanation: '`cat` prints files. `cat -n` adds line numbers.',
      validator: 'catWelcome', setup: 'catWelcome',
    },
    {
      id: 'head', level: 4, difficulty: 'medium', title: 'Just the Beginning',
      description: 'Log files can be huge. head shows only the first lines, which is often all you need.',
      objective: 'Show exactly the first 3 lines of /var/log/system.log.',
      hint: 'head accepts the -n option followed by the number of lines to show.',
      explanation: '`head -n N` shows the first N lines (10 by default).',
      validator: 'headLog', setup: 'logFiles',
      nudge: 'Show exactly the first 3 lines of /var/log/system.log (use the -n option).', nudgeOn: ['head'],
    },
    {
      id: 'tail', level: 4, difficulty: 'medium', title: 'The Latest News',
      description: 'New log entries are added at the end of a file, so the most recent events are at the bottom.',
      objective: 'Show exactly the last 2 lines of /var/log/system.log.',
      hint: 'tail works like head, but starting from the end of the file. Try -n 2.',
      explanation: '`tail -n N` shows the last N lines. `tail -n +5` starts from line 5.',
      validator: 'tailLog', setup: 'logFiles',
      nudge: 'Show exactly the last 2 lines of /var/log/system.log (use the -n option).', nudgeOn: ['tail'],
    },
    {
      id: 'pipe-line', level: 4, difficulty: 'hard', title: 'Pick One Line',
      description: 'A pipe (|) sends the output of one command into the next. Combine head and tail to extract a single line from the middle of a file.',
      objective: 'Display only line 5 of /var/log/system.log.',
      hint: 'Take the first 5 lines with head, then pipe them into tail and keep just the last line.',
      explanation: 'Pipes let small tools work together: `head -n 5 file | tail -n 1` prints line 5 only.',
      validator: 'lineFive', setup: 'logFiles',
      nudge: 'Print only line 5. Chain two commands with a pipe: command1 | command2.', nudgeOn: ['head', 'tail', 'cat'],
    },

    /* ---------------------------------------------------------- Level 5 */
    {
      id: 'find', level: 5, difficulty: 'medium', title: 'Hunt for Files',
      description: 'You remember writing some text notes, but not where you put them. Let the computer search.',
      objective: 'Find every .txt file in your home directory (and its subdirectories).',
      hint: 'find <where> -name "<pattern>". The pattern can use * as a wildcard.',
      explanation: '`find` walks a directory tree. Add `-type d` to find directories only.',
      validator: 'findTxt', setup: 'findTxt',
      nudge: 'List only .txt files, searching the whole home directory: find ~ -name "*.txt"', nudgeOn: ['find'],
    },
    {
      id: 'grep', level: 5, difficulty: 'medium', title: 'Search Inside Files',
      description: 'Something went wrong on the server. The system log has the answers, but you only care about errors.',
      objective: 'Show only the ERROR lines of /var/log/system.log.',
      hint: 'grep <pattern> <file> prints the lines that contain the pattern.',
      explanation: '`grep` filters lines by pattern. Use `-i` to ignore case and `-n` to show line numbers.',
      validator: 'grepErrors', setup: 'logFiles',
      nudge: 'Show only the lines that contain ERROR — no other log lines.', nudgeOn: ['grep', 'cat'],
    },
    {
      id: 'grep-r', level: 5, difficulty: 'hard', title: 'Search a Whole Project',
      description: 'Some files in Projects still contain unfinished TODO notes. Find out which ones.',
      objective: 'Search the whole ~/Projects directory recursively for the word TODO.',
      hint: 'grep has a recursive option, -r, that searches directories. Give it the pattern, then the directory.',
      explanation: '`grep -r pattern dir` searches every file below a directory. Add `-n` for line numbers.',
      validator: 'grepRecursive', setup: 'grepProjects',
      nudge: 'Search the Projects directory itself and use the recursive option (-r).', nudgeOn: ['grep'],
    },
  ];

  /* ======================================================================
     Paths and helpers used by validators / setups
     ====================================================================== */

  const P = {
    projects: HOME + '/Projects',
    website: HOME + '/Projects/website',
    index: HOME + '/Projects/website/index.html',
    notes: HOME + '/Documents/notes.txt',
    notesBackup: HOME + '/Documents/notes-backup.txt',
    docsReport: HOME + '/Documents/report-draft.txt',
    dlReport: HOME + '/Downloads/report-draft.txt',
    junk: HOME + '/Downloads/junk.tmp',
    keep: HOME + '/Downloads/keep-me.txt',
    oldProject: HOME + '/Projects/old-project',
    webapp: HOME + '/Projects/webapp',
    welcome: HOME + '/Documents/welcome.txt',
    systemLog: '/var/log/system.log',
  };

  /** Lines of text without the trailing newline. */
  const toLines = (text) => (text ? (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n') : []);

  const readFile = (fs, path) => {
    const node = fs.getNode(path);
    return node && node.type === 'file' ? node.content : null;
  };

  /** For each log line: is it present in `out`? Must equal whether it is wanted. */
  function selectsExactly(out, lines, wantedIndexes) {
    return lines.every((line, index) => out.includes(line) === wantedIndexes.has(index));
  }

  /** All files below `dir` as { path, content }. */
  function filesUnder(fs, dir) {
    const files = [];
    if (!fs.isDir(dir)) return files;
    fs.walk(dir, (path, node) => { if (node.type === 'file') files.push({ path, content: node.content }); });
    return files;
  }

  const VALIDATORS = {
    pwdOutput: ({ last, cwd }) => last.name === 'pwd' && last.code === 0 && last.out.trim() === cwd,
    whoamiOutput: ({ last }) => last.name === 'whoami' && last.code === 0 && last.out.trim() === TQ.ENV.USER,
    hostnameOutput: ({ last }) => last.name === 'hostname' && last.code === 0 && last.out.trim() === TQ.ENV.HOST,
    clearRan: ({ last }) => last.cleared === true && last.code === 0,
    helpRan: ({ last }) => last.name === 'help' && last.code === 0 && last.out.includes('pwd') && last.out.includes('grep'),

    lsHome: ({ last }) => last.name === 'ls' && last.code === 0
      && ['Documents', 'Downloads', 'Projects'].every((name) => last.out.includes(name)),
    cdProjects: ({ cwd }) => cwd === P.projects,
    cdVarLog: ({ cwd }) => cwd === '/var/log',
    treeHome: ({ last }) => last.name === 'tree' && last.code === 0
      && ['Documents', 'Downloads', 'Projects'].every((name) => last.out.includes(name)),

    mkdirWebsite: ({ fs }) => fs.isDir(P.website),
    touchIndex: ({ fs }) => fs.isFile(P.index),
    cpNotes: ({ fs }) => {
      const original = readFile(fs, P.notes);
      const copy = readFile(fs, P.notesBackup);
      return original !== null && copy !== null && original.length > 0 && original === copy;
    },
    mvReport: ({ fs }) => readFile(fs, P.docsReport) === TQ.SEED_FILES[P.dlReport] && !fs.exists(P.dlReport),
    rmJunk: ({ fs }) => !fs.exists(P.junk) && fs.isFile(P.keep),
    rmOldProject: ({ fs }) => !fs.exists(P.oldProject) && fs.isDir(P.projects) && fs.isFile(P.webapp + '/app.js'),

    catWelcome: ({ fs, last }) => {
      const content = readFile(fs, P.welcome);
      if (content === null || !last.names.includes('cat') || last.code !== 0) return false;
      return toLines(content).filter((line) => line.trim() !== '').every((line) => last.out.includes(line));
    },
    headLog: ({ fs, last }) => {
      const lines = toLines(readFile(fs, P.systemLog));
      return last.name === 'head' && last.code === 0 && selectsExactly(last.out, lines, new Set([0, 1, 2]));
    },
    tailLog: ({ fs, last }) => {
      const lines = toLines(readFile(fs, P.systemLog));
      return last.name === 'tail' && last.code === 0 && selectsExactly(last.out, lines, new Set([lines.length - 2, lines.length - 1]));
    },
    lineFive: ({ fs, last }) => {
      const lines = toLines(readFile(fs, P.systemLog));
      return last.names.length >= 2 && last.code === 0 && last.out.trim() === lines[4];
    },

    findTxt: ({ fs, last }) => {
      if (last.name !== 'find' || last.code !== 0) return false;
      const found = toLines(last.out);
      const expected = filesUnder(fs, HOME).map((f) => f.path.slice(HOME.length + 1)).filter((p) => p.endsWith('.txt'));
      return found.length > 0
        && found.every((line) => line.endsWith('.txt'))
        && expected.every((rel) => found.some((line) => line.endsWith(rel)));
    },
    grepErrors: ({ fs, last }) => {
      if (last.name !== 'grep' || last.code !== 0) return false;
      const lines = toLines(readFile(fs, P.systemLog));
      const wanted = new Set();
      lines.forEach((line, index) => { if (line.includes('ERROR')) wanted.add(index); });
      return selectsExactly(last.out, lines, wanted);
    },
    grepRecursive: ({ fs, last }) => {
      if (!last.names.includes('grep') || last.code !== 0) return false;
      const files = filesUnder(fs, P.projects).map((f) => ({ rel: f.path.slice(P.projects.length + 1), has: f.content.includes('TODO') }));
      const matching = files.filter((f) => f.has);
      return matching.length > 0
        && matching.every((f) => last.out.includes(f.rel))
        && files.filter((f) => !f.has).every((f) => !last.out.includes(f.rel));
    },
  };

  /* ======================================================================
     Setups: put the filesystem into the starting state for a mission.
     They are idempotent and only touch files the mission is about.
     ====================================================================== */

  const fixtures = (env) => ({
    goHome() { env.shell.cwd = HOME; },
    dir(path) { env.fs.mkdir(path, { parents: true }); },
    file(path) { env.fs.ensureFile(path, TQ.SEED_FILES[path] || ''); },
    remove(path) { if (env.fs.exists(path)) env.fs.remove(path, { recursive: true }); },
    /** Restore every seed file below a directory. */
    restoreTree(prefix) {
      Object.keys(TQ.SEED_FILES).filter((p) => p.startsWith(prefix)).forEach((p) => env.fs.ensureFile(p, TQ.SEED_FILES[p]));
    },
  });

  const SETUPS = {
    home: (fx) => fx.goHome(),
    mkdirWebsite: (fx) => { fx.goHome(); fx.dir(P.projects); fx.remove(P.website); },
    touchIndex: (fx) => { fx.goHome(); fx.dir(P.website); fx.remove(P.index); },
    cpNotes: (fx) => { fx.goHome(); fx.file(P.notes); fx.remove(P.notesBackup); },
    mvReport: (fx) => { fx.goHome(); fx.file(P.dlReport); fx.remove(P.docsReport); },
    rmJunk: (fx) => { fx.goHome(); fx.file(P.junk); fx.file(P.keep); },
    rmOldProject: (fx) => { fx.goHome(); fx.restoreTree(P.projects); },
    catWelcome: (fx) => { fx.goHome(); fx.file(P.welcome); },
    logFiles: (fx) => { fx.goHome(); fx.file(P.systemLog); },
    findTxt: (fx) => { fx.goHome(); fx.restoreTree(HOME + '/Documents'); },
    grepProjects: (fx) => { fx.goHome(); fx.restoreTree(P.projects); },
  };

  /* ======================================================================
     Public API
     ====================================================================== */

  const byId = (id) => MISSIONS.find((m) => m.id === id) || null;
  const indexOf = (id) => MISSIONS.findIndex((m) => m.id === id);
  const levelOf = (mission) => LEVELS.find((l) => l.id === mission.level);
  const getXp = (mission) => DIFFICULTY_XP[mission.difficulty] || 0;
  const missionsInLevel = (levelId) => MISSIONS.filter((m) => m.level === levelId);

  /** A mission is unlocked when every earlier mission is completed. */
  function isUnlocked(mission, completed) {
    const index = indexOf(mission.id);
    return MISSIONS.slice(0, index).every((m) => Boolean(completed[m.id]));
  }

  function levelStats(levelId, completed) {
    const list = missionsInLevel(levelId);
    return { done: list.filter((m) => completed[m.id]).length, total: list.length };
  }

  function isLevelComplete(levelId, completed) {
    const stats = levelStats(levelId, completed);
    return stats.done === stats.total;
  }

  /** Run the mission validator. Returns { complete, nudge }. */
  function evaluate(mission, ctx) {
    const validate = VALIDATORS[mission.validator];
    let complete = false;
    try {
      complete = Boolean(validate && validate(ctx));
    } catch (error) {
      console.error('Mission validator failed:', mission.id, error);
    }
    if (complete) return { complete: true, nudge: null };
    const related = mission.nudge && ctx.last && ctx.last.names.some((n) => (mission.nudgeOn || []).includes(n));
    return { complete: false, nudge: related ? mission.nudge : null };
  }

  /** Prepare the filesystem for a mission. env = { fs, shell }. */
  function runSetup(mission, env) {
    const setup = SETUPS[mission.setup];
    if (setup) setup(fixtures(env));
  }

  TQ.Missions = {
    LEVELS, MISSIONS, DIFFICULTY_XP,
    byId, indexOf, levelOf, getXp, missionsInLevel,
    isUnlocked, levelStats, isLevelComplete, evaluate, runSetup,
  };
})(typeof window !== 'undefined' ? window : globalThis);
