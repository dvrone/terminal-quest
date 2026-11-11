/**
 * app.js — Application controller.
 *
 * Wires everything together:
 *   filesystem + shell (commands.js)  <->  Terminal UI (terminal.js)
 *   missions (missions.js)            <->  progress store (progress.js)
 *   sound (audio.js)
 * and renders the dashboard, mission panel, mission list, progress and
 * settings views. All dynamic DOM is built with createElement/textContent,
 * never innerHTML, so no user- or file-controlled text can inject markup.
 */
(function (global) {
  'use strict';
  const TQ = global.TQ;
  const { Missions, Sound } = TQ;

  const FS_KEY = 'terminalQuest.fs.v1';
  const VIEWS = ['dashboard', 'terminal', 'missions', 'progress', 'settings'];
  const VIEW_TITLES = { dashboard: 'Dashboard', terminal: 'Terminal', missions: 'Missions', progress: 'Progress', settings: 'Settings' };

  /* ----------------------------------------------------------- DOM helpers */

  /** Tiny element factory: h('div', { class: 'x', text: 'hi', onClick: fn }, child, ...) */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    Object.keys(props || {}).forEach((key) => {
      const value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else el.setAttribute(key, value === true ? '' : value);
    });
    children.flat().forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      el.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return el;
  }

  /** Render text containing `code` spans into a fragment (still textContent-safe). */
  function rich(text) {
    const fragment = document.createDocumentFragment();
    text.split('`').forEach((part, index) => {
      if (index % 2 === 1) fragment.append(h('code', { text: part }));
      else if (part) fragment.append(document.createTextNode(part));
    });
    return fragment;
  }

  const bar = (percent, small) => h('div', { class: 'bar' + (small ? ' bar--sm' : ''), role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(percent) },
    h('span', { style: `width:${Math.max(0, Math.min(100, percent))}%` }));
  const chip = (text, modifier) => h('span', { class: 'chip' + (modifier ? ' chip--' + modifier : ''), text });
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ------------------------------------------------------------------- App */

  class App {
    constructor() {
      this.store = new TQ.ProgressStore();
      this.store.load();
      this.view = 'dashboard';
      this.missionPanelCollapsed = false;

      const saved = this._loadFilesystem();
      this.fs = saved.fs;
      this.shell = new TQ.Shell(this.fs, saved.shellState);
    }

    /* ----------------------------------------------------------- init */

    init() {
      const $ = (id) => document.getElementById(id);
      this.dom = {
        sidebarSummary: $('sidebar-summary'), dashStats: $('dash-stats'), dashLevel: $('dash-level'),
        dashMission: $('dash-mission'), dashAchievements: $('dash-achievements'),
        missionPanel: $('mission-panel'), missionsList: $('missions-list'),
        progressStats: $('progress-stats'), progressLevels: $('progress-levels'), progressAchievements: $('progress-achievements'),
        settings: $('settings-panel'), toasts: $('toasts'),
      };

      Sound.setEnabled(this.store.state.settings.sound);
      this._applyFontSize();

      this.terminal = new TQ.Terminal({
        body: $('terminal-body'), output: $('terminal-output'), form: $('terminal-form'),
        input: $('terminal-input'), prompt: $('terminal-prompt'), title: $('terminal-title'), clearButton: $('btn-clear'),
      }, {
        getPrompt: () => this.shell.promptParts(),
        onSubmit: (line) => this.handleCommand(line),
        onComplete: (text) => this.shell.complete(text),
      });

      document.querySelectorAll('.nav-item').forEach((button) => {
        button.addEventListener('click', () => this.showView(button.dataset.view));
      });
      global.addEventListener('hashchange', () => {
        const name = global.location.hash.replace('#', '');
        if (VIEWS.includes(name) && name !== this.view) this.showView(name, { updateHash: false });
      });

      // First visit: select the first mission and prepare its files.
      if (!this._currentMission() || !this.store.state.currentMissionId) {
        this.selectMission(Missions.MISSIONS[0].id, { force: true });
      }

      this.renderAll();
      const initial = global.location.hash.replace('#', '');
      this.showView(VIEWS.includes(initial) ? initial : 'dashboard', { updateHash: false });
      this.printBanner();
    }

    printBanner() {
      const t = this.terminal;
      t.print('Terminal Quest — Linux terminal simulator', 'success');
      t.print('Everything here is simulated. Nothing touches your real computer.', 'dim');
      t.print('Type help to list commands, and press Tab to complete names.', 'dim');
      const mission = this._currentMission();
      if (mission && !this.store.isCompleted(mission.id)) t.print(`\nMission: ${mission.title}\n${mission.objective}`, 'info');
    }

    /* ---------------------------------------------------- persistence */

    _loadFilesystem() {
      try {
        const raw = TQ.storage.get(FS_KEY);
        if (raw) {
          const data = JSON.parse(raw);
          return { fs: TQ.VirtualFileSystem.fromJSON(data.tree), shellState: { cwd: data.cwd, oldpwd: data.oldpwd } };
        }
      } catch (error) {
        console.warn('Could not restore saved filesystem, starting fresh.', error);
      }
      return { fs: TQ.VirtualFileSystem.createDefault(), shellState: null };
    }

    _saveFilesystem() {
      const state = this.shell.state();
      TQ.storage.set(FS_KEY, JSON.stringify({ v: 1, cwd: state.cwd, oldpwd: state.oldpwd, tree: this.fs.toJSON() }));
    }

    /* ---------------------------------------------------------- views */

    showView(name, options) {
      if (!VIEWS.includes(name)) return;
      this.view = name;
      document.querySelectorAll('.view').forEach((section) => { section.hidden = section.dataset.view !== name; });
      document.querySelectorAll('.nav-item').forEach((button) => {
        if (button.dataset.view === name) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      document.title = `${VIEW_TITLES[name]} · Terminal Quest`;
      if (!options || options.updateHash !== false) {
        try { global.history.replaceState(null, '', '#' + name); } catch (error) { /* file:// quirks */ }
      }
      if (name === 'terminal') { this.terminal.scrollToBottom(); this.terminal.focus(); }
    }

    /* -------------------------------------------------------- missions */

    _currentMission() {
      const mission = Missions.byId(this.store.state.currentMissionId);
      if (mission && Missions.isUnlocked(mission, this.store.state.completed)) return mission;
      return this._firstIncomplete() || Missions.MISSIONS[Missions.MISSIONS.length - 1];
    }

    _firstIncomplete() {
      return Missions.MISSIONS.find((m) => !this.store.isCompleted(m.id)) || null;
    }

    /** Level the player is currently working on (null when everything is done). */
    _playerLevel() {
      const mission = this._firstIncomplete();
      return mission ? Missions.levelOf(mission) : null;
    }

    /** Make a mission current. Its setup runs when the mission changes (or is forced). */
    selectMission(id, options) {
      const mission = Missions.byId(id);
      if (!mission || !Missions.isUnlocked(mission, this.store.state.completed)) return false;
      const changed = this.store.state.currentMissionId !== id;
      this.store.setCurrentMission(id);
      if ((changed || (options && options.force)) && !this.store.isCompleted(id)) this._activateMission(mission);
      this.renderAll();
      return true;
    }

    _activateMission(mission) {
      Missions.runSetup(mission, { fs: this.fs, shell: this.shell });
      this._saveFilesystem();
      if (this.terminal) this.terminal.updatePrompt();
    }

    nextMission() {
      const current = this._currentMission();
      const next = Missions.MISSIONS[Missions.indexOf(current.id) + 1];
      if (!next || !this.store.isCompleted(current.id)) return;
      this.selectMission(next.id);
      this.terminal.print(`\nMission: ${next.title}\n${next.objective}`, 'info');
      this.terminal.focus();
    }

    resetMissionFiles() {
      const mission = this._currentMission();
      if (this.store.isCompleted(mission.id)) return;
      this._activateMission(mission);
      this.terminal.print('Mission files restored.', 'dim');
      this.terminal.focus();
    }

    revealHint() {
      const mission = this._currentMission();
      this.store.markHint(mission.id);
      this.renderMissionPanel();
      const note = this.dom.missionPanel.querySelector('.note--hint');
      if (note) { note.setAttribute('tabindex', '-1'); note.focus({ preventScroll: true }); }
      this.renderProgress();
    }

    /* --------------------------------------------------------- commands */

    handleCommand(line) {
      const result = this.shell.run(line);
      if (result.empty) return;
      this.store.recordCommand();

      result.outputs.forEach((chunk) => {
        if (chunk.type === 'clear') this.terminal.clear();
        else this.terminal.printOutput(chunk.text, chunk.type === 'err' ? 'err' : 'out');
      });
      this.terminal.updatePrompt();
      this._saveFilesystem();

      const outcome = this._checkMission(result);
      if (!outcome.completed) Sound.play(result.code === 0 ? 'success' : 'error');
      this._announceAchievements(this.store.evaluateAchievements());
      this.renderAll();
    }

    /** Validate the current mission against the real result/state. */
    _checkMission(result) {
      const mission = this._currentMission();
      if (!mission || this.store.isCompleted(mission.id)) return { completed: false };

      const verdict = Missions.evaluate(mission, { fs: this.fs, cwd: this.shell.cwd, home: TQ.ENV.HOME, last: result });
      if (!verdict.complete) {
        if (verdict.nudge) this.terminal.print(verdict.nudge, 'hint');
        return { completed: false };
      }

      const xp = this.store.completeMission(mission); // 0 if it was somehow already completed
      const completedMap = this.store.state.completed;
      const levelDone = Missions.isLevelComplete(mission.level, completedMap);
      const everythingDone = Missions.MISSIONS.every((m) => completedMap[m.id]);

      this.terminal.print(`\n✔ Mission complete: ${mission.title}  (+${xp} XP)`, 'success');
      this.toast({ title: 'Mission complete', message: `${mission.title} · +${xp} XP` });

      if (levelDone) {
        const level = Missions.levelOf(mission);
        const next = Missions.LEVELS.find((l) => l.id === level.id + 1);
        this.terminal.print(`★ Level ${level.id} complete — ${level.title}`, 'success');
        if (next) this.terminal.print(`Level ${next.id} unlocked: ${next.title}`, 'success');
        this.toast({ title: `Level ${level.id} complete`, message: next ? `Level ${next.id} unlocked: ${next.title}` : level.title, kind: 'level' });
        Sound.play('levelUp');
      } else {
        Sound.play('mission');
      }

      if (everythingDone) this.terminal.print('You finished every mission. You are a Terminal Master!', 'success');
      else this.terminal.print('Open “Next mission” in the mission panel when you are ready.', 'dim');
      return { completed: true, levelDone };
    }

    _announceAchievements(unlocked) {
      unlocked.filter((a) => !a.id.startsWith('level-')).forEach((a) => {
        this.toast({ title: 'Achievement unlocked', message: a.title });
      });
    }

    toast({ title, message, kind }) {
      const node = h('div', { class: 'toast' + (kind ? ' toast--' + kind : '') }, h('strong', { text: title }), h('span', { text: message }));
      this.dom.toasts.appendChild(node);
      while (this.dom.toasts.childElementCount > 4) this.dom.toasts.removeChild(this.dom.toasts.firstElementChild);
      global.setTimeout(() => {
        node.classList.add('is-leaving');
        global.setTimeout(() => node.remove(), 300);
      }, 4800);
    }

    /* --------------------------------------------------------- settings */

    _applyFontSize() {
      document.documentElement.dataset.font = this.store.state.settings.fontSize;
    }

    resetFiles() {
      if (!global.confirm('Restore the virtual filesystem to its original state? Your mission progress is kept.')) return;
      this.fs = TQ.VirtualFileSystem.createDefault();
      this.shell.fs = this.fs;
      this.shell.cwd = TQ.ENV.HOME;
      this.shell.oldpwd = TQ.ENV.HOME;
      const mission = this._currentMission();
      if (!this.store.isCompleted(mission.id)) Missions.runSetup(mission, { fs: this.fs, shell: this.shell });
      this._saveFilesystem();
      this.terminal.updatePrompt();
      this.terminal.print('Filesystem reset to its original state.', 'info');
      this.toast({ title: 'Files reset', message: 'The virtual filesystem was restored.' });
    }

    resetAll() {
      if (!global.confirm('Reset ALL progress (XP, missions, achievements) and files? This cannot be undone.')) return;
      this.store.reset();
      this.fs = TQ.VirtualFileSystem.createDefault();
      this.shell.fs = this.fs;
      this.shell.cwd = TQ.ENV.HOME;
      this.shell.oldpwd = TQ.ENV.HOME;
      this.terminal.clear();
      this.terminal.clearHistory();
      this.selectMission(Missions.MISSIONS[0].id, { force: true });
      this.printBanner();
      this.showView('dashboard');
      this.toast({ title: 'Progress reset', message: 'You are back at the first mission.' });
    }

    /* ----------------------------------------------------------- render */

    renderAll() {
      this.renderSidebar();
      this.renderDashboard();
      this.renderMissionPanel();
      this.renderMissionsList();
      this.renderProgress();
      this.renderSettings();
    }

    _levelProgress() {
      const level = this._playerLevel();
      if (!level) return { level: null, done: 1, total: 1, percent: 100 };
      const stats = Missions.levelStats(level.id, this.store.state.completed);
      return { level, done: stats.done, total: stats.total, percent: (stats.done / stats.total) * 100 };
    }

    renderSidebar() {
      const progress = this._levelProgress();
      this.dom.sidebarSummary.replaceChildren(
        h('div', { class: 'row' }, h('span', { text: progress.level ? `Level ${progress.level.id}` : 'Complete' }), h('strong', { text: `${this.store.totalXp()} XP` })),
        bar(progress.percent, true),
      );
    }

    renderDashboard() {
      const { store } = this;
      const progress = this._levelProgress();
      const total = Missions.MISSIONS.length;

      this.dom.dashStats.replaceChildren(
        h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: 'Total XP' }), h('div', { class: 'stat-value', text: String(store.totalXp()) }), h('div', { class: 'stat-sub', text: `of ${store.maxXp()} available` })),
        h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: 'Current level' }), h('div', { class: 'stat-value', text: progress.level ? `Level ${progress.level.id}` : 'Max' }), h('div', { class: 'stat-sub', text: progress.level ? progress.level.title : 'All levels complete' })),
        h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: 'Completed missions' }), h('div', { class: 'stat-value', text: `${store.completedCount()} / ${total}` }), h('div', { class: 'stat-sub', text: `${Math.round((store.completedCount() / total) * 100)}% done` })),
      );

      this.dom.dashLevel.replaceChildren(
        h('div', { class: 'card-title', text: 'Level progress' }),
        h('div', { class: 'level-head' },
          h('h2', { text: progress.level ? `Level ${progress.level.id} — ${progress.level.title}` : 'All levels complete' }),
          h('span', { text: progress.level ? `${progress.done} of ${progress.total} missions` : `${total} of ${total} missions` })),
        bar(progress.percent),
      );

      const mission = this._currentMission();
      const completed = store.isCompleted(mission.id);
      const allDone = !this._firstIncomplete();
      this.dom.dashMission.replaceChildren(
        h('div', { class: 'card-title', text: 'Current mission' }),
        h('div', { class: 'dash-mission' },
          h('h3', { text: allDone ? 'Every mission completed' : mission.title }),
          h('p', { text: allDone ? 'You have finished Terminal Quest. Revisit any mission from the Missions page.' : mission.objective }),
          h('div', { class: 'meta-row' }, chip(capitalize(mission.difficulty), mission.difficulty), chip(`${Missions.getXp(mission)} XP`), completed ? chip('Completed', 'done') : null),
          h('button', { class: 'btn btn--primary', type: 'button', text: allDone ? 'Review missions' : 'Continue in Terminal', onClick: () => this.showView(allDone ? 'missions' : 'terminal') })),
      );

      const recent = store.recentAchievements(4);
      this.dom.dashAchievements.replaceChildren(
        h('div', { class: 'card-title', text: 'Recent achievements' }),
        recent.length
          ? h('ul', { class: 'ach-list' }, recent.map(({ def }) => h('li', { class: 'ach-item' },
            h('span', { class: 'ach-icon', 'aria-hidden': 'true', text: def.icon }),
            h('div', {}, h('strong', { text: def.title }), h('span', { text: def.description })))))
          : h('p', { class: 'empty', text: 'No achievements yet. Complete a mission to earn your first one.' }),
      );
    }

    renderMissionPanel() {
      const { store } = this;
      const mission = this._currentMission();
      const level = Missions.levelOf(mission);
      const completed = store.isCompleted(mission.id);
      const index = Missions.indexOf(mission.id);
      const next = Missions.MISSIONS[index + 1];
      const hintVisible = store.hintUsed(mission.id);

      let nextButton;
      if (next) {
        nextButton = h('button', { class: 'btn btn--primary', type: 'button', text: 'Next mission →', disabled: !completed, onClick: () => this.nextMission() });
      } else {
        nextButton = h('button', { class: 'btn btn--primary', type: 'button', text: 'View progress', disabled: !completed, onClick: () => this.showView('progress') });
      }

      const body = h('div', { class: 'mp-collapsible' },
        h('p', { class: 'mp-desc', text: mission.description }),
        h('div', { class: 'objective' }, h('span', { class: 'label', text: 'Objective' }), h('p', { text: mission.objective })),
        h('div', { class: 'meta-row' }, chip(capitalize(mission.difficulty), mission.difficulty), chip(`${Missions.getXp(mission)} XP`)),
        hintVisible ? h('div', { class: 'note note--hint' }, h('span', { class: 'label', text: 'Hint' }), rich(mission.hint)) : null,
        completed ? h('div', { class: 'note note--learned' }, h('span', { class: 'label', text: 'What you learned' }), rich(mission.explanation)) : null,
        h('div', { class: 'mp-actions' },
          completed ? null : h('button', { class: 'btn', type: 'button', text: hintVisible ? 'Hint shown' : 'Show hint', disabled: hintVisible, onClick: () => this.revealHint() }),
          completed ? null : h('button', { class: 'btn btn--ghost', type: 'button', title: 'Restore the files this mission uses', text: 'Reset files', onClick: () => this.resetMissionFiles() }),
          nextButton),
      );

      const toggle = h('button', {
        class: 'btn btn--ghost btn--sm mission-toggle', type: 'button', 'aria-expanded': String(!this.missionPanelCollapsed),
        text: this.missionPanelCollapsed ? 'Show' : 'Hide',
        onClick: () => { this.missionPanelCollapsed = !this.missionPanelCollapsed; this.renderMissionPanel(); },
      });

      this.dom.missionPanel.classList.toggle('is-collapsed', this.missionPanelCollapsed);
      this.dom.missionPanel.replaceChildren(
        h('div', { class: 'mp-head' },
          h('span', { class: 'eyebrow', text: `Level ${level.id} · ${level.title}` }),
          h('span', { style: 'display:flex;gap:8px;align-items:center' }, completed ? chip('Completed', 'done') : chip('In progress', 'current'), toggle)),
        h('h2', { class: 'mp-title', text: mission.title }),
        body,
      );
    }

    renderMissionsList() {
      const { store } = this;
      const current = this._currentMission();
      const completedMap = store.state.completed;
      const firstIncomplete = this._firstIncomplete();

      this.dom.missionsList.replaceChildren(...Missions.LEVELS.map((level) => {
        const stats = Missions.levelStats(level.id, completedMap);
        const rows = Missions.missionsInLevel(level.id).map((mission) => {
          const unlocked = Missions.isUnlocked(mission, completedMap);
          const done = store.isCompleted(mission.id);
          const isCurrent = mission.id === current.id;
          const number = Missions.indexOf(mission.id) + 1;
          const classes = ['mission-row', done ? 'is-done' : '', isCurrent ? 'is-current' : ''].filter(Boolean).join(' ');
          return h('button', {
            class: classes, type: 'button', disabled: !unlocked,
            title: unlocked ? 'Open this mission in the terminal' : 'Complete the previous mission to unlock',
            onClick: () => { if (this.selectMission(mission.id)) this.showView('terminal'); },
          },
          h('span', { class: 'mr-badge', 'aria-hidden': 'true', text: done ? '✓' : String(number) }),
          h('span', {}, h('div', { class: 'mr-title', text: mission.title }), h('div', { class: 'mr-sub', text: mission.objective })),
          h('span', { class: 'mr-meta' },
            chip(capitalize(mission.difficulty), mission.difficulty), chip(`${Missions.getXp(mission)} XP`),
            done ? chip('Completed', 'done') : (!unlocked ? chip('Locked') : (firstIncomplete && mission.id === firstIncomplete.id ? chip('Up next', 'current') : null))));
        });
        return h('div', { class: 'card' },
          h('div', { class: 'level-block-head' }, h('h2', { text: `Level ${level.id} — ${level.title}` }), h('span', { text: `${stats.done} / ${stats.total} completed` })),
          h('p', { class: 'level-summary', text: level.summary }),
          bar((stats.done / stats.total) * 100, true),
          h('div', { class: 'mission-rows' }, rows));
      }));
    }

    renderProgress() {
      const { store } = this;
      const total = Missions.MISSIONS.length;
      this.dom.progressStats.replaceChildren(
        h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: 'Total XP' }), h('div', { class: 'stat-value', text: String(store.totalXp()) }), h('div', { class: 'stat-sub', text: `of ${store.maxXp()}` })),
        h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: 'Missions completed' }), h('div', { class: 'stat-value', text: `${store.completedCount()} / ${total}` })),
        h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: 'Hints used' }), h('div', { class: 'stat-value', text: String(store.hintsUsedCount()) })),
        h('div', { class: 'stat' }, h('div', { class: 'stat-label', text: 'Commands run' }), h('div', { class: 'stat-value', text: String(store.state.commandsRun) })),
      );

      this.dom.progressLevels.replaceChildren(
        h('div', { class: 'card-title', text: 'Levels' }),
        ...Missions.LEVELS.map((level) => {
          const stats = Missions.levelStats(level.id, store.state.completed);
          return h('div', { class: 'level-line' },
            h('span', { class: 'name', text: `Level ${level.id} — ${level.title}` }),
            bar((stats.done / stats.total) * 100, true),
            h('span', { class: 'count', text: `${stats.done}/${stats.total}` }));
        }),
      );

      const all = TQ.Achievements.all();
      const earned = store.state.achievements;
      this.dom.progressAchievements.replaceChildren(
        h('div', { class: 'card-title', text: `Achievements (${Object.keys(earned).length}/${all.length})` }),
        h('div', { class: 'ach-grid' }, all.map((a) => h('div', { class: 'ach-card' + (earned[a.id] ? '' : ' is-locked') },
          h('span', { class: 'ach-icon', 'aria-hidden': 'true', text: earned[a.id] ? a.icon : '·' }),
          h('div', {}, h('strong', { text: a.title }), h('span', { text: a.description }))))),
      );
    }

    renderSettings() {
      const { settings } = this.store.state;
      const soundSwitch = h('button', {
        class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(settings.sound), 'aria-label': 'Sound effects',
        onClick: () => {
          const enabled = !this.store.state.settings.sound;
          this.store.setSetting('sound', enabled);
          Sound.setEnabled(enabled);
          if (enabled) Sound.play('success');
          this.renderSettings();
        },
      });

      const sizes = [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']];
      const fontControl = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Terminal text size' },
        sizes.map(([value, label]) => h('button', {
          type: 'button', text: label, 'aria-pressed': String(settings.fontSize === value),
          onClick: () => { this.store.setSetting('fontSize', value); this._applyFontSize(); this.renderSettings(); },
        })));

      const shortcuts = h('div', { class: 'shortcuts' },
        h('kbd', { text: 'Enter' }), h('span', { text: 'Run the command' }),
        h('kbd', { text: '↑ / ↓' }), h('span', { text: 'Browse command history' }),
        h('kbd', { text: 'Tab' }), h('span', { text: 'Complete commands and paths (press twice to list options)' }),
        h('kbd', { text: 'Ctrl + L' }), h('span', { text: 'Clear the screen' }),
        h('kbd', { text: 'Ctrl + C' }), h('span', { text: 'Cancel the current line' }));

      this.dom.settings.replaceChildren(
        h('div', { class: 'setting' }, h('div', {}, h('h3', { text: 'Sound effects' }), h('p', { text: 'Short synthesized sounds for commands, missions and level-ups.' })), soundSwitch),
        h('div', { class: 'setting' }, h('div', {}, h('h3', { text: 'Terminal text size' }), h('p', { text: 'Make the terminal text easier to read.' })), fontControl),
        h('div', { class: 'setting' }, h('div', {}, h('h3', { text: 'Reset virtual files' }), h('p', { text: 'Restore the simulated filesystem. Your XP and missions are kept.' })), h('button', { class: 'btn', type: 'button', text: 'Reset files', onClick: () => this.resetFiles() })),
        h('div', { class: 'setting' }, h('div', {}, h('h3', { text: 'Reset all progress' }), h('p', { text: 'Erase XP, completed missions, achievements and files.' })), h('button', { class: 'btn btn--danger', type: 'button', text: 'Reset progress', onClick: () => this.resetAll() })),
        h('div', { class: 'setting', style: 'align-items:flex-start;flex-direction:column' }, h('div', {}, h('h3', { text: 'Keyboard shortcuts' })), shortcuts),
      );
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
    TQ.app = app; // handy for debugging in the browser console
  });
})(window);
