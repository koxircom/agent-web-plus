import assert from 'node:assert/strict';
import test from 'node:test';
import { getInitialNavigation, withTabOpen } from './initial-navigation.ts';
import { getTabOpen, setTabOpenNewSession } from './tab-session.ts';

test('new-chat links preserve engine with the directory', () => {
  const nav = getInitialNavigation(new URLSearchParams('engine=codex&cwd=%2Fhome%2Fdemo%2FCODEX'));
  assert.equal(nav.engine, 'codex');
  assert.equal(nav.requestedCwd, '/home/demo/CODEX');
});
test('tab composer retains engine and repairs a matching legacy cwd link only', () => {
  const values = new Map();
  const storage = { getItem:k => values.get(k) ?? null, setItem:(k,v) => values.set(k,v), removeItem:k => values.delete(k) };
  setTabOpenNewSession('/remote', storage, 'codex');
  const tab = getTabOpen(storage);
  assert.equal(tab.engine, 'codex');
  assert.equal(withTabOpen(getInitialNavigation(new URLSearchParams('cwd=%2Fremote')), tab).engine, 'codex');
  assert.equal(withTabOpen(getInitialNavigation(new URLSearchParams('cwd=%2Fother')), tab).engine, undefined);
  assert.equal(withTabOpen(getInitialNavigation(new URLSearchParams('engine=pi&cwd=%2Fremote')), tab).engine, 'pi');
});
test('explicit session identity wins over a conflicting engine hint', () => {
  assert.equal(getInitialNavigation(new URLSearchParams('session=codex%3Aone&engine=pi')).engine, 'codex');
  assert.equal(getInitialNavigation(new URLSearchParams('session=pi-one&engine=codex')).engine, 'pi');
});
