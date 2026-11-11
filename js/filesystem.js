/**
 * filesystem.js — In-memory virtual Linux filesystem.
 *
 * Nodes are plain objects:
 *   directory: { type: 'dir',  mtime, children: Map<string, node> }
 *   file:      { type: 'file', mtime, content: string }
 *
 * All paths handled here are absolute and normalised. Use `resolve()` to turn
 * user input (relative paths, "~", "..", ".") into an absolute path.
 * Nothing in this file touches the host operating system.
 */
(function (global) {
  'use strict';
  const TQ = (global.TQ = global.TQ || {});

  TQ.ENV = Object.freeze({
    USER: 'player',
    HOST: 'terminal-quest',
    HOME: '/home/player',
  });
  const HOME = TQ.ENV.HOME;

  /** Error carrying a POSIX-style code (ENOENT, EEXIST, ...). */
  class FsError extends Error {
    constructor(code, path) {
      super(code + ': ' + path);
      this.name = 'FsError';
      this.code = code;
      this.path = path;
    }
  }

  /** Human-readable message for an FsError code (matches GNU wording). */
  const FS_MESSAGES = {
    ENOENT: 'No such file or directory',
    ENOTDIR: 'Not a directory',
    EISDIR: 'Is a directory',
    EEXIST: 'File exists',
    ENOTEMPTY: 'Directory not empty',
    EINVAL: 'Invalid argument',
    EPERM: 'Operation not permitted',
    EBUSY: 'Device or resource busy',
  };

  /**
   * Convert a shell glob ("*.txt", "file?", "[abc]x") into an anchored RegExp.
   * Used by shell wildcard expansion and `find -name`.
   */
  function globToRegExp(pattern, caseInsensitive) {
    let re = '^';
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i];
      if (c === '*') {
        re += '.*';
      } else if (c === '?') {
        re += '.';
      } else if (c === '[') {
        const end = pattern.indexOf(']', i + 2);
        if (end === -1) {
          re += '\\[';
        } else {
          let cls = pattern.slice(i + 1, end);
          if (cls[0] === '!') cls = '^' + cls.slice(1);
          re += '[' + cls.replace(/\\/g, '\\\\') + ']';
          i = end;
        }
      } else {
        re += c.replace(/[.+^${}()|\\\]/]/g, '\\$&');
      }
    }
    return new RegExp(re + '$', caseInsensitive ? 'i' : '');
  }

  class VirtualFileSystem {
    constructor() {
      this.root = this._newDir();
    }

    /* ---------------------------------------------------------------- nodes */

    _newDir(mtime) {
      return { type: 'dir', mtime: mtime || Date.now(), children: new Map() };
    }

    _newFile(content, mtime) {
      return { type: 'file', mtime: mtime || Date.now(), content: String(content || '') };
    }

    /* ---------------------------------------------------------------- paths */

    /** Turn user input into a normalised absolute path. */
    resolve(path, cwd) {
      let p = String(path);
      if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
      if (!p.startsWith('/')) p = (cwd || '/') + '/' + p;
      const out = [];
      for (const part of p.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
      }
      return '/' + out.join('/');
    }

    parts(abs) { return abs === '/' ? [] : abs.slice(1).split('/'); }

    dirname(abs) {
      if (abs === '/') return '/';
      const i = abs.lastIndexOf('/');
      return i <= 0 ? '/' : abs.slice(0, i);
    }

    basename(abs) { return abs === '/' ? '/' : abs.slice(abs.lastIndexOf('/') + 1); }

    join(dir, name) { return dir === '/' ? '/' + name : dir + '/' + name; }

    /* -------------------------------------------------------------- lookups */

    /** Return the node at `abs` or throw ENOENT / ENOTDIR. */
    lookup(abs) {
      let node = this.root;
      for (const part of this.parts(abs)) {
        if (node.type !== 'dir') throw new FsError('ENOTDIR', abs);
        node = node.children.get(part);
        if (!node) throw new FsError('ENOENT', abs);
      }
      return node;
    }

    /** Like lookup() but returns null instead of throwing for missing paths. */
    getNode(abs) {
      try {
        return this.lookup(abs);
      } catch (err) {
        if (err instanceof FsError) return null;
        throw err;
      }
    }

    exists(abs) { return this.getNode(abs) !== null; }
    isDir(abs) { const n = this.getNode(abs); return Boolean(n && n.type === 'dir'); }
    isFile(abs) { const n = this.getNode(abs); return Boolean(n && n.type === 'file'); }

    /** Return the parent directory node of `abs` (must exist and be a dir). */
    _parentDir(abs) {
      const parent = this.lookup(this.dirname(abs));
      if (parent.type !== 'dir') throw new FsError('ENOTDIR', abs);
      return parent;
    }

    /** Sorted [name, node] pairs of a directory. */
    list(abs) {
      const node = this.lookup(abs);
      if (node.type !== 'dir') throw new FsError('ENOTDIR', abs);
      return [...node.children.entries()].sort((a, b) => {
        const la = a[0].toLowerCase();
        const lb = b[0].toLowerCase();
        if (la < lb) return -1;
        if (la > lb) return 1;
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
    }

    /** Size in bytes (directories report the conventional 4096). */
    size(node) {
      if (node.type === 'dir') return 4096;
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(node.content).length;
      return node.content.length;
    }

    /** Depth-first, sorted walk. Return false from `visit` to skip a subtree. */
    walk(abs, visit, depth) {
      const level = depth || 0;
      const node = this.lookup(abs);
      if (visit(abs, node, level) === false) return;
      if (node.type === 'dir') {
        for (const [name] of this.list(abs)) this.walk(this.join(abs, name), visit, level + 1);
      }
    }

    /* ------------------------------------------------------------ mutations */

    mkdir(abs, options) {
      const parents = Boolean(options && options.parents);
      if (parents) {
        let node = this.root;
        for (const part of this.parts(abs)) {
          let next = node.children.get(part);
          if (!next) {
            next = this._newDir();
            node.children.set(part, next);
            node.mtime = Date.now();
          } else if (next.type !== 'dir') {
            throw new FsError('ENOTDIR', abs);
          }
          node = next;
        }
        return;
      }
      if (abs === '/') throw new FsError('EEXIST', abs);
      const parent = this._parentDir(abs);
      const name = this.basename(abs);
      if (parent.children.has(name)) throw new FsError('EEXIST', abs);
      parent.children.set(name, this._newDir());
      parent.mtime = Date.now();
    }

    writeFile(abs, content) {
      const parent = this._parentDir(abs);
      const name = this.basename(abs);
      const existing = parent.children.get(name);
      if (existing && existing.type === 'dir') throw new FsError('EISDIR', abs);
      if (existing) {
        existing.content = String(content);
        existing.mtime = Date.now();
      } else {
        parent.children.set(name, this._newFile(content));
        parent.mtime = Date.now();
      }
    }

    /** Create an empty file, or refresh the timestamp of an existing node. */
    touch(abs) {
      const existing = this.getNode(abs);
      if (existing) {
        existing.mtime = Date.now();
      } else {
        this.writeFile(abs, '');
      }
    }

    /** Create missing parents and the file itself. Keeps existing content unless overwrite. */
    ensureFile(abs, content, options) {
      const overwrite = Boolean(options && options.overwrite);
      this.mkdir(this.dirname(abs), { parents: true });
      if (this.isFile(abs) && !overwrite) return;
      this.writeFile(abs, content);
    }

    remove(abs, options) {
      const recursive = Boolean(options && options.recursive);
      if (abs === '/') throw new FsError('EPERM', abs);
      const node = this.lookup(abs);
      if (node.type === 'dir' && !recursive) throw new FsError('EISDIR', abs);
      const parent = this._parentDir(abs);
      parent.children.delete(this.basename(abs));
      parent.mtime = Date.now();
    }

    _clone(node) {
      if (node.type === 'file') return this._newFile(node.content);
      const copy = this._newDir();
      for (const [name, child] of node.children) copy.children.set(name, this._clone(child));
      return copy;
    }

    /** Copy `src` to the exact destination path `dst` (caller resolves dir targets). */
    copy(src, dst) {
      const node = this.lookup(src);
      if (dst === src || dst.startsWith(src + '/')) throw new FsError('EINVAL', dst);
      const parent = this._parentDir(dst);
      const name = this.basename(dst);
      const existing = parent.children.get(name);
      if (existing && existing.type === 'dir' && node.type !== 'dir') throw new FsError('EISDIR', dst);
      if (existing && existing.type !== 'dir' && node.type === 'dir') throw new FsError('ENOTDIR', dst);
      parent.children.set(name, this._clone(node));
      parent.mtime = Date.now();
    }

    /** Move/rename `src` to the exact destination path `dst`. */
    move(src, dst) {
      if (src === '/') throw new FsError('EBUSY', src);
      const node = this.lookup(src);
      if (dst === src) return;
      if (dst.startsWith(src + '/')) throw new FsError('EINVAL', dst);
      const dstParent = this._parentDir(dst);
      const dstName = this.basename(dst);
      const existing = dstParent.children.get(dstName);
      if (existing) {
        if (existing.type === 'dir' && node.type !== 'dir') throw new FsError('EISDIR', dst);
        if (existing.type !== 'dir' && node.type === 'dir') throw new FsError('ENOTDIR', dst);
        if (existing.type === 'dir' && existing.children.size > 0) throw new FsError('ENOTEMPTY', dst);
      }
      const srcParent = this._parentDir(src);
      srcParent.children.delete(this.basename(src));
      srcParent.mtime = Date.now();
      dstParent.children.set(dstName, node);
      dstParent.mtime = Date.now();
    }

    /* ---------------------------------------------------------- persistence */

    toJSON() { return this._ser(this.root); }

    _ser(node) {
      if (node.type === 'file') return { t: 'f', m: node.mtime, c: node.content };
      return { t: 'd', m: node.mtime, c: [...node.children].map(([name, child]) => [name, this._ser(child)]) };
    }

    static _de(obj, depth) {
      if (depth > 64 || !obj || typeof obj !== 'object') throw new Error('Invalid filesystem data');
      const mtime = Number(obj.m) || Date.now();
      if (obj.t === 'f') return { type: 'file', mtime, content: String(obj.c) };
      if (obj.t === 'd' && Array.isArray(obj.c)) {
        const children = new Map();
        for (const entry of obj.c) {
          const [name, child] = entry;
          if (typeof name !== 'string' || name === '' || name.includes('/')) continue;
          children.set(name, VirtualFileSystem._de(child, depth + 1));
        }
        return { type: 'dir', mtime, children };
      }
      throw new Error('Invalid filesystem node');
    }

    /** Rebuild a filesystem from `toJSON()` output. Throws on malformed data. */
    static fromJSON(data) {
      const fs = new VirtualFileSystem();
      const root = VirtualFileSystem._de(data, 0);
      if (root.type !== 'dir') throw new Error('Root must be a directory');
      fs.root = root;
      fs.mkdir(HOME, { parents: true });
      return fs;
    }

    /** A fresh filesystem populated with the starting files. */
    static createDefault() {
      const fs = new VirtualFileSystem();
      ['/home/player/Documents', '/home/player/Downloads', '/home/player/Projects', '/etc', '/var/log', '/tmp']
        .forEach((dir) => fs.mkdir(dir, { parents: true }));
      Object.keys(TQ.SEED_FILES).forEach((path) => fs.ensureFile(path, TQ.SEED_FILES[path]));
      return fs;
    }
  }

  /**
   * Starting files. Missions also use this table to restore their fixtures
   * (see missions.js), so keep paths and contents stable.
   */
  TQ.SEED_FILES = {
    '/etc/hostname': 'terminal-quest\n',
    '/etc/os-release': 'NAME="Quest Linux"\nVERSION="1.0 (Apprentice)"\nID=quest\nPRETTY_NAME="Quest Linux 1.0"\n',
    '/etc/passwd':
      'root:x:0:0:root:/root:/bin/bash\n' +
      'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n' +
      'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n' +
      'player:x:1000:1000:Player:/home/player:/bin/bash\n',
    '/etc/motd': 'Welcome to Quest Linux 1.0. Explore, break things (safely) and learn.\n',

    '/var/log/system.log':
      '2026-11-10 06:00:01 INFO  kernel: Booting Quest Linux 6.1.0\n' +
      '2026-11-10 06:00:03 INFO  systemd: Started network service\n' +
      '2026-11-10 06:00:05 INFO  sshd: Server listening on port 22\n' +
      '2026-11-10 06:01:12 WARN  disk: /dev/vda1 is 78% full\n' +
      '2026-11-10 06:02:47 INFO  cron: Job backup.sh started\n' +
      '2026-11-10 06:02:49 ERROR cron: backup.sh exited with status 1\n' +
      '2026-11-10 06:15:30 INFO  nginx: Reloaded configuration\n' +
      '2026-11-10 06:31:08 ERROR nginx: upstream timed out (110) while reading response\n' +
      '2026-11-10 06:45:22 INFO  sshd: Accepted publickey for player\n' +
      '2026-11-10 07:03:19 WARN  memory: swap usage above 50%\n' +
      '2026-11-10 07:10:55 ERROR sshd: Failed password for invalid user admin\n' +
      '2026-11-10 07:20:00 INFO  systemd: Daily cleanup finished\n',
    '/var/log/auth.log':
      'Nov 10 06:45:22 terminal-quest sshd[611]: Accepted publickey for player from 10.0.2.2\n' +
      'Nov 10 06:45:22 terminal-quest sshd[611]: pam_unix(sshd:session): session opened for user player\n' +
      'Nov 10 07:10:55 terminal-quest sshd[702]: Failed password for invalid user admin from 203.0.113.9\n',
    '/var/log/boot.log': '[  OK  ] Started network service.\n[  OK  ] Reached target Multi-User System.\n',

    '/home/player/.bashrc': "# ~/.bashrc\nalias ll='ls -l'\nexport PS1='\\u@\\h:\\w\\$ '\n",
    '/home/player/.profile': '# ~/.profile\nexport PATH="$HOME/bin:$PATH"\n',

    '/home/player/Documents/welcome.txt':
      'Welcome to Terminal Quest!\n\n' +
      'This is your home directory. Every command you run here\n' +
      'is simulated, so feel free to explore, create and delete.\n\n' +
      'Happy hacking!\n',
    '/home/player/Documents/notes.txt':
      'Linux notes\n-----------\n' +
      '1. Everything is a file.\n' +
      '2. Use pwd when you feel lost.\n' +
      '3. Tab completes names for you.\n' +
      '4. Be careful with rm: there is no trash can.\n',
    '/home/player/Documents/todo.txt': 'Buy coffee\nLearn grep\nPractice the terminal daily\n',

    '/home/player/Downloads/report-draft.txt': 'Quarterly report (draft)\n\nSummary: all systems nominal.\n',
    '/home/player/Downloads/junk.tmp': 'temporary data\n',
    '/home/player/Downloads/keep-me.txt': 'Important: do not delete this file.\n',

    '/home/player/Projects/webapp/app.js':
      '// Simple web app entry point\n' +
      'function start() {\n' +
      '  // TODO: add login page\n' +
      "  console.log('Starting...');\n" +
      '}\n' +
      'start();\n',
    '/home/player/Projects/webapp/README.md': '# Web App\n\nA tiny demo project.\n',
    '/home/player/Projects/scripts/backup.sh':
      '#!/bin/bash\n# TODO: compress the archive before copying\ncp -r ~/Documents /tmp/backup\n',
    '/home/player/Projects/scripts/clean.sh': '#!/bin/bash\nrm -f /tmp/*.tmp\n',
    '/home/player/Projects/old-project/README.md': '# Old Project\n\nAbandoned prototype. Safe to delete.\n',
    '/home/player/Projects/old-project/src/main.c':
      '#include <stdio.h>\n\nint main(void) {\n    printf("hello\\n");\n    return 0;\n}\n',
    '/home/player/Projects/old-project/src/util.c': 'int add(int a, int b) {\n    return a + b;\n}\n',
  };

  TQ.FsError = FsError;
  TQ.FS_MESSAGES = FS_MESSAGES;
  TQ.globToRegExp = globToRegExp;
  TQ.VirtualFileSystem = VirtualFileSystem;
})(typeof window !== 'undefined' ? window : globalThis);
