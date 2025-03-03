/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { SelectorEngine, SelectorRoot } from './selectorEngine';
import { XPathEngine } from './xpathSelectorEngine';
import { ReactEngine } from './reactSelectorEngine';
import { VueEngine } from './vueSelectorEngine';
import { ParsedSelector, ParsedSelectorPart, parseSelector } from '../common/selectorParser';
import { SelectorEvaluatorImpl, isVisible, parentElementOrShadowHost, elementMatchesText, TextMatcher, createRegexTextMatcher, createStrictTextMatcher, createLaxTextMatcher } from './selectorEvaluator';
import { CSSComplexSelectorList } from '../common/cssParser';
import { generateSelector } from './selectorGenerator';
import type * as channels from '../../protocol/channels';

type Predicate<T> = (progress: InjectedScriptProgress, continuePolling: symbol) => T | symbol;

export type InjectedScriptProgress = {
  injectedScript: InjectedScript;
  aborted: boolean;
  log: (message: string) => void;
  logRepeating: (message: string) => void;
  setIntermediateResult: (intermediateResult: any) => void;
};

export type LogEntry = {
  message?: string;
  intermediateResult?: string;
};

export type FrameExpectParams = Omit<channels.FrameExpectParams, 'expectedValue'> & { expectedValue?: any };

export type InjectedScriptPoll<T> = {
  run: () => Promise<T>,
  // Takes more logs, waiting until at least one message is available.
  takeNextLogs: () => Promise<LogEntry[]>,
  // Takes all current logs without waiting.
  takeLastLogs: () => LogEntry[],
  cancel: () => void,
};

export type ElementStateWithoutStable = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'editable' | 'checked';
export type ElementState = ElementStateWithoutStable | 'stable';

export interface SelectorEngineV2 {
  queryAll(root: SelectorRoot, body: any): Element[];
}

export type ElementMatch = {
  element: Element;
  capture: Element | undefined;
};

export class InjectedScript {
  private _engines: Map<string, SelectorEngineV2>;
  _evaluator: SelectorEvaluatorImpl;
  private _stableRafCount: number;
  private _replaceRafWithTimeout: boolean;
  private _browserName: string;

  constructor(stableRafCount: number, replaceRafWithTimeout: boolean, browserName: string, customEngines: { name: string, engine: SelectorEngine}[]) {
    this._evaluator = new SelectorEvaluatorImpl(new Map());

    this._engines = new Map();
    this._engines.set('xpath', XPathEngine);
    this._engines.set('xpath:light', XPathEngine);
    this._engines.set('_react', ReactEngine);
    this._engines.set('_vue', VueEngine);
    this._engines.set('text', this._createTextEngine(true));
    this._engines.set('text:light', this._createTextEngine(false));
    this._engines.set('id', this._createAttributeEngine('id', true));
    this._engines.set('id:light', this._createAttributeEngine('id', false));
    this._engines.set('data-testid', this._createAttributeEngine('data-testid', true));
    this._engines.set('data-testid:light', this._createAttributeEngine('data-testid', false));
    this._engines.set('data-test-id', this._createAttributeEngine('data-test-id', true));
    this._engines.set('data-test-id:light', this._createAttributeEngine('data-test-id', false));
    this._engines.set('data-test', this._createAttributeEngine('data-test', true));
    this._engines.set('data-test:light', this._createAttributeEngine('data-test', false));
    this._engines.set('css', this._createCSSEngine());
    this._engines.set('nth', { queryAll: () => [] });
    this._engines.set('visible', { queryAll: () => [] });

    for (const { name, engine } of customEngines)
      this._engines.set(name, engine);

    this._stableRafCount = stableRafCount;
    this._replaceRafWithTimeout = replaceRafWithTimeout;
    this._browserName = browserName;
  }

  eval(expression: string): any {
    return global.eval(expression);
  }

  parseSelector(selector: string): ParsedSelector {
    const result = parseSelector(selector);
    for (const part of result.parts) {
      if (!this._engines.has(part.name))
        throw this.createStacklessError(`Unknown engine "${part.name}" while parsing selector ${selector}`);
    }
    return result;
  }

  querySelector(selector: ParsedSelector, root: Node, strict: boolean): Element | undefined {
    if (!(root as any)['querySelector'])
      throw this.createStacklessError('Node is not queryable.');
    this._evaluator.begin();
    try {
      const result = this._querySelectorRecursively([{ element: root as Element, capture: undefined }], selector, 0, new Map());
      if (strict && result.length > 1)
        throw this.strictModeViolationError(selector, result.map(r => r.element));
      return result[0]?.capture || result[0]?.element;
    } finally {
      this._evaluator.end();
    }
  }

  private _querySelectorRecursively(roots: ElementMatch[], selector: ParsedSelector, index: number, queryCache: Map<Element, Element[][]>): ElementMatch[] {
    if (index === selector.parts.length)
      return roots;

    const part = selector.parts[index];
    if (part.name === 'nth') {
      let filtered: ElementMatch[] = [];
      if (part.body === '0') {
        filtered = roots.slice(0, 1);
      } else if (part.body === '-1') {
        if (roots.length)
          filtered = roots.slice(roots.length - 1);
      } else {
        if (typeof selector.capture === 'number')
          throw this.createStacklessError(`Can't query n-th element in a request with the capture.`);
        const nth = +part.body;
        const set = new Set<Element>();
        for (const root of roots) {
          set.add(root.element);
          if (nth + 1 === set.size)
            filtered = [root];
        }
      }
      return this._querySelectorRecursively(filtered, selector, index + 1, queryCache);
    }

    if (part.name === 'visible') {
      const visible = Boolean(part.body);
      return roots.filter(match => visible === isVisible(match.element));
    }

    const result: ElementMatch[] = [];
    for (const root of roots) {
      const capture = index - 1 === selector.capture ? root.element : root.capture;

      // Do not query engine twice for the same element.
      let queryResults = queryCache.get(root.element);
      if (!queryResults) {
        queryResults = [];
        queryCache.set(root.element, queryResults);
      }
      let all = queryResults[index];
      if (!all) {
        all = this._queryEngineAll(selector.parts[index], root.element);
        queryResults[index] = all;
      }

      for (const element of all) {
        if (!('nodeName' in element))
          throw this.createStacklessError(`Expected a Node but got ${Object.prototype.toString.call(element)}`);
        result.push({ element, capture });
      }
    }
    return this._querySelectorRecursively(result, selector, index + 1, queryCache);
  }

  querySelectorAll(selector: ParsedSelector, root: Node): Element[] {
    if (!(root as any)['querySelectorAll'])
      throw this.createStacklessError('Node is not queryable.');
    this._evaluator.begin();
    try {
      const result = this._querySelectorRecursively([{ element: root as Element, capture: undefined }], selector, 0, new Map());
      const set = new Set<Element>();
      for (const r of result)
        set.add(r.capture || r.element);
      return [...set];
    } finally {
      this._evaluator.end();
    }
  }

  private _queryEngineAll(part: ParsedSelectorPart, root: SelectorRoot): Element[] {
    return this._engines.get(part.name)!.queryAll(root, part.body);
  }

  private _createAttributeEngine(attribute: string, shadow: boolean): SelectorEngine {
    const toCSS = (selector: string): CSSComplexSelectorList => {
      const css = `[${attribute}=${JSON.stringify(selector)}]`;
      return [{ simples: [{ selector: { css, functions: [] }, combinator: '' }] }];
    };
    return {
      queryAll: (root: SelectorRoot, selector: string): Element[] => {
        return this._evaluator.query({ scope: root as Document | Element, pierceShadow: shadow }, toCSS(selector));
      }
    };
  }

  private _createCSSEngine(): SelectorEngineV2 {
    const evaluator = this._evaluator;
    return {
      queryAll(root: SelectorRoot, body: any) {
        return evaluator.query({ scope: root as Document | Element, pierceShadow: true }, body);
      }
    };
  }

  private _createTextEngine(shadow: boolean): SelectorEngine {
    const queryList = (root: SelectorRoot, selector: string): Element[] => {
      const { matcher, kind } = createTextMatcher(selector);
      const result: Element[] = [];
      let lastDidNotMatchSelf: Element | null = null;

      const appendElement = (element: Element) => {
        // TODO: replace contains() with something shadow-dom-aware?
        if (kind === 'lax' && lastDidNotMatchSelf && lastDidNotMatchSelf.contains(element))
          return false;
        const matches = elementMatchesText(this._evaluator, element, matcher);
        if (matches === 'none')
          lastDidNotMatchSelf = element;
        if (matches === 'self' || (matches === 'selfAndChildren' && kind === 'strict'))
          result.push(element);
      };

      if (root.nodeType === Node.ELEMENT_NODE)
        appendElement(root as Element);
      const elements = this._evaluator._queryCSS({ scope: root as Document | Element, pierceShadow: shadow }, '*');
      for (const element of elements)
        appendElement(element);
      return result;
    };

    return {
      queryAll: (root: SelectorRoot, selector: string): Element[] => {
        return queryList(root, selector);
      }
    };
  }

  extend(source: string, params: any): any {
    const constrFunction = global.eval(`
    (() => {
      ${source}
      return pwExport;
    })()`);
    return new constrFunction(this, params);
  }

  isVisible(element: Element): boolean {
    return isVisible(element);
  }

  pollRaf<T>(predicate: Predicate<T>): InjectedScriptPoll<T> {
    return this.poll(predicate, next => requestAnimationFrame(next));
  }

  pollInterval<T>(pollInterval: number, predicate: Predicate<T>): InjectedScriptPoll<T> {
    return this.poll(predicate, next => setTimeout(next, pollInterval));
  }

  pollLogScale<T>(predicate: Predicate<T>): InjectedScriptPoll<T> {
    const pollIntervals = [100, 250, 500];
    let attempts = 0;
    return this.poll(predicate, next => setTimeout(next, pollIntervals[attempts++] || 1000));
  }

  poll<T>(predicate: Predicate<T>, scheduleNext: (next: () => void) => void): InjectedScriptPoll<T> {
    return this._runAbortableTask(progress => {
      let fulfill: (result: T) => void;
      let reject: (error: Error) => void;
      const result = new Promise<T>((f, r) => { fulfill = f; reject = r; });

      const next = () => {
        if (progress.aborted)
          return;
        try {
          const continuePolling = Symbol('continuePolling');
          const success = predicate(progress, continuePolling);
          if (success !== continuePolling)
            fulfill(success as T);
          else
            scheduleNext(next);
        } catch (e) {
          progress.log('  ' + e.message);
          reject(e);
        }
      };

      next();
      return result;
    });
  }

  private _runAbortableTask<T>(task: (progess: InjectedScriptProgress) => Promise<T>): InjectedScriptPoll<T> {
    let unsentLog: LogEntry[] = [];
    let takeNextLogsCallback: ((logs: LogEntry[]) => void) | undefined;
    let taskFinished = false;
    const logReady = () => {
      if (!takeNextLogsCallback)
        return;
      takeNextLogsCallback(unsentLog);
      unsentLog = [];
      takeNextLogsCallback = undefined;
    };

    const takeNextLogs = () => new Promise<LogEntry[]>(fulfill => {
      takeNextLogsCallback = fulfill;
      if (unsentLog.length || taskFinished)
        logReady();
    });

    let lastMessage = '';
    let lastIntermediateResult: any = undefined;
    const progress: InjectedScriptProgress = {
      injectedScript: this,
      aborted: false,
      log: (message: string) => {
        lastMessage = message;
        unsentLog.push({ message });
        logReady();
      },
      logRepeating: (message: string) => {
        if (message !== lastMessage)
          progress.log(message);
      },
      setIntermediateResult: (intermediateResult: any) => {
        if (lastIntermediateResult === intermediateResult)
          return;
        lastIntermediateResult = intermediateResult;
        unsentLog.push({ intermediateResult });
        logReady();
      },
    };

    const run = () => {
      const result = task(progress);

      // After the task has finished, there should be no more logs.
      // Release any pending `takeNextLogs` call, and do not block any future ones.
      // This prevents non-finished protocol evaluation calls and memory leaks.
      result.finally(() => {
        taskFinished = true;
        logReady();
      });

      return result;
    };

    return {
      takeNextLogs,
      run,
      cancel: () => { progress.aborted = true; },
      takeLastLogs: () => unsentLog,
    };
  }

  getElementBorderWidth(node: Node): { left: number; top: number; } {
    if (node.nodeType !== Node.ELEMENT_NODE || !node.ownerDocument || !node.ownerDocument.defaultView)
      return { left: 0, top: 0 };
    const style = node.ownerDocument.defaultView.getComputedStyle(node as Element);
    return { left: parseInt(style.borderLeftWidth || '', 10), top: parseInt(style.borderTopWidth || '', 10) };
  }

  retarget(node: Node, behavior: 'follow-label' | 'no-follow-label'): Element | null {
    let element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    if (!element)
      return null;
    if (!element.matches('input, textarea, select'))
      element = element.closest('button, [role=button], [role=checkbox], [role=radio]') || element;
    if (behavior === 'follow-label') {
      if (!element.matches('input, textarea, button, select, [role=button], [role=checkbox], [role=radio]') &&
          !(element as any).isContentEditable) {
        // Go up to the label that might be connected to the input/textarea.
        element = element.closest('label') || element;
      }
      if (element.nodeName === 'LABEL')
        element = (element as HTMLLabelElement).control || element;
    }
    return element;
  }

  waitForElementStatesAndPerformAction<T>(node: Node, states: ElementState[], force: boolean | undefined,
    callback: (node: Node, progress: InjectedScriptProgress, continuePolling: symbol) => T | symbol): InjectedScriptPoll<T | 'error:notconnected'> {
    let lastRect: { x: number, y: number, width: number, height: number } | undefined;
    let counter = 0;
    let samePositionCounter = 0;
    let lastTime = 0;

    const predicate = (progress: InjectedScriptProgress, continuePolling: symbol) => {
      if (force) {
        progress.log(`    forcing action`);
        return callback(node, progress, continuePolling);
      }

      for (const state of states) {
        if (state !== 'stable') {
          const result = this.elementState(node, state);
          if (typeof result !== 'boolean')
            return result;
          if (!result) {
            progress.logRepeating(`    element is not ${state} - waiting...`);
            return continuePolling;
          }
          continue;
        }

        const element = this.retarget(node, 'no-follow-label');
        if (!element)
          return 'error:notconnected';

        // First raf happens in the same animation frame as evaluation, so it does not produce
        // any client rect difference compared to synchronous call. We skip the synchronous call
        // and only force layout during actual rafs as a small optimisation.
        if (++counter === 1)
          return continuePolling;

        // Drop frames that are shorter than 16ms - WebKit Win bug.
        const time = performance.now();
        if (this._stableRafCount > 1 && time - lastTime < 15)
          return continuePolling;
        lastTime = time;

        const clientRect = element.getBoundingClientRect();
        const rect = { x: clientRect.top, y: clientRect.left, width: clientRect.width, height: clientRect.height };
        const samePosition = lastRect && rect.x === lastRect.x && rect.y === lastRect.y && rect.width === lastRect.width && rect.height === lastRect.height;
        if (samePosition)
          ++samePositionCounter;
        else
          samePositionCounter = 0;
        const isStable = samePositionCounter >= this._stableRafCount;
        const isStableForLogs = isStable || !lastRect;
        lastRect = rect;
        if (!isStableForLogs)
          progress.logRepeating(`    element is not stable - waiting...`);
        if (!isStable)
          return continuePolling;
      }

      return callback(node, progress, continuePolling);
    };

    if (this._replaceRafWithTimeout)
      return this.pollInterval(16, predicate);
    else
      return this.pollRaf(predicate);
  }

  elementState(node: Node, state: ElementStateWithoutStable): boolean | 'error:notconnected' {
    const element = this.retarget(node, ['stable', 'visible', 'hidden'].includes(state) ? 'no-follow-label' : 'follow-label');
    if (!element || !element.isConnected) {
      if (state === 'hidden')
        return true;
      return 'error:notconnected';
    }

    if (state === 'visible')
      return this.isVisible(element);
    if (state === 'hidden')
      return !this.isVisible(element);

    const disabled = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.nodeName) && element.hasAttribute('disabled');
    if (state === 'disabled')
      return disabled;
    if (state === 'enabled')
      return !disabled;

    const editable = !(['INPUT', 'TEXTAREA', 'SELECT'].includes(element.nodeName) && element.hasAttribute('readonly'));
    if (state === 'editable')
      return !disabled && editable;

    if (state === 'checked') {
      if (['checkbox', 'radio'].includes(element.getAttribute('role') || ''))
        return element.getAttribute('aria-checked') === 'true';
      if (element.nodeName !== 'INPUT')
        throw this.createStacklessError('Not a checkbox or radio button');
      if (!['radio', 'checkbox'].includes((element as HTMLInputElement).type.toLowerCase()))
        throw this.createStacklessError('Not a checkbox or radio button');
      return (element as HTMLInputElement).checked;
    }
    throw this.createStacklessError(`Unexpected element state "${state}"`);
  }

  selectOptions(optionsToSelect: (Node | { value?: string, label?: string, index?: number })[],
    node: Node, progress: InjectedScriptProgress, continuePolling: symbol): string[] | 'error:notconnected' | symbol {
    const element = this.retarget(node, 'follow-label');
    if (!element)
      return 'error:notconnected';
    if (element.nodeName.toLowerCase() !== 'select')
      throw this.createStacklessError('Element is not a <select> element');
    const select = element as HTMLSelectElement;
    const options = [...select.options];
    const selectedOptions = [];
    let remainingOptionsToSelect = optionsToSelect.slice();
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      const filter = (optionToSelect: Node | { value?: string, label?: string, index?: number }) => {
        if (optionToSelect instanceof Node)
          return option === optionToSelect;
        let matches = true;
        if (optionToSelect.value !== undefined)
          matches = matches && optionToSelect.value === option.value;
        if (optionToSelect.label !== undefined)
          matches = matches && optionToSelect.label === option.label;
        if (optionToSelect.index !== undefined)
          matches = matches && optionToSelect.index === index;
        return matches;
      };
      if (!remainingOptionsToSelect.some(filter))
        continue;
      selectedOptions.push(option);
      if (select.multiple) {
        remainingOptionsToSelect = remainingOptionsToSelect.filter(o => !filter(o));
      } else {
        remainingOptionsToSelect = [];
        break;
      }
    }
    if (remainingOptionsToSelect.length) {
      progress.logRepeating('    did not find some options - waiting... ');
      return continuePolling;
    }
    select.value = undefined as any;
    selectedOptions.forEach(option => option.selected = true);
    progress.log('    selected specified option(s)');
    select.dispatchEvent(new Event('input', { 'bubbles': true }));
    select.dispatchEvent(new Event('change', { 'bubbles': true }));
    return selectedOptions.map(option => option.value);
  }

  fill(value: string, node: Node, progress: InjectedScriptProgress): 'error:notconnected' | 'needsinput' | 'done' {
    const element = this.retarget(node, 'follow-label');
    if (!element)
      return 'error:notconnected';
    if (element.nodeName.toLowerCase() === 'input') {
      const input = element as HTMLInputElement;
      const type = input.type.toLowerCase();
      const kDateTypes = new Set(['date', 'time', 'datetime', 'datetime-local', 'month', 'week']);
      const kTextInputTypes = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
      if (!kTextInputTypes.has(type) && !kDateTypes.has(type)) {
        progress.log(`    input of type "${type}" cannot be filled`);
        throw this.createStacklessError(`Input of type "${type}" cannot be filled`);
      }
      if (type === 'number') {
        value = value.trim();
        if (isNaN(Number(value)))
          throw this.createStacklessError('Cannot type text into input[type=number]');
      }
      if (kDateTypes.has(type)) {
        value = value.trim();
        input.focus();
        input.value = value;
        if (input.value !== value)
          throw this.createStacklessError('Malformed value');
        element.dispatchEvent(new Event('input', { 'bubbles': true }));
        element.dispatchEvent(new Event('change', { 'bubbles': true }));
        return 'done';  // We have already changed the value, no need to input it.
      }
    } else if (element.nodeName.toLowerCase() === 'textarea') {
      // Nothing to check here.
    } else if (!(element as HTMLElement).isContentEditable) {
      throw this.createStacklessError('Element is not an <input>, <textarea> or [contenteditable] element');
    }
    this.selectText(element);
    return 'needsinput';  // Still need to input the value.
  }

  selectText(node: Node): 'error:notconnected' | 'done' {
    const element = this.retarget(node, 'follow-label');
    if (!element)
      return 'error:notconnected';
    if (element.nodeName.toLowerCase() === 'input') {
      const input = element as HTMLInputElement;
      input.select();
      input.focus();
      return 'done';
    }
    if (element.nodeName.toLowerCase() === 'textarea') {
      const textarea = element as HTMLTextAreaElement;
      textarea.selectionStart = 0;
      textarea.selectionEnd = textarea.value.length;
      textarea.focus();
      return 'done';
    }
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.defaultView!.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    (element as HTMLElement | SVGElement).focus();
    return 'done';
  }

  focusNode(node: Node, resetSelectionIfNotFocused?: boolean): 'error:notconnected' | 'done' {
    if (!node.isConnected)
      return 'error:notconnected';
    if (node.nodeType !== Node.ELEMENT_NODE)
      throw this.createStacklessError('Node is not an element');
    const wasFocused = (node.getRootNode() as (Document | ShadowRoot)).activeElement === node && node.ownerDocument && node.ownerDocument.hasFocus();
    (node as HTMLElement | SVGElement).focus();

    if (resetSelectionIfNotFocused && !wasFocused && node.nodeName.toLowerCase() === 'input') {
      try {
        const input = node as HTMLInputElement;
        input.setSelectionRange(0, 0);
      } catch (e) {
        // Some inputs do not allow selection.
      }
    }
    return 'done';
  }

  setInputFiles(node: Node, payloads: { name: string, mimeType: string, buffer: string }[]) {
    if (node.nodeType !== Node.ELEMENT_NODE)
      return 'Node is not of type HTMLElement';
    const element: Element | undefined = node as Element;
    if (element.nodeName !== 'INPUT')
      return 'Not an <input> element';
    const input = element as HTMLInputElement;
    const type = (input.getAttribute('type') || '').toLowerCase();
    if (type !== 'file')
      return 'Not an input[type=file] element';

    const files = payloads.map(file => {
      const bytes = Uint8Array.from(atob(file.buffer), c => c.charCodeAt(0));
      return new File([bytes], file.name, { type: file.mimeType });
    });
    const dt = new DataTransfer();
    for (const file of files)
      dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { 'bubbles': true }));
    input.dispatchEvent(new Event('change', { 'bubbles': true }));
  }

  checkHitTargetAt(node: Node, point: { x: number, y: number }): 'error:notconnected' | 'done' | { hitTargetDescription: string } {
    let element: Element | null | undefined = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!element || !element.isConnected)
      return 'error:notconnected';
    element = element.closest('button, [role=button]') || element;
    let hitElement = this.deepElementFromPoint(document, point.x, point.y);
    const hitParents: Element[] = [];
    while (hitElement && hitElement !== element) {
      hitParents.push(hitElement);
      hitElement = parentElementOrShadowHost(hitElement);
    }
    if (hitElement === element)
      return 'done';
    const hitTargetDescription = this.previewNode(hitParents[0]);
    // Root is the topmost element in the hitTarget's chain that is not in the
    // element's chain. For example, it might be a dialog element that overlays
    // the target.
    let rootHitTargetDescription: string | undefined;
    while (element) {
      const index = hitParents.indexOf(element);
      if (index !== -1) {
        if (index > 1)
          rootHitTargetDescription = this.previewNode(hitParents[index - 1]);
        break;
      }
      element = parentElementOrShadowHost(element);
    }
    if (rootHitTargetDescription)
      return { hitTargetDescription: `${hitTargetDescription} from ${rootHitTargetDescription} subtree` };
    return { hitTargetDescription };
  }

  dispatchEvent(node: Node, type: string, eventInit: Object) {
    let event;
    eventInit = { bubbles: true, cancelable: true, composed: true, ...eventInit };
    switch (eventType.get(type)) {
      case 'mouse': event = new MouseEvent(type, eventInit); break;
      case 'keyboard': event = new KeyboardEvent(type, eventInit); break;
      case 'touch': event = new TouchEvent(type, eventInit); break;
      case 'pointer': event = new PointerEvent(type, eventInit); break;
      case 'focus': event = new FocusEvent(type, eventInit); break;
      case 'drag': event = new DragEvent(type, eventInit); break;
      default: event = new Event(type, eventInit); break;
    }
    node.dispatchEvent(event);
  }

  deepElementFromPoint(document: Document, x: number, y: number): Element | undefined {
    let container: Document | ShadowRoot | null = document;
    let element: Element | undefined;
    while (container) {
      // elementFromPoint works incorrectly in Chromium (http://crbug.com/1188919),
      // so we use elementsFromPoint instead.
      const elements = (container as Document).elementsFromPoint(x, y);
      const innerElement = elements[0] as Element | undefined;
      if (!innerElement || element === innerElement)
        break;
      element = innerElement;
      container = element.shadowRoot;
    }
    return element;
  }

  previewNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE)
      return oneLine(`#text=${node.nodeValue || ''}`);
    if (node.nodeType !== Node.ELEMENT_NODE)
      return oneLine(`<${node.nodeName.toLowerCase()} />`);
    const element = node as Element;

    const attrs = [];
    for (let i = 0; i < element.attributes.length; i++) {
      const { name, value } = element.attributes[i];
      if (name === 'style')
        continue;
      if (!value && booleanAttributes.has(name))
        attrs.push(` ${name}`);
      else
        attrs.push(` ${name}="${value}"`);
    }
    attrs.sort((a, b) => a.length - b.length);
    let attrText = attrs.join('');
    if (attrText.length > 50)
      attrText = attrText.substring(0, 49) + '\u2026';
    if (autoClosingTags.has(element.nodeName))
      return oneLine(`<${element.nodeName.toLowerCase()}${attrText}/>`);

    const children = element.childNodes;
    let onlyText = false;
    if (children.length <= 5) {
      onlyText = true;
      for (let i = 0; i < children.length; i++)
        onlyText = onlyText && children[i].nodeType === Node.TEXT_NODE;
    }
    let text = onlyText ? (element.textContent || '') : (children.length ? '\u2026' : '');
    if (text.length > 50)
      text = text.substring(0, 49) + '\u2026';
    return oneLine(`<${element.nodeName.toLowerCase()}${attrText}>${text}</${element.nodeName.toLowerCase()}>`);
  }

  strictModeViolationError(selector: ParsedSelector, matches: Element[]): Error {
    const infos = matches.slice(0, 10).map(m => ({
      preview: this.previewNode(m),
      selector: generateSelector(this, m).selector
    }));
    const lines = infos.map((info, i) => `\n    ${i + 1}) ${info.preview} aka playwright.$("${info.selector}")`);
    if (infos.length < matches.length)
      lines.push('\n    ...');
    return this.createStacklessError(`strict mode violation: "${selector.selector}" resolved to ${matches.length} elements:${lines.join('')}\n`);
  }

  createStacklessError(message: string): Error {
    if (this._browserName === 'firefox') {
      const error = new Error('Error: ' + message);
      // Firefox cannot delete the stack, so assign to an empty string.
      error.stack = '';
      return error;
    }
    const error = new Error(message);
    // Chromium/WebKit should delete the stack instead.
    delete error.stack;
    return error;
  }

  expect(progress: InjectedScriptProgress, element: Element, options: FrameExpectParams, elements: Element[], continuePolling: any): { pass: boolean, received?: any } {
    const injected = progress.injectedScript;
    const expression = options.expression;

    {
      // Element state / boolean values.
      let elementState: boolean | 'error:notconnected' | 'error:notcheckbox' | undefined;
      if (expression === 'to.be.checked') {
        elementState = progress.injectedScript.elementState(element, 'checked');
      } else if (expression === 'to.be.disabled') {
        elementState = progress.injectedScript.elementState(element, 'disabled');
      } else if (expression === 'to.be.editable') {
        elementState = progress.injectedScript.elementState(element, 'editable');
      } else if (expression === 'to.be.empty') {
        if (element.nodeName === 'INPUT' || element.nodeName === 'TEXTAREA')
          elementState = !(element as HTMLInputElement).value;
        else
          elementState = !element.textContent?.trim();
      } else if (expression === 'to.be.enabled') {
        elementState = progress.injectedScript.elementState(element, 'enabled');
      } else if (expression === 'to.be.focused') {
        elementState = document.activeElement === element;
      } else if (expression === 'to.be.hidden') {
        elementState = progress.injectedScript.elementState(element, 'hidden');
      } else if (expression === 'to.be.visible') {
        elementState = progress.injectedScript.elementState(element, 'visible');
      }

      if (elementState !== undefined) {
        if (elementState === 'error:notcheckbox')
          throw injected.createStacklessError('Element is not a checkbox');
        if (elementState === 'error:notconnected')
          throw injected.createStacklessError('Element is not connected');
        if (elementState === options.isNot) {
          progress.setIntermediateResult(elementState);
          progress.log(`  unexpected value "${elementState}"`);
          return continuePolling;
        }
        return { pass: !options.isNot };
      }
    }

    {
      // Single number value.
      if (expression === 'to.have.count') {
        const received = elements.length;
        const matches = received === options.expectedNumber;
        if (matches === options.isNot) {
          progress.setIntermediateResult(received);
          progress.log(`  unexpected value "${received}"`);
          return continuePolling;
        }
        return { pass: !options.isNot, received };
      }
    }

    {
      // JS property
      if (expression === 'to.have.property') {
        const received = (element as any)[options.expressionArg];
        const matches = deepEquals(received, options.expectedValue);
        if (matches === options.isNot) {
          progress.setIntermediateResult(received);
          progress.log(`  unexpected value "${received}"`);
          return continuePolling;
        }
        return { received, pass: !options.isNot };
      }
    }

    {
      // Single text value.
      let received: string | undefined;
      if (expression === 'to.have.attribute') {
        received = element.getAttribute(options.expressionArg) || '';
      } else if (expression === 'to.have.class') {
        received = element.className;
      } else if (expression === 'to.have.css') {
        received = (window.getComputedStyle(element) as any)[options.expressionArg];
      } else if (expression === 'to.have.id') {
        received = element.id;
      } else if (expression === 'to.have.text') {
        received = options.useInnerText ? (element as HTMLElement).innerText : element.textContent || '';
      } else if (expression === 'to.have.title') {
        received = document.title;
      } else if (expression === 'to.have.url') {
        received = document.location.href;
      } else if (expression === 'to.have.value') {
        if (element.nodeName !== 'INPUT' && element.nodeName !== 'TEXTAREA' && element.nodeName !== 'SELECT')
          throw this.createStacklessError('Not an input element');
        received = (element as any).value;
      }

      if (received !== undefined && options.expectedText) {
        const matcher = new ExpectedTextMatcher(options.expectedText[0]);
        if (matcher.matches(received) === options.isNot) {
          progress.setIntermediateResult(received);
          progress.log(`  unexpected value "${received}"`);
          return continuePolling;
        }
        return { received, pass: !options.isNot };
      }
    }

    {
      // List of values.
      let received: string[] | undefined;
      if (expression === 'to.have.text.array')
        received = elements.map(e => options.useInnerText ? (e as HTMLElement).innerText : e.textContent || '');
      else if (expression === 'to.have.class.array')
        received = elements.map(e => e.className);

      if (received && options.expectedText) {
        if (received.length !== options.expectedText.length) {
          progress.setIntermediateResult(received);
          return continuePolling;
        }

        const matchers = options.expectedText.map(e => new ExpectedTextMatcher(e));
        for (let i = 0; i < received.length; ++i) {
          if (matchers[i].matches(received[i]) === options.isNot) {
            progress.setIntermediateResult(received);
            return continuePolling;
          }
        }
        return { received, pass: !options.isNot };
      }
    }
    throw this.createStacklessError('Unknown expect matcher: ' + options.expression);
  }
}

const autoClosingTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'MENUITEM', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
const booleanAttributes = new Set(['checked', 'selected', 'disabled', 'readonly', 'multiple']);

function oneLine(s: string): string {
  return s.replace(/\n/g, '↵').replace(/\t/g, '⇆');
}

const eventType = new Map<string, 'mouse'|'keyboard'|'touch'|'pointer'|'focus'|'drag'>([
  ['auxclick', 'mouse'],
  ['click', 'mouse'],
  ['dblclick', 'mouse'],
  ['mousedown','mouse'],
  ['mouseeenter', 'mouse'],
  ['mouseleave', 'mouse'],
  ['mousemove', 'mouse'],
  ['mouseout', 'mouse'],
  ['mouseover', 'mouse'],
  ['mouseup', 'mouse'],
  ['mouseleave', 'mouse'],
  ['mousewheel', 'mouse'],

  ['keydown', 'keyboard'],
  ['keyup', 'keyboard'],
  ['keypress', 'keyboard'],
  ['textInput', 'keyboard'],

  ['touchstart', 'touch'],
  ['touchmove', 'touch'],
  ['touchend', 'touch'],
  ['touchcancel', 'touch'],

  ['pointerover', 'pointer'],
  ['pointerout', 'pointer'],
  ['pointerenter', 'pointer'],
  ['pointerleave', 'pointer'],
  ['pointerdown', 'pointer'],
  ['pointerup', 'pointer'],
  ['pointermove', 'pointer'],
  ['pointercancel', 'pointer'],
  ['gotpointercapture', 'pointer'],
  ['lostpointercapture', 'pointer'],

  ['focus', 'focus'],
  ['blur', 'focus'],

  ['drag', 'drag'],
  ['dragstart', 'drag'],
  ['dragend', 'drag'],
  ['dragover', 'drag'],
  ['dragenter', 'drag'],
  ['dragleave', 'drag'],
  ['dragexit', 'drag'],
  ['drop', 'drag'],
]);

function unescape(s: string): string {
  if (!s.includes('\\'))
    return s;
  const r: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length)
      i++;
    r.push(s[i++]);
  }
  return r.join('');
}

function createTextMatcher(selector: string): { matcher: TextMatcher, kind: 'regex' | 'strict' | 'lax' } {
  if (selector[0] === '/' && selector.lastIndexOf('/') > 0) {
    const lastSlash = selector.lastIndexOf('/');
    const matcher: TextMatcher = createRegexTextMatcher(selector.substring(1, lastSlash), selector.substring(lastSlash + 1));
    return { matcher, kind: 'regex' };
  }
  let strict = false;
  if (selector.length > 1 && selector[0] === '"' && selector[selector.length - 1] === '"') {
    selector = unescape(selector.substring(1, selector.length - 1));
    strict = true;
  }
  if (selector.length > 1 && selector[0] === "'" && selector[selector.length - 1] === "'") {
    selector = unescape(selector.substring(1, selector.length - 1));
    strict = true;
  }
  const matcher = strict ? createStrictTextMatcher(selector) : createLaxTextMatcher(selector);
  return { matcher, kind: strict ? 'strict' : 'lax' };
}

class ExpectedTextMatcher {
  _string: string | undefined;
  private _substring: string | undefined;
  private _regex: RegExp | undefined;
  private _normalizeWhiteSpace: boolean | undefined;

  constructor(expected: channels.ExpectedTextValue) {
    this._normalizeWhiteSpace = expected.normalizeWhiteSpace;
    this._string = expected.matchSubstring ? undefined : this.normalizeWhiteSpace(expected.string);
    this._substring = expected.matchSubstring ? this.normalizeWhiteSpace(expected.string) : undefined;
    this._regex = expected.regexSource ? new RegExp(expected.regexSource, expected.regexFlags) : undefined;
  }

  matches(text: string): boolean {
    if (this._normalizeWhiteSpace && !this._regex)
      text = this.normalizeWhiteSpace(text)!;
    if (this._string !== undefined)
      return text === this._string;
    if (this._substring !== undefined)
      return text.includes(this._substring);
    if (this._regex)
      return !!this._regex.test(text);
    return false;
  }

  private normalizeWhiteSpace(s: string | undefined): string | undefined {
    if (!s)
      return s;
    return this._normalizeWhiteSpace ? s.trim().replace(/\s+/g, ' ') : s;
  }
}

function deepEquals(a: any, b: any): boolean {
  if (a === b)
    return true;

  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a.constructor !== b.constructor)
      return false;

    if (Array.isArray(a)) {
      if (a.length !== b.length)
        return false;
      for (let i = 0; i < a.length; ++i) {
        if (!deepEquals(a[i], b[i]))
          return false;
      }
      return true;
    }

    if (a instanceof RegExp)
      return a.source === b.source && a.flags === b.flags;
    // This covers Date.
    if (a.valueOf !== Object.prototype.valueOf)
      return a.valueOf() === b.valueOf();
    // This covers custom objects.
    if (a.toString !== Object.prototype.toString)
      return a.toString() === b.toString();

    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length)
      return false;

    for (let i = 0; i < keys.length; ++i) {
      if (!b.hasOwnProperty(keys[i]))
        return false;
    }

    for (const key of keys) {
      if (!deepEquals(a[key], b[key]))
        return false;
    }
    return true;
  }

  // NaN
  return isNaN(a) === isNaN(b);
}

export default InjectedScript;
