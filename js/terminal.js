/**
 * terminal.js — Terminal window UI.
 *
 * Responsibilities: rendering output, the prompt, command history, keyboard
 * handling (Enter, Arrow Up/Down, Tab, Ctrl+L, Ctrl+C), auto-scroll.
 * It knows nothing about commands or missions; it talks to the app through
 * three handlers: getPrompt(), onSubmit(line) and onComplete(text).
 *
 * Security: all text is inserted with textContent, never innerHTML, so
 * terminal output can never inject markup.
 */
(function (global) {
  'use strict';
  const TQ = (global.TQ = global.TQ || {});

  const HISTORY_KEY = 'terminalQuest.history.v1';
  const MAX_HISTORY = 200;
  const MAX_LINES = 600;

  const commonPrefix = (words) => words.reduce((prefix, word) => {
    let i = 0;
    while (i < prefix.length && i < word.length && prefix[i] === word[i]) i += 1;
    return prefix.slice(0, i);
  });

  class Terminal {
    /**
     * @param els      { body, output, form, input, prompt, title, clearButton }
     * @param handlers { getPrompt(): {user,host,path}, onSubmit(line), onComplete(text) }
     */
    constructor(els, handlers) {
      this.els = els;
      this.handlers = handlers;
      this.history = this._loadHistory();
      this.historyIndex = this.history.length;
      this.draft = '';
      this.tabState = null;
      this._bind();
      this.updatePrompt();
    }

    /* -------------------------------------------------------------- output */

    /** Append one block of text. kind: out | err | info | success | hint | dim */
    print(text, kind) {
      const line = document.createElement('div');
      line.className = 't-line t-' + (kind || 'out');
      line.textContent = text;
      this.els.output.appendChild(line);
      this._prune();
      this.scrollToBottom();
      return line;
    }

    /** Print command output, dropping the single trailing newline. */
    printOutput(text, kind) {
      if (!text) return;
      this.print(text.replace(/\n$/, ''), kind);
    }

    /** Echo the prompt plus the typed command (as submitted). */
    echo(commandText) {
      const line = document.createElement('div');
      line.className = 't-line';
      line.appendChild(this._promptNode());
      line.appendChild(document.createTextNode(' ' + commandText));
      this.els.output.appendChild(line);
      this._prune();
      this.scrollToBottom();
    }

    clear() {
      this.els.output.replaceChildren();
      this.scrollToBottom();
    }

    scrollToBottom() {
      this.els.body.scrollTop = this.els.body.scrollHeight;
    }

    focus() {
      this.els.input.focus({ preventScroll: true });
    }

    _prune() {
      const output = this.els.output;
      while (output.childElementCount > MAX_LINES) output.removeChild(output.firstElementChild);
    }

    /* -------------------------------------------------------------- prompt */

    _promptNode() {
      const parts = this.handlers.getPrompt();
      const wrap = document.createElement('span');
      const make = (cls, text) => {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        return span;
      };
      wrap.append(make('p-user', `${parts.user}@${parts.host}`), make('p-sign', ':'), make('p-path', parts.path), make('p-sign', '$'));
      return wrap;
    }

    updatePrompt() {
      const parts = this.handlers.getPrompt();
      this.els.prompt.replaceChildren(this._promptNode());
      if (this.els.title) this.els.title.textContent = `${parts.user}@${parts.host}: ${parts.path}`;
    }

    /* ------------------------------------------------------------- history */

    _loadHistory() {
      try {
        const parsed = JSON.parse(TQ.storage.get(HISTORY_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(-MAX_HISTORY) : [];
      } catch (error) {
        return [];
      }
    }

    _saveHistory() { TQ.storage.set(HISTORY_KEY, JSON.stringify(this.history)); }

    clearHistory() {
      this.history = [];
      this.historyIndex = 0;
      TQ.storage.remove(HISTORY_KEY);
    }

    _addHistory(line) {
      if (this.history[this.history.length - 1] !== line) this.history.push(line);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.historyIndex = this.history.length;
      this.draft = '';
      this._saveHistory();
    }

    _stepHistory(direction) {
      if (!this.history.length) return;
      if (this.historyIndex === this.history.length) this.draft = this.els.input.value;
      this.historyIndex = Math.min(this.history.length, Math.max(0, this.historyIndex + direction));
      const value = this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex];
      this.els.input.value = value;
      this.els.input.setSelectionRange(value.length, value.length);
    }

    /* ----------------------------------------------------------- completion */

    _complete() {
      const input = this.els.input;
      const caret = input.selectionStart === null ? input.value.length : input.selectionStart;
      const before = input.value.slice(0, caret);
      const after = input.value.slice(caret);
      const result = this.handlers.onComplete(before);
      if (!result || !result.candidates.length) return;
      const { prefix, word, candidates } = result;

      const apply = (replacement) => {
        input.value = prefix + replacement + after;
        const pos = (prefix + replacement).length;
        input.setSelectionRange(pos, pos);
      };

      if (candidates.length === 1) {
        const only = candidates[0];
        apply(only + (only.endsWith('/') ? '' : ' '));
        return;
      }
      const common = commonPrefix(candidates);
      if (common.length > word.length) { apply(common); return; }

      // Ambiguous: a second Tab lists the options.
      if (this.tabState === before) {
        this.echo(input.value);
        this.print(candidates.map((c) => c.slice(c.lastIndexOf('/', c.length - 2) + 1)).join('  '), 'out');
      } else {
        this.tabState = before;
      }
    }

    /* --------------------------------------------------------------- events */

    _bind() {
      const { form, input, body, clearButton } = this.els;

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const line = input.value;
        input.value = '';
        this.tabState = null;
        this.echo(line);
        if (line.trim()) this._addHistory(line);
        this.handlers.onSubmit(line);
        this.scrollToBottom();
      });

      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') this.tabState = null;
        if (event.key === 'ArrowUp') { event.preventDefault(); this._stepHistory(-1); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); this._stepHistory(1); }
        else if (event.key === 'Tab') { event.preventDefault(); this._complete(); }
        else if (event.ctrlKey && event.key.toLowerCase() === 'l') { event.preventDefault(); this.clear(); }
        else if (event.ctrlKey && event.key.toLowerCase() === 'u') { event.preventDefault(); input.value = ''; }
        else if (event.ctrlKey && event.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) {
          event.preventDefault();
          this.echo(input.value + '^C');
          input.value = '';
          this.historyIndex = this.history.length;
        }
      });

      // Clicking anywhere in the terminal focuses the input (unless selecting text).
      body.addEventListener('click', () => {
        const selection = global.getSelection ? global.getSelection().toString() : '';
        if (!selection) this.focus();
      });

      if (clearButton) {
        clearButton.addEventListener('click', () => { this.clear(); this.focus(); });
      }
    }
  }

  TQ.Terminal = Terminal;
})(typeof window !== 'undefined' ? window : globalThis);
