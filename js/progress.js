/**
 * progress.js — Persistent player progress.
 *
 * Contains:
 *   TQ.storage      safe localStorage wrapper (falls back to memory if blocked)
 *   TQ.Achievements achievement definitions
 *   TQ.ProgressStore XP, completed missions, hints, achievements, settings
 *
 * XP is always *derived* from the set of completed missions, so it can never
 * be awarded twice or drift out of sync with mission completion.
 */
(function (global) {
  'use strict';
  const TQ = (global.TQ = global.TQ || {});

  /* ---------------------------------------------------------------- storage */

  const memory = new Map();
  let usable = null;

  function storageAvailable() {
    if (usable !== null) return usable;
    try {
      const key = '__tq_probe__';
      global.localStorage.setItem(key, '1');
      global.localStorage.removeItem(key);
      usable = true;
    } catch (error) {
      usable = false;
    }
    return usable;
  }

  TQ.storage = {
    get(key) {
      try {
        if (storageAvailable()) return global.localStorage.getItem(key);
      } catch (error) { /* fall through to memory */ }
      return memory.has(key) ? memory.get(key) : null;
    },
    set(key, value) {
      try {
        if (storageAvailable()) { global.localStorage.setItem(key, value); return true; }
      } catch (error) { /* fall through to memory */ }
      memory.set(key, value);
      return false;
    },
    remove(key) {
      try {
        if (storageAvailable()) global.localStorage.removeItem(key);
      } catch (error) { /* ignore */ }
      memory.delete(key);
    },
  };

  /* ----------------------------------------------------------- achievements */

  /** Built lazily so it always reflects the current mission list. */
  function buildAchievements() {
    const { MISSIONS, LEVELS, getXp } = TQ.Missions;
    const done = (state) => MISSIONS.filter((m) => state.completed[m.id]);
    const xp = (state) => done(state).reduce((sum, m) => sum + getXp(m), 0);

    const list = [
      { id: 'first-steps', icon: '1', title: 'First Steps', description: 'Complete your first mission.', test: (s) => done(s).length >= 1 },
    ];
    LEVELS.forEach((level) => {
      list.push({
        id: 'level-' + level.id, icon: String(level.id), title: `Level ${level.id} Cleared`,
        description: `Complete every mission in Level ${level.id}: ${level.title}.`,
        test: (s) => MISSIONS.filter((m) => m.level === level.id).every((m) => s.completed[m.id]),
      });
    });
    list.push(
      { id: 'self-reliant', icon: '★', title: 'Self-Reliant', description: 'Complete 3 missions without using a hint.', test: (s) => done(s).filter((m) => !s.hintsUsed[m.id]).length >= 3 },
      { id: 'challenger', icon: '▲', title: 'Challenge Accepted', description: 'Complete a Hard mission.', test: (s) => done(s).some((m) => m.difficulty === 'hard') },
      { id: 'xp-250', icon: '◆', title: 'Rising Star', description: 'Earn 250 XP.', test: (s) => xp(s) >= 250 },
      { id: 'xp-500', icon: '◆', title: 'Command Line Pro', description: 'Earn 500 XP.', test: (s) => xp(s) >= 500 },
      { id: 'keyboard-warrior', icon: '⌨', title: 'Keyboard Warrior', description: 'Run 50 commands.', test: (s) => s.commandsRun >= 50 },
      { id: 'terminal-master', icon: '✔', title: 'Terminal Master', description: 'Complete every mission.', test: (s) => done(s).length === MISSIONS.length },
    );
    return list;
  }

  let achievementCache = null;
  TQ.Achievements = {
    all() {
      if (!achievementCache) achievementCache = buildAchievements();
      return achievementCache;
    },
    byId(id) { return this.all().find((a) => a.id === id) || null; },
  };

  /* ------------------------------------------------------------------ store */

  const STORAGE_KEY = 'terminalQuest.progress.v1';
  const FONT_SIZES = ['sm', 'md', 'lg'];

  function defaultState() {
    return {
      version: 1,
      completed: {},       // missionId -> completion timestamp
      hintsUsed: {},       // missionId -> true
      achievements: {},    // achievementId -> unlock timestamp
      currentMissionId: null,
      commandsRun: 0,
      settings: { sound: true, fontSize: 'md' },
    };
  }

  /** Accept only well-formed data from storage; ignore everything else. */
  function sanitize(raw) {
    const state = defaultState();
    if (!raw || typeof raw !== 'object') return state;
    const known = new Set(TQ.Missions.MISSIONS.map((m) => m.id));
    const copyKnown = (source, target, valueOf) => {
      if (!source || typeof source !== 'object') return;
      Object.keys(source).forEach((key) => { if (known.has(key)) target[key] = valueOf(source[key]); });
    };
    copyKnown(raw.completed, state.completed, (v) => Number(v) || Date.now());
    copyKnown(raw.hintsUsed, state.hintsUsed, () => true);

    const achievementIds = new Set(TQ.Achievements.all().map((a) => a.id));
    if (raw.achievements && typeof raw.achievements === 'object') {
      Object.keys(raw.achievements).forEach((id) => {
        if (achievementIds.has(id)) state.achievements[id] = Number(raw.achievements[id]) || Date.now();
      });
    }
    if (typeof raw.currentMissionId === 'string' && known.has(raw.currentMissionId)) state.currentMissionId = raw.currentMissionId;
    if (Number.isFinite(raw.commandsRun) && raw.commandsRun >= 0) state.commandsRun = Math.floor(raw.commandsRun);
    if (raw.settings && typeof raw.settings === 'object') {
      if (typeof raw.settings.sound === 'boolean') state.settings.sound = raw.settings.sound;
      if (FONT_SIZES.includes(raw.settings.fontSize)) state.settings.fontSize = raw.settings.fontSize;
    }
    return state;
  }

  class ProgressStore {
    constructor() { this.state = defaultState(); }

    load() {
      const raw = TQ.storage.get(STORAGE_KEY);
      if (!raw) return;
      try {
        this.state = sanitize(JSON.parse(raw));
      } catch (error) {
        this.state = defaultState();
      }
    }

    save() { TQ.storage.set(STORAGE_KEY, JSON.stringify(this.state)); }

    /** Wipe progress (settings are kept). */
    reset() {
      const settings = this.state.settings;
      this.state = defaultState();
      this.state.settings = settings;
      this.save();
    }

    /* ----- XP and missions ----- */

    totalXp() {
      return TQ.Missions.MISSIONS
        .filter((m) => this.state.completed[m.id])
        .reduce((sum, m) => sum + TQ.Missions.getXp(m), 0);
    }

    maxXp() { return TQ.Missions.MISSIONS.reduce((sum, m) => sum + TQ.Missions.getXp(m), 0); }

    isCompleted(id) { return Boolean(this.state.completed[id]); }
    completedCount() { return Object.keys(this.state.completed).length; }
    hintUsed(id) { return Boolean(this.state.hintsUsed[id]); }
    hintsUsedCount() { return Object.keys(this.state.hintsUsed).length; }

    /** Mark a mission complete. Returns the XP awarded (0 if already completed). */
    completeMission(mission) {
      if (this.state.completed[mission.id]) return 0;
      this.state.completed[mission.id] = Date.now();
      this.save();
      return TQ.Missions.getXp(mission);
    }

    markHint(id) {
      if (this.state.hintsUsed[id]) return;
      this.state.hintsUsed[id] = true;
      this.save();
    }

    setCurrentMission(id) {
      this.state.currentMissionId = id;
      this.save();
    }

    recordCommand() {
      this.state.commandsRun += 1;
      this.save();
    }

    /* ----- achievements ----- */

    /** Unlock every achievement whose condition is now met. Returns the new ones. */
    evaluateAchievements() {
      const unlocked = [];
      TQ.Achievements.all().forEach((achievement) => {
        if (this.state.achievements[achievement.id]) return;
        if (achievement.test(this.state)) {
          this.state.achievements[achievement.id] = Date.now();
          unlocked.push(achievement);
        }
      });
      if (unlocked.length) this.save();
      return unlocked;
    }

    /** Most recently unlocked achievements, newest first. */
    recentAchievements(limit) {
      return Object.keys(this.state.achievements)
        .map((id) => ({ def: TQ.Achievements.byId(id), at: this.state.achievements[id] }))
        .filter((entry) => entry.def)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    }

    /* ----- settings ----- */

    setSetting(key, value) {
      this.state.settings[key] = value;
      this.save();
    }
  }

  TQ.ProgressStore = ProgressStore;
})(typeof window !== 'undefined' ? window : globalThis);
